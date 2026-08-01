import fs from "node:fs/promises";
import { CollaborationSessionStore } from "../../dist/collaboration-sessions.js";

const [workspace, dataDir, agentId, label, readyPath = "", gatePath = ""] = process.argv.slice(2);
if (!workspace || !dataDir || !agentId || !label) {
  throw new Error("Expected workspace, dataDir, agentId, and label arguments");
}

const store = new CollaborationSessionStore({ workspace, dataDir });
if (readyPath && gatePath) {
  await store.listByActor(agentId);
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

const credential = await store.start({
  agentId,
  agentName: agentId,
  label,
});
process.stdout.write(`${JSON.stringify(credential)}\n`);
