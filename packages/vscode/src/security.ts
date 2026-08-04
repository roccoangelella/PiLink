const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
export const REQUIRED_NODE_VERSION = "24.18.0";

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function redactSensitiveOutput(value: string): string {
  return stripAnsi(value)
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gi, "[PEM content redacted]")
    .replace(/(Client secret:\s*)[^\s]+/gi, "$1[shown only in the terminal]")
    .replace(/((?:JWT_SECRET|PI_BOOTSTRAP_SECRET|PI_AGENT_API_KEY|OPENAI_API_KEY|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|TUNNEL_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|API_KEY)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[redacted]")
    .replace(/((?:Authorization|Proxy-Authorization):\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:Cookie|Set-Cookie):\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/("(?:access_token|refresh_token|id_token|client_secret|api_key|apiKey|authorization|cookie)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/((?:[?&])(?:code|token|access_token|refresh_token|id_token|client_secret|api_key|key|state|session)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/((?:--(?:token|api-key|client-secret|secret|certificate-contents|credentials-contents))\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[API key redacted]");
}

export function isAwaitingCliInput(value: string): boolean {
  const plain = stripAnsi(value).trimEnd();
  const lastLine = plain.split(/\r?\n/).at(-1)?.trim() || "";
  if (lastLine === ">") return true;
  return /^(?:Type RESET to continue|How should PiLink continue\? \[1\/2\]|Enter new configuration directory \[default: .+\]|Enter new server port \[default: \d+\]|Select hosting \[1\/2\]|Allow PiLink to request these temporary router mappings\? \[Y\/n\]|Type DIRECT after completing the router configuration|Paste callback URL here):$/i.test(lastLine);
}

export function isNodeVersionSupported(version: string): boolean {
  const normalized = version.trim();
  return normalized === REQUIRED_NODE_VERSION || normalized === `v${REQUIRED_NODE_VERSION}`;
}
