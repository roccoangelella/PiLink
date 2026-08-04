export const VSPILINK_SHUTDOWN_MESSAGE = Object.freeze({ type: "vspilink.shutdown" as const });

export function windowsTaskkillArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process ID: ${pid}`);
  return ["/PID", String(pid), "/T", "/F"];
}
