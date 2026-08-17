import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/i;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const API_TOKEN = /^[^\s\u0000-\u001f\u007f]{20,512}$/u;
const TUNNEL_TOKEN = /^[^\s\u0000-\u001f\u007f]{20,4096}$/u;
const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export interface FixedDomainTunnelConfig {
  hostname: string;
  tunnelId: string;
  tokenFile: string;
}

export interface FixedDomainProvisionOptions {
  hostname: string;
  origin: string;
  apiToken: string;
  tokenDirectory: string;
  fetch?: typeof globalThis.fetch;
}

export interface FixedDomainProvisionResult extends FixedDomainTunnelConfig {
  zoneName: string;
  tunnelName: string;
  createdTunnel: boolean;
  updatedTunnelConfiguration: boolean;
  createdDnsRecord: boolean;
  enabledDnsProxy: boolean;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number }>;
}

interface CloudflareZone {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  account?: { id?: unknown };
}

interface CloudflareTunnel {
  id?: unknown;
  name?: unknown;
}

interface CloudflareDnsRecord {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  content?: unknown;
  proxied?: unknown;
}

export class CloudflareFixedDomainApiError extends Error {
  readonly status: number;
  readonly codes: number[];

  constructor(status: number, codes: number[] = []) {
    const suffix = codes.length ? ` (codes: ${codes.join(",")})` : "";
    super(`Cloudflare API request failed with HTTP ${status}${suffix}`);
    this.name = "CloudflareFixedDomainApiError";
    this.status = status;
    this.codes = codes;
  }
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

export async function provisionFixedDomainTunnel(options: FixedDomainProvisionOptions): Promise<FixedDomainProvisionResult> {
  const hostname = normalizeFixedDomainHostname(options.hostname);
  const origin = normalizeFixedDomainOrigin(options.origin);
  const apiToken = normalizeApiToken(options.apiToken);
  const api = new FixedDomainCloudflareApi(apiToken, options.fetch ?? globalThis.fetch);
  const zone = await api.findZoneForHostname(hostname);
  const tunnelName = fixedDomainTunnelName(hostname);
  let tunnel = await api.findTunnel(zone.accountId, tunnelName);
  let createdTunnel = false;
  if (!tunnel) {
    tunnel = await api.createTunnel(zone.accountId, tunnelName);
    createdTunnel = true;
  }

  let updatedTunnelConfiguration = false;
  if (createdTunnel) {
    await api.putTunnelConfiguration(zone.accountId, tunnel.id, hostname, origin);
    updatedTunnelConfiguration = true;
  } else {
    const configuration = await api.getTunnelConfiguration(zone.accountId, tunnel.id);
    if (!isDesiredTunnelConfiguration(configuration, hostname, origin)) {
      if (!isClaimableTunnelConfiguration(configuration)) {
        throw new Error(`Cloudflare tunnel ${tunnelName} already has unrelated ingress rules; PiLink will not overwrite them`);
      }
      await api.putTunnelConfiguration(zone.accountId, tunnel.id, hostname, origin);
      updatedTunnelConfiguration = true;
    }
  }

  const dns = await api.ensureDnsRecord(zone.zoneId, hostname, tunnel.id);
  const tunnelToken = await api.getTunnelToken(zone.accountId, tunnel.id);
  const tokenFile = writeFixedDomainTokenFile(options.tokenDirectory, tunnel.id, tunnelToken);
  return {
    hostname,
    zoneName: zone.zoneName,
    tunnelName,
    tunnelId: tunnel.id,
    tokenFile,
    createdTunnel,
    updatedTunnelConfiguration,
    createdDnsRecord: dns.created,
    enabledDnsProxy: dns.enabledProxy,
  };
}

function normalizeApiToken(value: string): string {
  const token = value.trim();
  if (!API_TOKEN.test(token)) throw new Error("Cloudflare API token is invalid");
  return token;
}

function normalizeFixedDomainOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Cloudflare fixed-domain origin is invalid");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port ||
    !Number.isSafeInteger(port) || port < 1 || port > 65_535 || parsed.username || parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash
  ) {
    throw new Error("Cloudflare fixed-domain origin must be a loopback HTTP origin such as http://127.0.0.1:3200");
  }
  return `http://127.0.0.1:${port}`;
}

