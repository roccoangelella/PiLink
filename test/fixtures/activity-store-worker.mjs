import fs from "node:fs/promises";
import { AgentActivityStore } from "../../dist/activity.js";

const [workspace, dataDir, mode, label, readyPath = "", gatePath = ""] = process.argv.slice(2);
if (!workspace || !dataDir || !mode || !label) {
  throw new Error("Expected workspace, dataDir, mode, and label arguments");
}

const store = new AgentActivityStore({ workspace, dataDir });
if (readyPath && gatePath) {
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

const event = mode === "idempotent"
  ? await store.append({
      source: "server",
      actor: { agentId: "server-task-store", agentName: "Task Store" },
      idempotencyKey: "shared-task:completion:revision-1",
    }, {
      kind: "completion",
      importance: "important",
      summary: "One server-derived completion",
      taskId: "shared-task",
    })
  : await store.append({
      source: "agent",
      actor: { agentId: `process-${label}`, agentName: `Process ${label}` },
    }, {
      kind: "note",
      summary: `Cross-process event ${label}`,
    });

process.stdout.write(`${JSON.stringify(event)}\n`);
