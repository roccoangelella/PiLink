import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isNodeVersionSupported, REQUIRED_NODE_VERSION } from "./security.js";

export type SidecarNodeRuntime =
  | {
      ok: true;
      executable: string;
      version: string;
      source: "configured" | "path" | "known-install" | "extension-host";
    }
  | {
      ok: false;
      version?: string;
      error: string;
    };

interface ResolveSidecarNodeOptions {
  configured?: string;
  processExecutable?: string;
  processVersion?: string;
  home?: string;
  xdgDataHome?: string;
  localAppData?: string;
  detectVersion?: (executable: string) => string;
}

export function resolveSidecarNodeRuntime(options: ResolveSidecarNodeOptions = {}): SidecarNodeRuntime {
  const configured = options.configured?.trim() || "";
  const processExecutable = options.processExecutable || process.execPath;
  const processVersion = options.processVersion || process.version;
  const home = options.home || os.homedir();
  const xdgDataHome = options.xdgDataHome ?? process.env.XDG_DATA_HOME;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const detectVersion = options.detectVersion || detectNodeVersion;

  if (configured) {
    const executable = resolveConfiguredExecutable(configured, home);
    const version = detectVersion(executable);
    if (isNodeVersionSupported(version)) return { ok: true, executable, version, source: "configured" };
    return {
      ok: false,
      ...(version ? { version } : {}),
      error: `The executable configured in vspilink.nodeExecutable uses Node ${version || "not detected"}; VSPiLink requires exactly Node ${REQUIRED_NODE_VERSION}.`,
    };
  }

  const pathVersion = detectVersion("node");
  if (isNodeVersionSupported(pathVersion)) {
    return { ok: true, executable: "node", version: pathVersion, source: "path" };
  }

  // GUI-launched VS Code instances often do not inherit the shell startup
  // files that expose nvm/asdf/mise/Volta. Probe only well-known executable
  // locations for the one version supported by this release, and validate
  // every candidate before selecting it.
  for (const executable of knownNodeCandidates(home, localAppData, xdgDataHome)) {
    const version = detectVersion(executable);
    if (isNodeVersionSupported(version)) {
      return { ok: true, executable, version, source: "known-install" };
    }
  }

  if (isNodeVersionSupported(processVersion)) {
    return {
      ok: true,
      executable: processExecutable,
      version: processVersion,
      source: "extension-host",
    };
  }

  const observed = pathVersion || processVersion || undefined;
  return {
    ok: false,
    ...(observed ? { version: observed } : {}),
    error: `Exactly Node ${REQUIRED_NODE_VERSION} is not available for the VSPiLink helper process. Install it on PATH or set its path in vspilink.nodeExecutable. The extension-host runtime (${processVersion || "not detected"}) remains independent.`,
  };
}

export function knownNodeCandidates(
  home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA,
  xdgDataHome = process.env.XDG_DATA_HOME,
): string[] {
  const binary = process.platform === "win32" ? "node.exe" : "node";
  const managedDataHome = xdgDataHome || path.join(home, ".local", "share");
  return [...new Set([
    path.join(managedDataHome, "vspilink", `node-v${REQUIRED_NODE_VERSION}`, "bin", "node"),
    ...(localAppData
      ? [path.join(localAppData, "VSPiLink", `node-v${REQUIRED_NODE_VERSION}`, "node.exe")]
      : []),
    path.join(home, ".nvm", "versions", "node", `v${REQUIRED_NODE_VERSION}`, "bin", binary),
    path.join(home, ".volta", "bin", binary),
    path.join(home, ".asdf", "installs", "nodejs", REQUIRED_NODE_VERSION, "bin", binary),
    path.join(home, ".local", "share", "mise", "installs", "node", REQUIRED_NODE_VERSION, "bin", binary),
  ])];
}

export function detectNodeVersion(executable: string): string {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  return (result.stdout || result.stderr || "").trim();
}

function resolveConfiguredExecutable(value: string, home: string): string {
  const expanded = value.replace(/^~(?=$|[\\/])/, home);
  if (path.isAbsolute(expanded) || !/[\\/]/.test(expanded)) return expanded;
  return path.resolve(expanded);
}
