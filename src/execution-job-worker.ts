import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface ExecutionJobSpec {
  version: 1;
  command: string;
  cwd: string;
}

interface ExecutionJobResult {
  version: 1;
  exitCode: number | null;
  signal: string | null;
  finishedAt: string;
}

const jobDir = process.argv[2];
if (!jobDir || !path.isAbsolute(jobDir)) process.exit(2);

const specPath = path.join(jobDir, "spec.json");
const resultPath = path.join(jobDir, "result.json");
const stdoutPath = path.join(jobDir, "stdout.log");
const stderrPath = path.join(jobDir, "stderr.log");

let spec: ExecutionJobSpec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as ExecutionJobSpec;
  if (spec.version !== 1 || typeof spec.command !== "string" || typeof spec.cwd !== "string") throw new Error("invalid spec");
  fs.rmSync(specPath, { force: true });
} catch {
  process.exit(3);
}

const stdoutFd = fs.openSync(stdoutPath, "a", 0o600);
const stderrFd = fs.openSync(stderrPath, "a", 0o600);
const shell = process.platform === "win32"
  ? process.env.ComSpec || "cmd.exe"
  : process.env.SHELL || "/bin/bash";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", spec.command]
  : ["-lc", spec.command];

let settled = false;
const finish = (result: ExecutionJobResult) => {
  if (settled) return;
  settled = true;
  try {
    const temp = `${resultPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    fs.renameSync(temp, resultPath);
    try { fs.chmodSync(resultPath, 0o600); } catch {}
  } finally {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
  }
};

let child;
try {
  child = spawn(shell, args, {
    cwd: spec.cwd,
    env: process.env,
    detached: false,
    windowsHide: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
} catch {
  finish({ version: 1, exitCode: null, signal: null, finishedAt: new Date().toISOString() });
  process.exit(4);
}

child.once("error", () => {
  finish({ version: 1, exitCode: null, signal: null, finishedAt: new Date().toISOString() });
  process.exitCode = 4;
});
child.once("close", (exitCode, signal) => {
  finish({
    version: 1,
    exitCode,
    signal: signal ? String(signal) : null,
    finishedAt: new Date().toISOString(),
  });
  process.exitCode = exitCode === 0 ? 0 : 1;
});
