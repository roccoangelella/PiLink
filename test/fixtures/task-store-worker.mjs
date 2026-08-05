import fs from "node:fs/promises";
import { AgentTaskStore } from "../../dist/tasks.js";

const [workspace, dataDir, agentId, title, readyPath = "", gatePath = ""] = process.argv.slice(2);
if (!workspace || !dataDir || !agentId || !title) {
  throw new Error("Expected workspace, dataDir, agentId, and title arguments");
}

const store = new AgentTaskStore({ workspace, dataDir });
if (readyPath && gatePath) {
  // Populate any process-local state before the synchronized mutation. This
  // makes a stale-cache/lost-update regression deterministic rather than
  // relying on scheduler timing.
  await store.list();
  await fs.writeFile(readyPath, "ready\n", { mode: 0o600 });
  while (true) {
    try {
      await fs.access(gatePath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

const task = await store.create({
  agentId,
  agentName: agentId,
  title,
});
process.stdout.write(`${JSON.stringify(task)}\n`);
