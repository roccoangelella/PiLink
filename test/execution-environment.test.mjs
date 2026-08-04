import assert from "node:assert/strict";
import test from "node:test";

import {
  filterExecutionEnvironment,
  sanitizeExecutionSpawnContext,
} from "../dist/execution-environment.js";

test("execution environment preserves operational POSIX and Windows variables", () => {
  const source = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/tester",
    USER: "tester",
    SHELL: "/bin/bash",
    LANG: "it_IT.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/tmp/tester",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.socket",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    Path: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\tester",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    PSMODULEPATH: "C:\\Program Files\\PowerShell\\Modules",
  };

  assert.deepEqual(filterExecutionEnvironment(source), source);
});

test("execution environment drops server secrets, provider keys, and unrelated variables", () => {
  const filtered = filterExecutionEnvironment({
    PATH: "/usr/bin",
    LC_MESSAGES: "C.UTF-8",
    JWT_SECRET: "jwt-secret",
    PI_BOOTSTRAP_SECRET: "bootstrap-secret",
    PI_AGENT_API_KEY: "agent-key",
    OPENAI_API_KEY: "openai-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    AWS_SECRET_ACCESS_KEY: "aws-key",
    GITHUB_TOKEN: "github-token",
    DATABASE_PASSWORD: "database-password",
    GOOGLE_APPLICATION_CREDENTIALS: "/private/service-account.json",
    LC_SECRET: "must-not-pass-through-the-locale-prefix",
    PROJECT_FLAG: "not-operational",
  });

  assert.deepEqual(filtered, {
    PATH: "/usr/bin",
    LC_MESSAGES: "C.UTF-8",
  });
});

test("execution spawn hook preserves command and cwd while filtering environment", () => {
  const original = {
    command: "printf test",
    cwd: "/tmp/project",
    env: {
      PATH: "/usr/bin",
      JWT_SECRET: "hidden",
      TERM: "xterm",
      TMPDIR: "bad\0value",
    },
  };

  assert.deepEqual(sanitizeExecutionSpawnContext(original), {
    command: original.command,
    cwd: original.cwd,
    env: {
      PATH: "/usr/bin",
      TERM: "xterm",
    },
  });
});
