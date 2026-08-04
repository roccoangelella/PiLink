import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareCredentialVault, CredentialVault, cloudflareCredentialKey, credentialKey, latestKey } from "../src/credential-vault.js";

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

test("external credentials keep the secret only in SecretStorage", async () => {
  const secrets = new MemorySecrets();
  const vault = new CredentialVault(secrets);
  const summary = await vault.store({
    schemaVersion: 1,
    configPath: "/private/config.env",
    clientId: "chatgpt-client",
    clientSecret: "one-time-secret",
    clientName: "ChatGPT",
    redirectUris: ["https://chatgpt.com/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    scope: "mcp:tools offline_access",
    tokenEndpointAuthMethod: "client_secret_post",
    createdAt: "2026-08-03T00:00:00.000Z",
  });

  assert.equal("clientSecret" in summary, false);
  assert.equal(JSON.stringify(summary).includes("one-time-secret"), false);
  assert.equal(await vault.value("/private/config.env", "chatgpt-client", "clientSecret"), "one-time-secret");
  assert.ok(secrets.values.has(credentialKey("/private/config.env", "chatgpt-client")));
  assert.equal(secrets.values.get(latestKey("/private/config.env")), "chatgpt-client");

  await vault.delete("/private/config.env", "chatgpt-client");
  assert.equal(await vault.latest("/private/config.env"), undefined);
});

test("Cloudflare credential references hide the selected secret file path", async () => {
  const secrets = new MemorySecrets();
  const vault = new CloudflareCredentialVault(secrets);
  const summary = await vault.store("origin-certificate", "/home/operator/.cloudflared/cert.pem");
  assert.deepEqual(Object.keys(summary).sort(), ["kind", "label", "reference"]);
  assert.equal(summary.label, "cert.pem");
  assert.equal(JSON.stringify(summary).includes("/home/operator"), false);
  assert.equal(await vault.get(summary).then((value) => value?.filePath), "/home/operator/.cloudflared/cert.pem");
  assert.ok(secrets.values.has(cloudflareCredentialKey(summary.reference)));
  await vault.delete(summary.reference);
  assert.equal(await vault.get(summary), undefined);
});
