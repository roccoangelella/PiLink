import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

/**
 * Environment variables required for ordinary interactive command execution.
 *
 * This is intentionally an allowlist. The PiLink server process holds OAuth,
 * bootstrap, provider, and hosting credentials that must never become part of
 * an MCP or child-agent shell environment merely because they exist in
 * process.env.
 */
const OPERATIONAL_ENVIRONMENT_VARIABLES = new Set([
  // Executable and user environment (POSIX and Windows).
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

  // Locale and terminal capabilities.
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "WT_SESSION",
  "WT_PROFILE_ID",

  // Temporary/runtime directories and desktop/session integration.
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

  // Windows process and profile environment.
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

  // Windows Subsystem for Linux interoperability.
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "WSLENV",
]);

// Defense in depth for current and future wildcard/allowlist entries. AUTH is
// deliberately not generic here because SSH_AUTH_SOCK is operational and does
// not contain a bearer credential.
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/u;

export function filterExecutionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    const normalizedName = name.toUpperCase();
    if (SENSITIVE_ENVIRONMENT_NAME.test(normalizedName)) continue;
    if (!OPERATIONAL_ENVIRONMENT_VARIABLES.has(normalizedName) && !normalizedName.startsWith("LC_")) {
      continue;
    }
    filtered[name] = value;
  }
  return filtered;
}

/** Spawn hook shared by direct MCP bash and supervised Pi child agents. */
export function sanitizeExecutionSpawnContext(context: BashSpawnContext): BashSpawnContext {
  return {
    ...context,
    env: filterExecutionEnvironment(context.env),
  };
}
