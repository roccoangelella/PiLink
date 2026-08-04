import fs from "node:fs/promises";

import type { DnsRecordInspection } from "./types.js";

interface OriginCertificatePayload {
  accountID: string;
  zoneID: string;
  apiToken: string;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number }>;
}

interface CloudflareZone {
  id: string;
  name: string;
  status?: string;
}

interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

export interface CloudflareCertificateMetadata {
  accountId: string;
  zoneId: string;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly codes: number[];

  constructor(status: number, codes: number[] = []) {
    const suffix = codes.length > 0 ? ` (codes: ${codes.join(",")})` : "";
    super(`Cloudflare API request failed with HTTP ${status}${suffix}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = codes;
  }
}

export class CloudflareApiClient {
  readonly metadata: CloudflareCertificateMetadata;
  readonly #apiToken: string;
  readonly #fetch: typeof globalThis.fetch;

  private constructor(payload: OriginCertificatePayload, fetchImplementation: typeof globalThis.fetch) {
    this.metadata = { accountId: payload.accountID, zoneId: payload.zoneID };
    this.#apiToken = payload.apiToken;
    this.#fetch = fetchImplementation;
  }

  static async fromOriginCertificate(
    certificateRealPath: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<CloudflareApiClient> {
    const payload = await readCertificatePayload(certificateRealPath);
    return new CloudflareApiClient(payload, fetchImplementation);
  }

  async assertZone(expectedZoneName: string): Promise<void> {
    const zone = await this.#request<CloudflareZone>(`/zones/${this.metadata.zoneId}`);
    if (zone.name.toLowerCase() !== expectedZoneName) {
      throw new Error(`The supplied Cloudflare certificate belongs to a different DNS zone than ${expectedZoneName}`);
    }
    if (zone.status && zone.status !== "active") {
      throw new Error(`Cloudflare zone ${expectedZoneName} is not active`);
    }
  }

  async inspectDnsRecord(hostname: string, expectedTunnelId?: string): Promise<DnsRecordInspection> {
    const query = new URLSearchParams({ name: hostname, per_page: "20" });
    const records = await this.#request<CloudflareDnsRecord[]>(
      `/zones/${this.metadata.zoneId}/dns_records?${query.toString()}`,
    );
    const exact = records.filter((record) => record.name.toLowerCase() === hostname);
    if (exact.length === 0) return { hostname, state: "missing" };
    if (exact.length !== 1 || !expectedTunnelId) {
      return { hostname, state: "conflict", reason: "hostname is already occupied" };
    }
    const record = exact[0];
    const expectedTarget = `${expectedTunnelId}.cfargotunnel.com`;
    if (
      record.type !== "CNAME"
      || record.content.toLowerCase().replace(/\.$/, "") !== expectedTarget.toLowerCase()
    ) {
      return { hostname, state: "conflict", reason: "hostname points to a different service" };
    }
    return {
      hostname,
      state: record.proxied ? "matching" : "needs-proxy",
      recordId: record.id,
      target: record.content,
      proxied: record.proxied === true,
    };
  }

  async createDnsRecord(hostname: string, tunnelId: string): Promise<void> {
    await this.#request<CloudflareDnsRecord>(`/zones/${this.metadata.zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      }),
    });
  }

  async enableDnsProxy(recordId: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/i.test(recordId)) throw new Error("Cloudflare DNS record ID is invalid");
    await this.#request<CloudflareDnsRecord>(
      `/zones/${this.metadata.zoneId}/dns_records/${recordId}`,
      { method: "PATCH", body: JSON.stringify({ proxied: true }) },
    );
  }

  async #request<T>(resource: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`https://api.cloudflare.com/client/v4${resource}`, {
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
    if (body.length > 1024 * 1024) throw new CloudflareApiError(response.status);
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = JSON.parse(body) as CloudflareEnvelope<T>;
    } catch {
      throw new CloudflareApiError(response.status);
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      throw new CloudflareApiError(
        response.status,
        (envelope.errors ?? []).flatMap((error) => Number.isSafeInteger(error.code) ? [error.code as number] : []),
      );
    }
    return envelope.result;
  }
}

async function readCertificatePayload(certificateRealPath: string): Promise<OriginCertificatePayload> {
  const status = await fs.stat(certificateRealPath);
  if (status.size > 16 * 1024) throw new Error("Cloudflare origin certificate file is unexpectedly large");
  const pem = await fs.readFile(certificateRealPath, "utf8");
  const match = pem.match(
    /^-----BEGIN ARGO TUNNEL TOKEN-----\s+([A-Za-z0-9+/=\r\n]+?)\s+-----END ARGO TUNNEL TOKEN-----\s*$/,
  );
  if (!match) throw new Error("Cloudflare origin certificate has an invalid envelope");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(match[1].replace(/\s/g, ""), "base64").toString("utf8"));
  } catch {
    throw new Error("Cloudflare origin certificate payload is invalid");
  }
  if (!isCertificatePayload(decoded)) throw new Error("Cloudflare origin certificate payload is invalid");
  return decoded;
}

function isCertificatePayload(value: unknown): value is OriginCertificatePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountID === "string"
    && /^[0-9a-f]{32}$/i.test(record.accountID)
    && typeof record.zoneID === "string"
    && /^[0-9a-f]{32}$/i.test(record.zoneID)
    && typeof record.apiToken === "string"
    && record.apiToken.length >= 20
    && record.apiToken.length <= 512
    && !/\s/.test(record.apiToken)
  );
}
