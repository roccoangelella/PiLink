import crypto from "node:crypto";

export const HEALTH_AUTH_SCHEME = "pilink-health-hmac-v1";
const HEALTH_PROOF_DOMAIN = "pilink-health-v1\0";
const HEALTH_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isHealthChallenge(value: unknown): value is string {
  return typeof value === "string" && HEALTH_CHALLENGE_PATTERN.test(value);
}

export function createHealthProof(secret: string, challenge: string, version: string, port: number): string {
  if (!isHealthChallenge(challenge)) throw new Error("Invalid PiLink health challenge");
  return crypto
    .createHmac("sha256", secret)
    .update(`${HEALTH_PROOF_DOMAIN}${challenge}\0${version}\0${port}`)
    .digest("base64url");
}
