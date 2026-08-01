import fs from "node:fs/promises";
import { CollaborationSessionStore } from "../../dist/collaboration-sessions.js";

const [
  workspace,
  dataDir,
  keyId,
  keyMaterial,
  agentId,
  agentName,
  collaborationSessionHandle,
  resumeRequestId,
  ttlSecondsRaw,
  nowIso,
  readyPath = "",
  gatePath = "",
] = process.argv.slice(2);
if (!workspace || !dataDir || !keyId || !keyMaterial || !agentId || !agentName ||
    !collaborationSessionHandle || !resumeRequestId || !ttlSecondsRaw || !nowIso) {
  throw new Error("Expected workspace, dataDir, credential key, identity, handle, request ID, and TTL arguments");
}
const ttlSeconds = Number(ttlSecondsRaw);
if (!Number.isSafeInteger(ttlSeconds)) throw new Error("TTL must be an integer");

const store = new CollaborationSessionStore({
  workspace,
  dataDir,
  credentialKey: { keyId, keyMaterial },
  defaultTtlSeconds: 60,
  resumeGraceSeconds: 120,
  resumeRecoverySeconds: 30,
  now: () => new Date(nowIso),
});
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

const credential = await store.resume({
  agentId,
  agentName,
  collaborationSessionHandle,
  resumeRequestId,
  ttlSeconds,
});
process.stdout.write(`${JSON.stringify(credential)}\n`);
