import type { Writable } from "node:stream";

let installed = false;
let originalWrite: typeof process.stderr.write | undefined;
let pending = "";

const INTERACTIVE_PROMPTS = [
  "Cloudflare API token required",
  "Allow this ChatGPT connection?",
];

export function installGatewayCompactOutput(): void {
  if (installed) return;
  installed = true;
  originalWrite = process.stderr.write.bind(process.stderr);

  const filteredWrite = function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
    consume(text);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.(null);
    return true;
  } as typeof process.stderr.write;

  process.stderr.write = filteredWrite;
}

export function writeGatewayCompactLine(message = ""): void {
  const write = originalWrite ?? process.stderr.write.bind(process.stderr);
  write(`${message}\n`);
}

export function writeGatewayCompactBlock(lines: readonly string[]): void {
  const write = originalWrite ?? process.stderr.write.bind(process.stderr);
  write(`${lines.join("\n")}\n`);
}

function consume(text: string): void {
  pending += text;
  while (true) {
    const newline = pending.indexOf("\n");
    if (newline === -1) break;
    const line = pending.slice(0, newline).replace(/\r$/u, "");
    pending = pending.slice(newline + 1);
    if (!suppress(line)) rawWrite(`${line}\n`);
  }

  if (pending && INTERACTIVE_PROMPTS.some((prompt) => pending.startsWith(prompt))) {
    rawWrite(pending);
    pending = "";
  }
}

function rawWrite(text: string): void {
  const write = originalWrite ?? process.stderr.write.bind(process.stderr);
  write(text);
}

function suppress(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;

  // cloudflared raw diagnostics are deliberately hidden in gateway mode. Its
  // process error/exit handlers still surface actionable failures.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s/u.test(trimmed)) return true;
  if (/^\d{4}\/\d{2}\/\d{2}\s/u.test(trimmed)) return true;

  // Suppress the ordinary server box and routine per-request/session chatter.
  if (/^[╔╠╚║]/u.test(trimmed)) return true;
  if (trimmed.startsWith("[HTTP]")) return true;
  if (trimmed.startsWith("[MCP]") && !/\b(?:error|failed|rejected|unavailable)\b/iu.test(trimmed)) return true;
  if (trimmed === "[OAuth] Registration request received") return true;

  if (trimmed === "=== Cloudflare fixed domain started ===") return true;
  if (/^[1-4]\. (?:Your persistent public address|Use this MCP server URL|Keep the Cloudflare Published application route|This URL remains the same)/u.test(trimmed)) return true;
  if (trimmed === "=== Connect ChatGPT ===" || trimmed === "=== First-time ChatGPT setup (safe DCR) ===") return true;
  if (/^[1-4]\. (?:In ChatGPT|Set the MCP server URL|Select Authentication|Select Dynamic Client Registration)/u.test(trimmed)) return true;
  if (trimmed.startsWith("Waiting for ChatGPT.")) return true;
  if (trimmed.startsWith("An OAuth client is already configured.")) return true;

  if (trimmed.startsWith("[Gateway]")) {
    return /(?:OpenAI-compatible endpoint|Model field|API key|Send the wake command|Repointing the existing Cloudflare|Cloudflare fixed-domain ingress now targets|MCP port .* is unavailable|Saved PORT=)/iu.test(trimmed);
  }

  return false;
}
