import type { ProcessViewState } from "./protocol.js";

export function effectiveProcessState(
  supervised: ProcessViewState,
  authenticatedRuntimeOnline: boolean,
  managedServerState: string,
  managedTunnelState: string,
): ProcessViewState {
  const managedRuntimeActive = managedServerState === "active" && managedTunnelState === "active";
  if ((authenticatedRuntimeOnline || managedRuntimeActive) && supervised.status === "stopped") {
    return {
      ...supervised,
      status: "running",
      mode: managedRuntimeActive ? "Persistent service" : "Detected service",
    };
  }
  return supervised;
}
