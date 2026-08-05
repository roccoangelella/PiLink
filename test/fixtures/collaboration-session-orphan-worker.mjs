import fs from "node:fs/promises";
import { CollaborationSessionStore } from "../../dist/collaboration-sessions.js";

const [workspace, dataDir, keyId, keyMaterial, agentId, countText, readyPath, nowIso] = process.argv.slice(2);
const count = Number(countText);
if (!workspace || !dataDir || !keyId || !keyMaterial || !agentId ||
    !Number.isSafeInteger(count) || count < 1 || !readyPath || !nowIso || !Number.isFinite(Date.parse(nowIso))) {
  throw new Error("Expected workspace, dataDir, credential key, agentId, count, ready path, and time");
}

const store = new CollaborationSessionStore({
  workspace,
  dataDir,
  credentialKey: { keyId, keyMaterial },
  maxLiveSessionsPerActor: count,
  now: () => new Date(nowIso),
});
const collaborationSessionIds = [];
const collaborationSessionHandles = [];
for (let index = 0; index < count; index += 1) {
  const credential = await store.start({
    agentId,
    agentName: agentId,
    label: `crash-owner-${index + 1}`,
  });
  collaborationSessionIds.push(credential.session.collaborationSessionId);
  collaborationSessionHandles.push(credential.collaborationSessionHandle);
}
const readyTempPath = `${readyPath}.${process.pid}.tmp`;
await fs.writeFile(
  readyTempPath,
  `${JSON.stringify({ collaborationSessionIds, collaborationSessionHandles })}\n`,
  { mode: 0o600 },
);
await fs.rename(readyTempPath, readyPath);

// Deliberately retain the process and its private in-memory bearers. The parent
// test kills this process to simulate a PiLink crash with no cleanup hooks.
setInterval(() => {}, 60_000);
