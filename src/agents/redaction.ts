const HEADER_SECRET_PATTERN = /\b(authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|cookie|set-cookie)(\s*[:=]\s*)([^\s,;]+)/giu;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const QUERY_SECRET_PATTERN = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|key)=)[^&#\s]+/giu;
const OPENAI_STYLE_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const URL_CREDENTIAL_PATTERN = /:\/\/[^:/\s]+:[^@\s]+@/gu;
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export function redactAgentError(
  value: unknown,
  fallback: string,
  maximumBytes = 2 * 1024,
  exactSecrets: readonly (string | undefined)[] = [],
): string {
  let selected = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  for (const secret of exactSecrets) {
    if (secret && secret.length >= 4) selected = selected.split(secret).join("[REDACTED]");
  }
  selected = selected
    .replace(URL_CREDENTIAL_PATTERN, "://[REDACTED]@")
    .replace(AUTH_SCHEME_PATTERN, "$1 [REDACTED]")
    .replace(HEADER_SECRET_PATTERN, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_STYLE_KEY_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(UNSAFE_CHARACTERS, "?")
    .trim() || fallback;
  if (Buffer.byteLength(selected, "utf8") <= maximumBytes) return selected;
  const suffix = "\n[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maximumBytes) return truncateUtf8(suffix, maximumBytes);
  return `${truncateUtf8(selected, maximumBytes - suffixBytes)}${suffix}`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return value.slice(0, end);
}
