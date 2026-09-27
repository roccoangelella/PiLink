import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Restore the prior KDE window when PiLink's new Brave window takes focus. Never send keys. */
export function kwinWakeFocusScript(): string {
  return `"use strict";
const previous = workspace.activeWindow;
const initialDesktop = workspace.currentDesktop;
const expiresAt = Date.now() + 5000;
let finished = !previous;
function isBrave(window) {
  if (!window || typeof window.resourceClass !== "string") return false;
  return ["brave-browser", "brave", "brave-browser-beta", "brave-browser-nightly"].includes(window.resourceClass.toLowerCase());
}
workspace.windowAdded.connect(function (window) {
  if (finished || Date.now() >= expiresAt || !isBrave(window) || window === previous) return;
  // Only the newly added Brave window can be restored; another active window
  // means the user has already switched focus and must not be interrupted.
  workspace.windowActivated.connect(function (active) {
    if (finished || Date.now() >= expiresAt || active !== window || workspace.activeWindow !== window) return;
    finished = true;
    if (workspace.currentDesktop === initialDesktop && workspace.stackingOrder.includes(previous)) workspace.activeWindow = previous;
  });
  if (!finished && workspace.activeWindow === window) {
    finished = true;
    if (workspace.currentDesktop === initialDesktop && workspace.stackingOrder.includes(previous)) workspace.activeWindow = previous;
  }
});
`;
}

export interface FocusGuard { close(): Promise<void> }

/** Unsupported/unavailable compositor: do nothing and keep the existing browser behavior. */
export async function prepareKwinWakeFocusGuard(env: NodeJS.ProcessEnv): Promise<FocusGuard | undefined> {
  if (env.XDG_SESSION_TYPE !== "wayland" || !env.XDG_CURRENT_DESKTOP?.split(":").includes("KDE") ||
      env.PI_LLM_GATEWAY_RESTORE_FOCUS === "false") return undefined;
  const qdbus = await findQdbus(env);
  if (!qdbus) return undefined;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-wake-focus-"));
  const script = path.join(directory, "restore.js");
  const plugin = `pilink_wake_focus_${process.pid}_${Date.now()}`;
  try {
    await fs.writeFile(script, kwinWakeFocusScript(), { mode: 0o600 });
    const id = (await call(qdbus, ["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", script, plugin], env)).trim();
    if (!/^[1-9]\d{0,6}$/u.test(id)) throw new Error("Invalid KWin script ID");
    await call(qdbus, ["org.kde.KWin", `/Scripting/Script${id}`, "org.kde.kwin.Script.run"], env);
  } catch {
    await call(qdbus, ["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", plugin], env).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
    return undefined;
  }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      // Brave can return from the CLI before its Wayland window is created.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await call(qdbus, ["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", plugin], env).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function findQdbus(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of [...(env.PATH ?? "").split(path.delimiter), "/usr/bin", "/bin"]) {
    if (!dir) continue;
    const candidate = path.join(dir, "qdbus6");
    try { await fs.access(candidate, 1); return candidate; } catch { /* not installed */ }
  }
  return undefined;
}

function call(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, timeout: 2_000, encoding: "utf8", maxBuffer: 4096 }, (error, output) => {
      if (error) reject(error);
      else resolve(output);
    });
  });
}
