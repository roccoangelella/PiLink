import { CollaborationSessionStore } from "../../dist/collaboration-sessions.js";

const [
  action,
  workspace,
  dataDir,
  keyId,
  keyMaterial,
  agentId,
  agentName,
  collaborationSessionHandle,
  nowIso,
] = process.argv.slice(2);
if (!action || !workspace || !dataDir || !keyId || !keyMaterial || !agentId || !agentName ||
    !collaborationSessionHandle || !nowIso || !Number.isFinite(Date.parse(nowIso))) {
  throw new Error("Expected action, workspace, dataDir, credential key, actor, handle, and time");
}

const store = new CollaborationSessionStore({
  workspace,
  dataDir,
  credentialKey: { keyId, keyMaterial },
  now: () => new Date(nowIso),
});
const handleInput = { agentId, collaborationSessionHandle };
let result;
switch (action) {
  case "authenticate":
    result = await store.authenticate(handleInput);
    break;
  case "inspect":
    result = await store.inspect(handleInput);
    break;
  case "resume":
    result = await store.resume({
      ...handleInput,
      agentName,
      resumeRequestId: "cross-runtime-denied-01",
      ttlSeconds: 60,
    });
    break;
  case "release":
    result = await store.release(handleInput);
    break;
  default:
    throw new Error(`Unsupported action: ${action}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
