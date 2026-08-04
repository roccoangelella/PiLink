# Security policy

## Supported versions

Security fixes are prepared for the latest released VSPiLink version. Older
versions may be asked to upgrade before a report can be reproduced or fixed.

## Report a vulnerability

Use the repository's private **GitHub Security Advisories → Report a
vulnerability** channel. Do not open a public issue containing vulnerability
details, credentials, access tokens, OAuth codes, callback URLs containing
codes, Cloudflare tunnel credentials, private keys, certificates, logs with
secrets, or an exploitable proof of concept.

Include only the minimum information needed to reproduce the problem:

- affected VSPiLink and VS Code versions;
- operating system and whether Remote-SSH is involved;
- affected component and a redacted reproduction;
- expected impact and any safe mitigation already tested.

Never attach the contents of `.env`, `auth.json`, `clients.json`, token stores,
Cloudflare credential files, `.npmrc`, or private key material. Replace secret
values with `[REDACTED]` before sharing diagnostics.

## Security-sensitive configuration

Full workspace or system access is intentionally high risk. Keep the server
bound to a trusted interface, use OAuth, grant the smallest practical scope,
and enable unrestricted execution only when the operator understands the
impact. Treat MCP clients and prompts as untrusted input. Do not weaken the
execution approval boundary to simplify onboarding.

## Release integrity

Official release candidates include `SHA256SUMS` and a CycloneDX SBOM. Verify
the checksum before installing a VSIX. A checksum proves file integrity against
the downloaded manifest; it does not replace publisher-signature verification
when a signed distribution channel is available.
