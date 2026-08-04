export type OAuthActivityKind = "registered" | "authorized" | "token" | "refresh";

export interface ClientActivity {
  clientId: string;
  registeredAt?: string;
  authorizedAt?: string;
  tokenIssuedAt?: string;
  refreshedAt?: string;
  mcpInitializedAt?: string;
  activeMcpSessions: number;
}

const clients = new Map<string, ClientActivity>();
const MAX_TRACKED_CLIENTS = 128;

export function recordOAuthActivity(clientId: string, kind: OAuthActivityKind): void {
  if (!validClientId(clientId)) return;
  const activity = activityFor(clientId);
  const now = new Date().toISOString();
  if (kind === "registered") activity.registeredAt = now;
  if (kind === "authorized") activity.authorizedAt = now;
  if (kind === "token") activity.tokenIssuedAt = now;
  if (kind === "refresh") activity.refreshedAt = now;
}

export function recordMcpInitialized(clientId: string): void {
  if (!validClientId(clientId)) return;
  activityFor(clientId).mcpInitializedAt = new Date().toISOString();
}

export function setActiveMcpSessions(clientId: string, count: number): void {
  if (!validClientId(clientId)) return;
  activityFor(clientId).activeMcpSessions = Math.max(0, Math.floor(count));
}

export function serviceActivitySnapshot(): { clients: ClientActivity[]; chatgptConnected: boolean } {
  const snapshot = [...clients.values()]
    .map((activity) => ({ ...activity, clientId: maskClientId(activity.clientId) }))
    .sort((left, right) => lastTimestamp(right).localeCompare(lastTimestamp(left)));
  return {
    clients: snapshot,
    chatgptConnected: snapshot.some((activity) => Boolean(activity.mcpInitializedAt)),
  };
}

function activityFor(clientId: string): ClientActivity {
  let activity = clients.get(clientId);
  if (!activity) {
    if (clients.size >= MAX_TRACKED_CLIENTS) {
      const oldest = clients.keys().next().value as string | undefined;
      if (oldest) clients.delete(oldest);
    }
    activity = { clientId, activeMcpSessions: 0 };
    clients.set(clientId, activity);
  }
  return activity;
}

function validClientId(clientId: string): boolean {
  return typeof clientId === "string" && clientId.length > 0 && clientId.length <= 128;
}

function maskClientId(clientId: string): string {
  if (clientId.length <= 8) return "••••";
  return `${clientId.slice(0, 4)}…${clientId.slice(-4)}`;
}

function lastTimestamp(activity: ClientActivity): string {
  return activity.mcpInitializedAt || activity.refreshedAt || activity.tokenIssuedAt || activity.authorizedAt || activity.registeredAt || "";
}
