import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

/**
 * Environment variables needed for ordinary workspace command execution.
 *
 * Workspace execution is not Full Access. The PiLink server may hold OAuth,
 * provider, hosting, or bootstrap credentials, so those values must not become
 * ambient authority for repository code merely because they exist in
 * process.env.
 */
const WORKSPACE_OPERATIONAL_ENVIRONMENT_VARIABLES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "LOGNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "SHELL",
  "COMSPEC",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "TMP",
  "TEMP",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "OS",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "ALLUSERSPROFILE",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "LOGONSERVER",
  "SESSIONNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PSMODULEPATH",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "WSLENV",
]);

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/u;

/**
 * Full Access deliberately preserves the server process environment. This is
 * part of Full Access semantics: the authorized client receives the PiLink OS
 * user's process authority, including ambient credentials available to that
 * process. NUL-bearing values are omitted because operating systems cannot
 * represent them in a spawned process environment.
 */
export function filterExecutionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

/** Least-privilege environment for repository execution in workspace mode. */
export function filterWorkspaceExecutionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    const normalizedName = name.toUpperCase();
    if (SENSITIVE_ENVIRONMENT_NAME.test(normalizedName)) continue;
    if (!WORKSPACE_OPERATIONAL_ENVIRONMENT_VARIABLES.has(normalizedName) && !normalizedName.startsWith("LC_")) {
      continue;
    }
    filtered[name] = value;
  }
  return filtered;
}

/** Spawn hook for explicit Full Access execution. */
export function sanitizeExecutionSpawnContext(context: BashSpawnContext): BashSpawnContext {
  return {
    ...context,
    env: filterExecutionEnvironment(context.env),
  };
}

/** Spawn hook for repository execution that must not inherit server secrets. */
export function sanitizeWorkspaceExecutionSpawnContext(context: BashSpawnContext): BashSpawnContext {
  return {
    ...context,
    env: filterWorkspaceExecutionEnvironment(context.env),
  };
}
