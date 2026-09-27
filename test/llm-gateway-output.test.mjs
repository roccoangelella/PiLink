import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const compactScript = String.raw`
  import { installGatewayCompactOutput, writeGatewayCompactBlock } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  console.error("2026-09-07T10:38:08Z INF noisy cloudflared line");
  console.error("[HTTP] POST /sse → 401 (3ms)");
  console.error("[MCP] New Streamable HTTP session initializing...");
  console.error("[OAuth] Registration request received");
  console.error("[OAuth] Client registered: pi_deadbeef");
  console.error("[Gateway] API key: secret-noise");
  console.error("[MCP] Error handling Streamable HTTP request: useful");
  console.error("[OAuth] Rejected a second authorization request while another local approval was pending.");
  process.stderr.write("Approve this ChatGPT connection? [y/N]: ");
  writeGatewayCompactBlock([
    "PiLink Gateway",
    "  Status        ready",
    "",
    "Connection details",
    "  ChatGPT MCP   https://mcp.example.com/sse",
    "  Local API     http://127.0.0.1:3210/v1",
    "  OAuth setup   pilink gateway connect",
    "  Wake          @PiLink Gateway wake up",
  ]);
`;

const verboseScript = String.raw`
  import { installGatewayCompactOutput, gatewayCompactOutputEnabled } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  console.error("[HTTP] POST /sse → 401 (3ms)");
  console.error("[Gateway] API key: visible-in-verbose-test");
  console.error("compact=" + gatewayCompactOutputEnabled());
`;

test("gateway compact output suppresses routine noise and keeps actionable events ordered", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", compactScript], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /noisy cloudflared/u);
  assert.doesNotMatch(result.stderr, /\[HTTP\]/u);
  assert.doesNotMatch(result.stderr, /New Streamable HTTP session/u);
  assert.doesNotMatch(result.stderr, /Registration request received/u);
  assert.doesNotMatch(result.stderr, /Client registered/u);
  assert.doesNotMatch(result.stderr, /secret-noise/u);
  assert.match(result.stderr, /Error handling Streamable HTTP request: useful/u);
  assert.doesNotMatch(result.stderr, /\[MCP\]/u);
  assert.match(result.stderr, /Rejected a second authorization request/u);
  assert.doesNotMatch(result.stderr, /\[OAuth\]/u);
  assert.match(result.stderr, /Approve this ChatGPT connection\? \[y\/N\]:/u);
  assert.match(result.stderr, /PiLink Gateway/u);
  assert.match(result.stderr, /Connection details/u);
  assert.match(result.stderr, /ChatGPT MCP\s+https:\/\/mcp\.example\.com\/sse/u);
  assert.ok(result.stderr.indexOf("Connection details") < result.stderr.indexOf("ChatGPT MCP"));
  assert.ok(result.stderr.indexOf("ChatGPT MCP") < result.stderr.indexOf("Wake          @PiLink Gateway wake up"));
});

