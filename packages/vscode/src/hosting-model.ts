export const HOSTING_KINDS = ["quick-tunnel", "cloudflare-named", "custom-domain", "local", "nip-io"] as const;
export const CLOUDFLARE_AUTH_KINDS = ["origin-certificate", "tunnel-token-file"] as const;

export type HostingKind = (typeof HOSTING_KINDS)[number];
export type CloudflareAuthKind = (typeof CLOUDFLARE_AUTH_KINDS)[number];

export interface HostingSelection {
  kind: HostingKind;
  publicUrl?: string;
  landingHostname?: string;
  tunnelName?: string;
  zoneName?: string;
  mcpHostname?: string;
  cloudflareAuthKind?: CloudflareAuthKind;
  tunnelId?: string;
  credentialReference?: string;
  credentialLabel?: string;
}

export interface HostingStartPlan {
  command: "start" | "serve";
  public: boolean;
  stable: boolean;
}

export function normalizeHostingSelection(value: unknown, allowCredentialReference = false): HostingSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || !(HOSTING_KINDS as readonly string[]).includes(candidate.kind)) return undefined;
  const kind = candidate.kind as HostingKind;
  if (kind === "cloudflare-named") {
    const tunnelName = normalizeTunnelName(candidate.tunnelName);
    const zoneName = typeof candidate.zoneName === "string" ? normalizeHostname(candidate.zoneName) : undefined;
    const mcpHostname = typeof candidate.mcpHostname === "string" ? normalizeHostname(candidate.mcpHostname) : undefined;
    const landingHostname = typeof candidate.landingHostname === "string" ? normalizeHostname(candidate.landingHostname) : undefined;
    const authKind = typeof candidate.cloudflareAuthKind === "string" &&
      (CLOUDFLARE_AUTH_KINDS as readonly string[]).includes(candidate.cloudflareAuthKind)
      ? candidate.cloudflareAuthKind as CloudflareAuthKind
      : undefined;
    if (
      !tunnelName || !zoneName || !mcpHostname || !landingHostname || !authKind ||
      mcpHostname === landingHostname || !isHostnameInZone(mcpHostname, zoneName) || !isHostnameInZone(landingHostname, zoneName)
    ) return undefined;
    const tunnelId = authKind === "tunnel-token-file" ? normalizeTunnelId(candidate.tunnelId) : undefined;
    if (authKind === "tunnel-token-file" && !tunnelId) return undefined;
    const credentialReference = allowCredentialReference && typeof candidate.credentialReference === "string" &&
      /^[0-9a-f-]{36}$/i.test(candidate.credentialReference) ? candidate.credentialReference : undefined;
    const credentialLabel = allowCredentialReference && typeof candidate.credentialLabel === "string"
      ? candidate.credentialLabel.replace(/[\r\n\0]/g, "").slice(0, 160)
      : undefined;
    return {
      kind,
      tunnelName,
      zoneName,
      mcpHostname,
      landingHostname,
      publicUrl: `https://${mcpHostname}`,
      cloudflareAuthKind: authKind,
      ...(tunnelId ? { tunnelId } : {}),
      ...(credentialReference ? { credentialReference } : {}),
      ...(credentialLabel ? { credentialLabel } : {}),
    };
  }
  if (kind === "custom-domain") {
    if (typeof candidate.publicUrl !== "string") return undefined;
    const publicUrl = normalizePublicBaseUrl(candidate.publicUrl);
    if (!publicUrl) return undefined;
    const landingHostname = typeof candidate.landingHostname === "string" && candidate.landingHostname.trim()
      ? normalizeHostname(candidate.landingHostname)
      : undefined;
    if (candidate.landingHostname && !landingHostname) return undefined;
    if (landingHostname === new URL(publicUrl).hostname) return undefined;
    return { kind, publicUrl, ...(landingHostname ? { landingHostname } : {}) };
  }
  return { kind };
}

function normalizeHostname(value: string): string | undefined {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    hostname.length > 253 || !hostname ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) return undefined;
  return hostname;
}

export function normalizePublicBaseUrl(value: string): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    if (!url.hostname || url.port) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return undefined;
  }
}

export function normalizeMcpEndpointOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "/sse" && parsed.pathname !== "/" && parsed.pathname !== "")
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function hostingStartPlan(selection: HostingSelection): HostingStartPlan {
  switch (selection.kind) {
    case "quick-tunnel":
      return { command: "start", public: true, stable: false };
    case "cloudflare-named":
      return { command: "serve", public: true, stable: true };
    case "nip-io":
      return { command: "start", public: true, stable: true };
    case "custom-domain":
      return { command: "serve", public: true, stable: true };
    case "local":
      return { command: "serve", public: false, stable: true };
  }
}

export function hostingLabel(kind: HostingKind): string {
  switch (kind) {
    case "quick-tunnel": return "Cloudflare Quick Tunnel";
    case "cloudflare-named": return "Cloudflare fixed domain (Named Tunnel)";
    case "custom-domain": return "Stable HTTPS domain";
    case "local": return "Local VS Code only";
    case "nip-io": return "HTTPS nip.io legacy";
  }
}

function normalizeTunnelName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])$/.test(normalized) ? normalized : undefined;
}

function normalizeTunnelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

function isHostnameInZone(hostname: string, zoneName: string): boolean {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`);
}
