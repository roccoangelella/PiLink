export const CHATGPT_DESTINATIONS = ["security", "plugins", "work"] as const;
export type ChatGptDestination = (typeof CHATGPT_DESTINATIONS)[number];

export const CHATGPT_LINKS: Readonly<Record<ChatGptDestination, string>> = Object.freeze({
  security: "https://chatgpt.com/#settings/Security",
  plugins: "https://chatgpt.com/plugins",
  work: "https://chatgpt.com/?surface=work",
});

export interface ChatGptNavigation {
  url: string;
  reuseUrlFilter?: string;
}

const ALLOWED_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);

export function chatGptUrl(destination: ChatGptDestination): string {
  const value = CHATGPT_LINKS[destination];
  if (!isAllowedChatGptUrl(value)) throw new Error("This ChatGPT destination is not allowed.");
  return value;
}

/**
 * ChatGPT Work is deliberately opened without a reuse filter so the primary
 * MCP surface gets its own editor. Setup pages can safely share their existing
 * ChatGPT browser editor.
 */
export function chatGptNavigation(destination: ChatGptDestination): ChatGptNavigation {
  const url = chatGptUrl(destination);
  return destination === "work"
    ? { url }
    : { url, reuseUrlFilter: "https://chatgpt.com/**" };
}

export function isAllowedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
