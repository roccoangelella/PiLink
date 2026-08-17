import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_TOKEN_FILE_BYTES = 64 * 1024;

export interface FixedDomainTunnelConfig {
  hostname: string;
  tunnelId: string;
  tokenFile: string;
}

export function normalizeFixedDomainHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    hostname.length < 3 || hostname.length > 253 || hostname.includes("..") ||
    hostname.split(".").length < 2 || hostname.split(".").some((label) => !HOST_LABEL.test(label))
  ) {
    throw new Error("Cloudflare hostname must be a valid lowercase DNS hostname such as mcp.example.com");
  }
  return hostname;
}

export function normalizeFixedDomainTunnelId(value: string): string {
  const tunnelId = value.trim().toLowerCase();
  if (!TUNNEL_ID.test(tunnelId)) throw new Error("Cloudflare tunnel ID must be a valid UUID");
  return tunnelId;
}

export function resolveFixedDomainTokenFile(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\0#]/u.test(trimmed)) throw new Error("Cloudflare tunnel token file path is invalid or cannot be stored safely in PiLink configuration");
  const homeRelative = trimmed.match(/^~[\\/](.*)$/u);
  const expanded = trimmed === "~" ? os.homedir() : homeRelative ? path.join(os.homedir(), homeRelative[1]) : trimmed;
  const tokenFile = path.resolve(expanded);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(tokenFile);
  } catch {
    throw new Error("Cloudflare tunnel token file does not exist");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error("Cloudflare tunnel token must be a non-empty regular file no larger than 64 KiB");
  }
  if (process.platform !== "win32") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new Error("Cloudflare tunnel token file must be owned by the PiLink operating-system user");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Cloudflare tunnel token file must be private (chmod 600)");
    }
  }
  return tokenFile;
}

export function fixedDomainCloudflaredArgs(config: Pick<FixedDomainTunnelConfig, "tunnelId" | "tokenFile">): string[] {
  return [
    "tunnel",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "run",
    "--token-file",
    config.tokenFile,
    config.tunnelId,
  ];
}
