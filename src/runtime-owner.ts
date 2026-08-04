import { randomBytes } from "node:crypto";
import fs from "node:fs";

export const RUNTIME_INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROCESS_START_MARKER_PATTERN = /^[0-9]{1,32}$/;

export interface RuntimeOwner {
  version: 1;
  runtimeInstanceId: string;
  pid: number;
  bootId?: string;
  processStartMarker?: string;
}

export type RuntimeOwnerLiveness = "alive" | "dead" | "ambiguous";
export type ProcessExistence = "exists" | "absent" | "ambiguous";

export interface RuntimeOwnerLivenessObservation {
  owner: Readonly<RuntimeOwner>;
  currentOwner: Readonly<RuntimeOwner>;
  platform: NodeJS.Platform;
  processExistence: ProcessExistence;
  observedProcessStartMarker?: string;
}

export const LOCAL_RUNTIME_OWNER: Readonly<RuntimeOwner> = Object.freeze({
  version: 1,
  runtimeInstanceId: randomBytes(16).toString("hex"),
  pid: process.pid,
  bootId: readLinuxBootId(),
  processStartMarker: readProcessStartMarker(process.pid),
});

/**
 * New Linux sessions must never persist an incomplete owner because such a
 * record cannot be reclaimed authoritatively after a crash.
 */
export function validateLocalRuntimeOwnerForPlatform(
  owner: Readonly<RuntimeOwner>,
  platform: NodeJS.Platform,
): RuntimeOwner {
  if (platform === "linux" && (!owner.bootId || !owner.processStartMarker)) {
    throw new Error("Unable to establish the local Linux runtime identity for collaboration-session ownership");
  }
  return { ...owner };
}

export function requireLocalRuntimeOwner(): RuntimeOwner {
  return validateLocalRuntimeOwnerForPlatform(LOCAL_RUNTIME_OWNER, process.platform);
}

export function sameRuntimeOwner(
  left: Readonly<RuntimeOwner>,
  right: Readonly<RuntimeOwner>,
): boolean {
  return left.version === right.version &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.pid === right.pid &&
    left.bootId === right.bootId &&
    left.processStartMarker === right.processStartMarker;
}

/** Pure classifier used by the store and deterministic tests. */
export function classifyRuntimeOwnerLiveness(
  observation: RuntimeOwnerLivenessObservation,
): RuntimeOwnerLiveness {
  const { owner, currentOwner, platform, processExistence, observedProcessStartMarker } = observation;
  if (sameRuntimeOwner(owner, currentOwner)) return "alive";

  // The current PID cannot simultaneously belong to a different runtime epoch.
  if (owner.pid === currentOwner.pid) return "dead";

  // Collaboration state is supported only within one host/PID namespace. On
  // Linux, a changed boot ID is therefore authoritative local reboot evidence.
  if (platform === "linux" && owner.bootId && currentOwner.bootId &&
      owner.bootId !== currentOwner.bootId) {
    return "dead";
  }

  if (processExistence === "absent") return "dead";
  if (processExistence === "ambiguous") return "ambiguous";

  if (owner.processStartMarker && observedProcessStartMarker) {
    return owner.processStartMarker === observedProcessStartMarker ? "alive" : "dead";
  }

  // A live PID without a readable start marker is not enough to prove that the
  // persisted owner still exists; preserve it rather than risking eviction.
  return "ambiguous";
}

export function classifyPersistedRuntimeOwner(owner: Readonly<RuntimeOwner>): RuntimeOwnerLiveness {
  const processExistence = probeProcessExistence(owner.pid);
  const observedProcessStartMarker = processExistence === "exists"
    ? readProcessStartMarker(owner.pid)
    : undefined;
  return classifyRuntimeOwnerLiveness({
    owner,
    currentOwner: LOCAL_RUNTIME_OWNER,
    platform: process.platform,
    processExistence,
    observedProcessStartMarker,
  });
}

export function parseLinuxProcessStatStartTime(serialized: string): string | undefined {
  if (typeof serialized !== "string") return undefined;
  const commandEnd = serialized.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  // The suffix begins at proc field 3, so field 22 is zero-based token 19.
  const fieldsAfterCommand = serialized.slice(commandEnd + 1).trim().split(/\s+/);
  const startMarker = fieldsAfterCommand[19];
  return startMarker && PROCESS_START_MARKER_PATTERN.test(startMarker) ? startMarker : undefined;
}

function readLinuxBootId(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
    return LINUX_BOOT_ID_PATTERN.test(bootId) ? bootId : undefined;
  } catch {
    return undefined;
  }
}

function readProcessStartMarker(pid: number): string | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    return parseLinuxProcessStatStartTime(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

function probeProcessExistence(pid: number): ProcessExistence {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return "absent";
    return "ambiguous";
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
