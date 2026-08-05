import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bundledChatCliRoot,
  chatCliAutoLaunchEnabled,
  launchChatCli,
  resolveChatCliStatePaths,
} from "../dist/chat-cli.js";

test("chat CLI resolves the canonical private project state files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-chat-cli-paths-"));
  const workspace = path.join(root, "workspace");
  const workspaceAlias = path.join(root, "workspace-alias");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.symlink(workspace, workspaceAlias, "dir");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const canonicalWorkspace = await fs.realpath(workspace);
  const projectKey = crypto.createHash("sha256").update(canonicalWorkspace).digest("hex");
  const paths = resolveChatCliStatePaths(workspaceAlias, dataDir);

  assert.equal(paths.projectKey, projectKey);
  assert.equal(paths.projectDir, path.join(path.resolve(dataDir), "projects", projectKey));
  assert.equal(paths.chatFile, path.join(paths.projectDir, "agent-chat.json"));
  assert.equal(paths.tasksFile, path.join(paths.projectDir, "agent-tasks.json"));
});

test("chat CLI auto-launch requires an interactive terminal and supports opt-out", () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true };
  assert.equal(chatCliAutoLaunchEnabled({}, tty), true);
  assert.equal(chatCliAutoLaunchEnabled({ PI_CHAT_CLI: "off" }, tty), false);
  assert.equal(chatCliAutoLaunchEnabled({ PI_CHAT_CLI: "manual" }, tty), false);
  assert.equal(chatCliAutoLaunchEnabled({ PI_CHAT_CLI: "auto", CI: "true" }, tty), false);
  assert.equal(chatCliAutoLaunchEnabled({}, { ...tty, stdinIsTTY: false }), false);
  assert.throws(() => chatCliAutoLaunchEnabled({ PI_CHAT_CLI: "sometimes" }, tty), /must be 'auto' or 'off'/);
});

test("chat CLI launcher passes canonical files through an inherited terminal", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-chat-cli-launch-"));
  const packageDir = path.join(root, "pilink_chat_cli");
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private-data");
  await fs.mkdir(packageDir);
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(packageDir, "__main__.py"), "# fixture\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let invocation;
  const fakeChild = { once() {}, exitCode: null, killed: false };
  const result = launchChatCli(
    { workspace, dataDir },
    {
      chatCliRoot: root,
      python: "/usr/bin/python3",
      env: { PYTHONPATH: "/existing" },
      spawnProcess(executable, args, options) {
        invocation = { executable, args, options };
        return fakeChild;
      },
    },
  );

  assert.equal(result.child, fakeChild);
  assert.equal(invocation.executable, "/usr/bin/python3");
  assert.deepEqual(invocation.args.slice(0, 2), ["-m", "pilink_chat_cli"]);
  assert.equal(invocation.args[invocation.args.indexOf("--chat-file") + 1], result.paths.chatFile);
  assert.equal(invocation.args[invocation.args.indexOf("--tasks-file") + 1], result.paths.tasksFile);
  assert.ok(invocation.args.includes("--missing-as-empty"));
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.env.PYTHONPATH, `${root}${path.delimiter}/existing`);
});

test("bundled chat CLI source is shipped beside compiled PiLink", async () => {
  const root = bundledChatCliRoot();
  await fs.access(path.join(root, "pilink_chat_cli", "__main__.py"));
  await fs.access(path.join(root, "pilink_chat_cli", "app.tcss"));
});
