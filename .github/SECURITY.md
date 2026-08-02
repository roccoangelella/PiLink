# Security Policy

PiLink exposes an authenticated coding-agent harness to remote MCP clients. Vulnerabilities involving authentication, authorization, workspace confinement, command execution, public hosting, dependency integrity, or secret disclosure can have severe impact and should be reported privately. See the [PiLink threat model](../docs/THREAT_MODEL.md) for trust boundaries, security invariants, accepted residual risks, and verification expectations.

## Supported versions

Security fixes are provided for the latest published npm version and the current default branch. Older releases may receive a backport when the maintainers determine that it is practical and necessary, but users should normally upgrade to the latest release.

## Reporting a vulnerability

Use the repository's **Security** page and select **Report a vulnerability** to submit a private vulnerability report through GitHub Security Advisories.

Do not open a public issue containing vulnerability details, proof-of-concept code, credentials, public tunnel URLs, OAuth secrets, access tokens, or information that could identify an exposed PiLink instance.

When private vulnerability reporting is not available, open a public issue that asks the maintainers for a private security contact. Do not include any sensitive technical detail in that issue.

A useful private report includes:

- the affected PiLink version or commit;
- the deployment mode and relevant non-secret configuration;
- the security boundary that was bypassed;
- reproducible steps or a minimal proof of concept;
- the expected and observed behavior;
- the realistic impact and any known exploitation;
- suggested mitigations, when available.

## Response and disclosure

The maintainers aim to acknowledge a complete report within seven days and provide an initial assessment or request for more information within fourteen days. Complex reports may require more time. Please allow a reasonable remediation period before public disclosure and coordinate disclosure timing through the private advisory.

After a fix is available, the maintainers may publish a GitHub Security Advisory and request a CVE when appropriate. Reporters may be credited unless they prefer to remain anonymous.

## Scope notes

PiLink's `--allow-unsafe-full-access` mode intentionally grants authorized clients unrestricted shell and filesystem access. A trusted client using granted capabilities as documented is not a vulnerability. Reports are still welcome when an untrusted or insufficiently scoped client can obtain those capabilities, when workspace confinement can be bypassed, or when secrets and credentials are exposed unexpectedly.
