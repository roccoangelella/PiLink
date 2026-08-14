# Contributing to PiLink

## Development environment

PiLink deliberately uses exactly Node.js **24.18.0** and npm **11.16.0**.
Use `.nvmrc` or `.node-version`, then verify both versions before installing:

```text
node --version
npm --version
npm ci
```

Do not commit `node_modules`, `dist`, ad-hoc package builds, runtime state,
OAuth client stores, tunnel credentials, logs, certificates, or local `.env`
files. The only binary archives intentionally versioned are the maintainer-built,
fully verified release artifacts under `release/`.

## Before opening a pull request

Run:

```text
npm run security:scan
npm run test:all
npm run release:stage
npm run release:verify
```

For changes involving credentials, authentication, packaging, or history,
also run `npm run security:scan:history`. Review generated files under
`release/`. Contributors should not replace them in an ordinary feature pull
request; a release maintainer commits the complete verified set together with
its SBOM and `SHA256SUMS`.

Keep changes focused and preserve the original PiLink attribution. New release
automation must remain non-publishing unless publication is explicitly reviewed
and authorized separately. Never add publishing tokens or credentials to a
workflow, command line, test fixture, screenshot, or log.

## Commits

Each commit should be coherent and, where practical, build and test on its own.
Do not rewrite published history. Keep the release-artifact commit separate
from source changes so its checksums and provenance are easy to review.
