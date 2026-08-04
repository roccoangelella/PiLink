export const REQUIRED_NODE_VERSION = "24.18.0";

export function isRequiredNodeVersion(version: string): boolean {
  const normalized = version.trim();
  return normalized === REQUIRED_NODE_VERSION || normalized === `v${REQUIRED_NODE_VERSION}`;
}

export function assertRequiredNodeVersion(version = process.version): void {
  if (isRequiredNodeVersion(version)) return;
  const current = version.trim() || "unknown";
  throw new Error(`PiLink requires Node.js ${REQUIRED_NODE_VERSION} exactly; current runtime is ${current}.`);
}
