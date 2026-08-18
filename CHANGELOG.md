# Changelog

All notable PiLink changes are documented in this file.

## Unreleased

### Added

- VS Code extension workflow for the PiLink MCP bridge.
- OAuth-protected ChatGPT MCP connection and collaborative agent monitoring.
- Cloudflare hosting helpers and guided configuration.
- Sanitized English illustrated installation, Work plugin, OAuth, and agent
  monitoring walkthrough.
- Reproducible release-candidate staging with checksums, SBOM generation,
  artifact inspection, and cross-platform VSIX installers.

### Changed

- Integrated and tested the PiLink `feature/agent-public-chat` baseline through
  `b629c0ee004b7e792125158879c55ee00bd89310`, including immutable chat-author
  provenance and trusted logical collaboration bindings.
- Consolidated the primary ChatGPT workflow around installed plugins in
  ChatGPT Work while retaining legacy OAuth/client compatibility paths.
- Reworked extension and operator documentation in English with exact VS Code
  navigation, `run` profile requirements, and separate release/source install
  commands.
- Source builds now create a self-identifying, repairable user launcher on
  POSIX systems instead of depending on a fragile source-tree symlink. Builds
  migrate only recognized PiLink symlinks and continue to refuse unrelated
  commands.
- `npm run dev` is now compile/watch only; raw development-server startup moved
  to the explicit `npm run dev:server` command. `npm run cli -- ...` provides a
  source-checkout CLI fallback when no user PATH launcher can be created.

### Security

- Worktree, Git-history, npm-package, and VSIX secret scanning.
- Private runtime material excluded from source and extension packages.
- Release installers now reject a missing or mismatched `SHA256SUMS` unless an
  explicit development-only override is set.
- Linux helper bootstrap pins official `cloudflared` 2026.7.2 and Caddy 2.11.4
  assets by architecture and rejects unverified or remote plain-HTTP downloads.
- Manual, read-only release workflow with no publishing credentials.

Release dates and version headings are added only when a tested commit is
tagged; the repository currently contains no PiLink 2.2.0 release tag.
