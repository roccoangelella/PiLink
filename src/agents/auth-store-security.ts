import fs from "node:fs/promises";
import path from "node:path";

const MAX_AUTH_FILE_BYTES = 1024 * 1024;

export interface PreparedAgentAuthStore {
  agentDir: string;
  authPath: string;
}

/**
 * Secure the credential directory and reject an unsafe pre-existing auth.json
 * before a provider runtime gets a chance to open it.
 */
export async function preparePrivateAgentAuthStore(value: string): Promise<PreparedAgentAuthStore> {
  const agentDir = await ensurePrivateAgentDir(value);
  const authPath = path.join(agentDir, "auth.json");
  await inspectPrivateAuthFile(authPath, { allowMissing: true, requirePrivateMode: true });
  return { agentDir, authPath };
}

/**
 * Apply 0600 to a runtime-created credential file, then validate it again
 * without ever accepting a symlink, non-file, foreign owner, or oversized file.
 */
export async function securePrivateAgentAuthFile(authPath: string, allowMissing = false): Promise<void> {
  const entry = await inspectPrivateAuthFile(authPath, { allowMissing, requirePrivateMode: false });
  if (!entry) return;
  if (process.platform !== "win32") await fs.chmod(authPath, 0o600);
  await inspectPrivateAuthFile(authPath, { allowMissing: false, requirePrivateMode: true });
}

async function ensurePrivateAgentDir(value: string): Promise<string> {
  if (!path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error("Agent credential directory must be an absolute path");
  }
  const resolved = path.resolve(value);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  let entry = await fs.lstat(resolved);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Agent credential directory must be a regular directory");
  }
  assertCurrentOwner(entry.uid, "Agent credential directory");
  if (process.platform !== "win32") {
    await fs.chmod(resolved, 0o700);
    entry = await fs.lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.mode & 0o777) !== 0o700) {
      throw new Error("Agent credential directory must use mode 0700");
    }
    assertCurrentOwner(entry.uid, "Agent credential directory");
  }
  return resolved;
}

async function inspectPrivateAuthFile(
  authPath: string,
  options: { allowMissing: boolean; requirePrivateMode: boolean },
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  let entry: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    entry = await fs.lstat(authPath);
  } catch (error) {
    if (options.allowMissing && isMissing(error)) return undefined;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("Agent credential store must be a regular file and must not be a symbolic link");
  }
  assertCurrentOwner(entry.uid, "Agent credential store");
  if (entry.size > MAX_AUTH_FILE_BYTES) throw new Error("Agent credential store is unexpectedly large");
  if (options.requirePrivateMode && process.platform !== "win32" && (entry.mode & 0o777) !== 0o600) {
    throw new Error("Agent credential store must use mode 0600");
  }
  return entry;
}

function assertCurrentOwner(uid: number, subject: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && uid !== currentUid) throw new Error(`${subject} has an unexpected owner`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
