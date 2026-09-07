let installed = false;
let originalWrite: typeof process.stderr.write | undefined;
let pending = "";
let compactMode = false;

const INTERACTIVE_PROMPTS = [
  "Cloudflare API token required",
  "Allow this ChatGPT connection?",
  "Approve this ChatGPT connection?",
];
const ACTIONABLE = /\b(?:error|failed|failure|rejected|denied|expired|unavailable|invalid|refused|could not|cannot|unable)\b/iu;

export function gatewayLogsAreVerbose(value = process.env.PILINK_TERMINAL_LOGS): boolean {
  return /^(?:1|true|yes|on|verbose|debug)$/iu.test(value?.trim() ?? "");
}

export function installGatewayCompactOutput(): void {
  if (installed) return;
  installed = true;
  if (gatewayLogsAreVerbose()) return;

  compactMode = true;
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
  rawWrite(`${message}\n`);
}

export function writeGatewayCompactBlock(lines: readonly string[]): void {
  rawWrite(`${lines.join("\n")}\n`);
}

export function gatewayCompactOutputEnabled(): boolean {
  return compactMode;
}

function consume(text: string): void {
  pending += text;
  while (true) {
    const newline = pending.indexOf("\n");
    if (newline === -1) break;
    const line = pending.slice(0, newline).replace(/\r$/u, "");
    pending = pending.slice(newline + 1);
    const selected = filterGatewayTerminalLine(line);
    if (selected !== undefined) rawWrite(`${selected}\n`);
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

export function filterGatewayTerminalLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  // Managed edge runtimes are silent in compact mode. Their process-level
  // failures are surfaced by PiLink's own error/exit handlers instead.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/u.test(trimmed)) return undefined;
  if (/^\d{4}\/\d{2}\/\d{2}\s/u.test(trimmed)) return undefined;

  // Hide the ordinary server banner and request/session traces. Operators can
  // restore them with PILINK_TERMINAL_LOGS=verbose.
  if (/^[╔╠╚║]/u.test(trimmed)) return undefined;
  if (trimmed.startsWith("[HTTP]")) return undefined;
  if (trimmed.startsWith("[MCP]")) return ACTIONABLE.test(trimmed) ? cleanActionableLine(trimmed) : undefined;
  if (trimmed.startsWith("[OAuth]")) return ACTIONABLE.test(trimmed) ? cleanActionableLine(trimmed) : undefined;
  if (trimmed.startsWith("[Gateway]")) return ACTIONABLE.test(trimmed) ? cleanActionableLine(trimmed) : undefined;

  // These setup blocks are replaced by one stable footer after the MCP server
  // and local OAuth setup endpoint are actually ready.
  if (trimmed === "=== Cloudflare fixed domain started ===") return undefined;
  if (/^[1-4]\. (?:Your persistent public address|Use this MCP server URL|Keep the Cloudflare Published application route|This URL remains the same)/u.test(trimmed)) return undefined;
  if (trimmed === "=== Cloudflare Quick Tunnel started ===") return undefined;
  if (/^[1-3]\. (?:Keep this terminal open|Use this MCP server URL|Continue with the ChatGPT OAuth setup below)/u.test(trimmed)) return undefined;
  if (trimmed.startsWith("Important: this Quick Tunnel URL changes")) return undefined;
  if (trimmed === "=== Connect ChatGPT ===" || trimmed === "=== First-time ChatGPT setup (safe DCR) ===") return undefined;
  if (/^[1-4]\. (?:In ChatGPT|Set the MCP server URL|Select Authentication|Select Dynamic Client Registration)/u.test(trimmed)) return undefined;
  if (trimmed.startsWith("Waiting for ChatGPT.")) return undefined;
  if (trimmed.startsWith("An OAuth client is already configured.")) return undefined;

  if (trimmed === "Shutting down...") return "PiLink Gateway stopped.";

  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function cleanActionableLine(line: string): string {
  return line.replace(/^\[(?:HTTP|MCP|OAuth|Gateway)\]\s*/u, "");
}