test("ordinary gateway answers echo visibly while the Cloudflare token stays hidden on a TTY", (t) => {
  if (process.platform !== "linux") return t.skip("PTY fixture requires Linux and Python");
  const python = String.raw`
import os,pty,subprocess,select,time
script='import {createInterface} from "node:readline/promises"; import {Writable} from "node:stream"; import {installGatewayCompactOutput,gatewayVisiblePromptOutput} from "./dist/llm-gateway-output.js"; installGatewayCompactOutput(); let r=createInterface({input:process.stdin,output:gatewayVisiblePromptOutput(),terminal:true}); await r.question("ChatGPT connection name: "); r.close(); let muted=false; const hidden=new Writable({write(chunk,enc,cb){if(!muted)process.stderr.write(chunk);cb()}}); r=createInterface({input:process.stdin,output:hidden,terminal:true}); process.stderr.write("Cloudflare API token (input hidden): "); muted=true; await r.question(""); r.close(); process.stderr.write("\\n")'
m,s=pty.openpty();p=subprocess.Popen(['node','--input-type=module','--eval',script],stdin=s,stdout=s,stderr=s,preexec_fn=os.setsid);os.close(s)
out=b'';sent_name=False;sent_token=False;deadline=time.time()+6
while time.time()<deadline and p.poll() is None:
 ready,_,_=select.select([m],[],[],.1)
 if ready:
  try:out+=os.read(m,4096)
  except OSError:break
 if not sent_name and b'ChatGPT connection name' in out:
  os.write(m,b'Visible Answer\r');sent_name=True
 if sent_name and not sent_token and b'Cloudflare API token' in out:
  os.write(m,b'NEVER_ECHO_FAKE_TOKEN\r');sent_token=True
try:p.wait(timeout=2)
except subprocess.TimeoutExpired:p.kill();p.wait()
try:
 while True:out+=os.read(m,4096)
except OSError:pass
os.close(m)
print('exit',p.returncode,'name_sent',sent_name,'secret_sent',sent_token,'visible_answer',b'Visible Answer' in out,'secret_hidden',b'NEVER_ECHO_FAKE_TOKEN' not in out)
raise SystemExit(0 if p.returncode==0 and sent_token and b'Visible Answer' in out and b'NEVER_ECHO_FAKE_TOKEN' not in out else 1)
`;
  const result = spawnSync("python3", ["-c", python], { cwd: process.cwd(), encoding: "utf8", timeout: 12_000 });
  if (result.error?.code === "ENOENT") return t.skip("Python not installed");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("PILINK_TERMINAL_LOGS=verbose restores raw gateway diagnostics", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", verboseScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PILINK_TERMINAL_LOGS: "verbose" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[HTTP\] POST \/sse/u);
  assert.match(result.stderr, /\[Gateway\] API key: visible-in-verbose-test/u);
  assert.match(result.stderr, /compact=false/u);
});

const hostingPromptsScript = String.raw`
  import { installGatewayCompactOutput } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  process.stderr.write("Select hosting [1/2/3]: ");
  process.stderr.write("Fixed Cloudflare hostname (for example mcp.example.com): ");
  process.stderr.write("ChatGPT connection name [PiLink Gateway]: ");
  process.stderr.write("After loading PiLink Wake in your browser, press Enter to check it (or type skip): ");
  console.error("2026-09-26T19:58:44Z INF Tunnel connection noise");
  process.stderr.write("Cloudflare API token: ");
  process.stderr.write("Allow PiLink to request these temporary router mappings? [y/N]: ");
  process.stderr.write("Type DIRECT after completing the router configuration: ");
  process.stderr.write("routine unprompted buffer without newline");
`;

test("gateway compact output preserves interactive hosting and network setup prompts without trailing newlines", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", hostingPromptsScript], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Select hosting \[1\/2\/3\]: /u);
  assert.match(result.stderr, /Fixed Cloudflare hostname \(for example mcp\.example\.com\): /u);
  assert.match(result.stderr, /ChatGPT connection name \[PiLink Gateway\]: /u);
  assert.match(result.stderr, /After loading PiLink Wake in your browser, press Enter to check it \(or type skip\):/u);
  assert.doesNotMatch(result.stderr, /Tunnel connection noise/u);
  assert.match(result.stderr, /Cloudflare API token: /u);
  assert.match(result.stderr, /Allow PiLink to request these temporary router mappings\? \[y\/N\]: /u);
  assert.match(result.stderr, /Type DIRECT after completing the router configuration: /u);
  assert.doesNotMatch(result.stderr, /routine unprompted buffer without newline/u);
});

test("filterGatewayTerminalLine preserves hosting prompts and filters noise", async () => {
  const { filterGatewayTerminalLine } = await import("../dist/llm-gateway-output.js");
  assert.equal(filterGatewayTerminalLine("Select hosting [1/2/3]: "), "Select hosting [1/2/3]: ");
  assert.equal(filterGatewayTerminalLine("Fixed Cloudflare hostname (for example mcp.example.com): "), "Fixed Cloudflare hostname (for example mcp.example.com): ");
  assert.equal(filterGatewayTerminalLine("Cloudflare API token: "), "Cloudflare API token: ");
  assert.equal(filterGatewayTerminalLine("Allow PiLink to request these temporary router mappings? [y/N]: "), "Allow PiLink to request these temporary router mappings? [y/N]: ");
  assert.equal(filterGatewayTerminalLine("Type DIRECT after completing the router configuration: "), "Type DIRECT after completing the router configuration: ");
  assert.equal(filterGatewayTerminalLine("[OAuth] Registration request received"), undefined);
  assert.equal(filterGatewayTerminalLine("[HTTP] GET /health"), undefined);
});