function fixedDomainTunnelName(hostname: string): string {
  const slug = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "pilink";
  const digest = createHash("sha256").update(hostname).digest("hex").slice(0, 10);
  return `pilink-${slug}-${digest}`;
}

function isDesiredTunnelConfiguration(value: unknown, hostname: string, origin: string): boolean {
  const ingress = tunnelIngress(value);
  if (!ingress || ingress.length !== 2) return false;
  const first = objectValue(ingress[0]);
  const last = objectValue(ingress[1]);
  return Boolean(
    first && last && first.hostname === hostname && first.service === origin &&
    last.service === "http_status:404" && !("hostname" in last),
  );
}

function isClaimableTunnelConfiguration(value: unknown): boolean {
  const ingress = tunnelIngress(value);
  if (!ingress || ingress.length === 0) return true;
  if (ingress.length !== 1) return false;
  const only = objectValue(ingress[0]);
  return Boolean(only && only.service === "http_status:404" && !("hostname" in only));
}

function tunnelIngress(value: unknown): unknown[] | undefined {
  const root = objectValue(value);
  const config = objectValue(root?.config);
  return Array.isArray(config?.ingress) ? config.ingress : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function writeFixedDomainTokenFile(directoryValue: string, tunnelId: string, tokenValue: string): string {
  const tunnelIdNormalized = normalizeFixedDomainTunnelId(tunnelId);
  const token = tokenValue.trim();
  if (!TUNNEL_TOKEN.test(token)) throw new Error("Cloudflare returned an invalid tunnel token");
  const trimmedDirectory = directoryValue.trim();
  if (!trimmedDirectory || /[\r\n\0]/u.test(trimmedDirectory)) throw new Error("Cloudflare token directory is invalid");
  const directory = path.resolve(trimmedDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Cloudflare token directory must be a regular directory");
  assertCurrentOwner(directoryStat, "Cloudflare token directory");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);

  const destination = path.join(directory, `${tunnelIdNormalized}.token`);
  try {
    const existing = fs.lstatSync(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Existing Cloudflare tunnel token path is not a regular file");
    assertCurrentOwner(existing, "Existing Cloudflare tunnel token file");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const temporary = path.join(directory, `.${tunnelIdNormalized}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (process.platform !== "win32" || !["EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      fs.rmSync(destination, { force: true });
      fs.renameSync(temporary, destination);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  return resolveFixedDomainTokenFile(destination);
}

function assertCurrentOwner(stat: fs.Stats, label: string): void {
  if (process.platform === "win32") return;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`${label} must be owned by the PiLink operating-system user`);
}

class FixedDomainCloudflareApi {
  readonly #apiToken: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(apiToken: string, fetchImplementation: typeof globalThis.fetch) {
    this.#apiToken = apiToken;
    this.#fetch = fetchImplementation;
  }

  async findZoneForHostname(hostname: string): Promise<{ zoneId: string; zoneName: string; accountId: string }> {
    const labels = hostname.split(".");
    for (let index = 0; index <= labels.length - 2; index += 1) {
      const candidate = labels.slice(index).join(".");
      const query = new URLSearchParams({ name: candidate, status: "active", per_page: "5" });
      const zones = await this.#request<CloudflareZone[]>(`/zones?${query.toString()}`);
      const exact = zones.filter((zone) => typeof zone.name === "string" && zone.name.toLowerCase() === candidate);
      if (exact.length > 1) throw new Error(`Cloudflare returned multiple active zones named ${candidate}`);
      if (exact.length === 0) continue;
      const zone = exact[0];
      if (typeof zone.id !== "string" || !CLOUDFLARE_ID.test(zone.id)) throw new Error("Cloudflare returned an invalid zone ID");
      const accountId = zone.account?.id;
      if (typeof accountId !== "string" || !CLOUDFLARE_ID.test(accountId)) throw new Error("Cloudflare returned an invalid account ID");
      return { zoneId: zone.id.toLowerCase(), zoneName: candidate, accountId: accountId.toLowerCase() };
    }
    throw new Error(
      `No active Cloudflare DNS zone was found for ${hostname}. Ensure the token has Zone → Zone → Read access to the zone and that the domain uses Cloudflare DNS.`,
    );
  }

  async findTunnel(accountId: string, tunnelName: string): Promise<{ id: string; name: string } | undefined> {
    const query = new URLSearchParams({ name: tunnelName, is_deleted: "false", per_page: "10" });
    const tunnels = await this.#request<CloudflareTunnel[]>(`/accounts/${accountId}/cfd_tunnel?${query.toString()}`);
    const exact = tunnels.filter((tunnel) => tunnel.name === tunnelName);
    if (exact.length > 1) throw new Error(`Multiple Cloudflare tunnels already use the PiLink tunnel name ${tunnelName}`);
    if (exact.length === 0) return undefined;
    return normalizeTunnel(exact[0]);
  }

  async createTunnel(accountId: string, tunnelName: string): Promise<{ id: string; name: string }> {
    const tunnel = await this.#request<CloudflareTunnel>(`/accounts/${accountId}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
    });
    return normalizeTunnel(tunnel);
  }

  async getTunnelConfiguration(accountId: string, tunnelId: string): Promise<unknown> {
    try {
      return await this.#request<unknown>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
    } catch (error) {
      if (error instanceof CloudflareFixedDomainApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async putTunnelConfiguration(accountId: string, tunnelId: string, hostname: string, origin: string): Promise<void> {
    await this.#request<unknown>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: origin, originRequest: {} },
            { service: "http_status:404" },
          ],
        },
      }),
    });
  }

  async ensureDnsRecord(zoneId: string, hostname: string, tunnelId: string): Promise<{ created: boolean; enabledProxy: boolean }> {
    const query = new URLSearchParams({ name: hostname, per_page: "20" });
    const records = await this.#request<CloudflareDnsRecord[]>(`/zones/${zoneId}/dns_records?${query.toString()}`);
    const exact = records.filter((record) => typeof record.name === "string" && record.name.toLowerCase().replace(/\.$/, "") === hostname);
    const expectedTarget = `${tunnelId}.cfargotunnel.com`;
    if (exact.length === 0) {
      await this.#request<unknown>(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "CNAME", name: hostname, content: expectedTarget, proxied: true, ttl: 1 }),
      });
      return { created: true, enabledProxy: false };
    }
    if (exact.length !== 1) throw new Error(`${hostname} already has multiple Cloudflare DNS records; PiLink will not overwrite them`);
    const record = exact[0];
    if (
      record.type !== "CNAME" || typeof record.content !== "string" ||
      record.content.toLowerCase().replace(/\.$/, "") !== expectedTarget
    ) {
      throw new Error(`${hostname} is already occupied by an unrelated Cloudflare DNS record; PiLink will not overwrite it`);
    }
    if (record.proxied === true) return { created: false, enabledProxy: false };
    if (typeof record.id !== "string" || !CLOUDFLARE_ID.test(record.id)) throw new Error("Cloudflare returned an invalid DNS record ID");
    await this.#request<unknown>(`/zones/${zoneId}/dns_records/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({ proxied: true }),
    });
    return { created: false, enabledProxy: true };
  }

  async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const result = await this.#request<unknown>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    const token = typeof result === "string" ? result : objectValue(result)?.token;
    if (typeof token !== "string" || !TUNNEL_TOKEN.test(token.trim())) throw new Error("Cloudflare returned an invalid tunnel token");
    return token.trim();
  }

  async #request<T>(resource: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${CLOUDFLARE_API_BASE}${resource}`, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#apiToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_API_RESPONSE_BYTES) throw new CloudflareFixedDomainApiError(response.status);
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = JSON.parse(body) as CloudflareEnvelope<T>;
    } catch {
      throw new CloudflareFixedDomainApiError(response.status);
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      throw new CloudflareFixedDomainApiError(
        response.status,
        (envelope.errors ?? []).flatMap((error) => Number.isSafeInteger(error.code) ? [error.code as number] : []),
      );
    }
    return envelope.result;
  }
}

function normalizeTunnel(tunnel: CloudflareTunnel): { id: string; name: string } {
  if (typeof tunnel.id !== "string" || !TUNNEL_ID.test(tunnel.id)) throw new Error("Cloudflare returned an invalid tunnel ID");
  if (typeof tunnel.name !== "string" || !tunnel.name || /[\r\n\0]/u.test(tunnel.name)) throw new Error("Cloudflare returned an invalid tunnel name");
  return { id: tunnel.id.toLowerCase(), name: tunnel.name };
}
