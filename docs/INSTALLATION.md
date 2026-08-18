# Installation

PiLink can run from its CLI without VS Code. Its optional **VSPiLink** extension
ships a graphical control surface plus the PiLink Node.js sidecar. The
recommended extension installer verifies the VSIX and provisions the exact
sidecar runtime when necessary. With Remote SSH, run it on the host that owns
the workspace, not the laptop displaying the VS Code window.

## Requirements

For the standalone CLI from source:

- Git;
- Node.js **24.18.0 exactly**;
- npm **11.16.0 exactly**;
- a trusted project folder.

For VSPiLink additionally:

- VS Code 1.106 or newer;
- a PiLink-managed or existing **Node.js 24.18.0 exactly** for the sidecar;
- for ChatGPT Work, a public HTTPS URL, a supported ChatGPT plan, and plugin
  permission from the relevant personal or organization workspace.

## Standalone CLI from source

Use this path when you want the PiLink CLI/server without installing VSPiLink:

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
node --version   # v24.18.0
npm --version    # 11.16.0
npm ci
npm run build
```

A normal `npm run build` compiles `dist/` and then tries to make `pilink`
available from an existing user-writable PATH directory inside your home. It
never uses `sudo`, edits a shell profile, or overwrites an unrelated command.

On Linux/macOS, source builds now use a small generated launcher with the
PiLink ownership marker `PILINK_GENERATED_SOURCE_LAUNCHER_V1` instead of a
fragile symlink into `dist/`. A later build can therefore safely rewrite the
launcher after the checkout is moved or re-cloned. Builds also migrate an old
PiLink symlink only when its target can be proven to be this checkout's
`dist/cli.js` or `dist/terminal-launcher.js`; arbitrary symlinks are left
untouched. On Windows, the equivalent generated `.cmd` shim remains
PiLink-marked and repairable.

Typical launcher locations are:

| Platform | Source checkout | User launcher | Private configuration/data |
| --- | --- | --- | --- |
| Linux | e.g. `~/Projects/PiLink` | commonly `~/.local/bin/pilink` when that directory already exists on `PATH` | `$XDG_CONFIG_HOME/pilink` or `~/.config/pilink` |
| Windows | e.g. `C:\Users\Alice\Projects\PiLink` | a safe writable user PATH directory containing `pilink.cmd` | `%USERPROFILE%\.config\pilink` by default |

If no eligible PATH directory exists, the build still succeeds and prints a
fallback. Run the built CLI directly from the checkout with, for example:

```bash
npm run cli -- start
npm run cli -- start --setup
npm run cli -- start --allow-unsafe-full-access
```

If you later add a user-owned bin directory to `PATH`, rerun `npm run build` to
create the persistent command. `PILINK_SKIP_CLI_LINK=1 npm run build` performs
a build without touching any user launcher.

Development commands deliberately do not have the same side effects:

```bash
npm run dev          # TypeScript compile/watch only; does not start PiLink
npm run dev:server   # explicitly run the raw src/index.ts development server
```

Use `pilink start` (or `npm run cli -- start`) for the normal guided runtime.
Use `npm run dev:server` only when you intentionally want the raw development
server. Run `npm run build` when you need to refresh/repair the `pilink`
launcher after updating or moving a source checkout.

## Recommended release installer

Use the installer included with the release bundle. It:

- locates `release/vspilink-2.2.0.vsix`;
- verifies the release integrity metadata;
- uses an existing exact Node.js 24.18.0 when safe, or downloads the pinned
  official Node.js archive and verifies its SHA-256 before installing it into a
  private per-user PiLink directory;
- does not require `sudo` and does not replace the system Node;
- installs the VSIX through the selected VS Code CLI;
- verifies that `0xfunboy.vspilink@2.2.0` is installed.

Linux or macOS, from the unpacked release directory:

```bash
./install.sh
```

Windows PowerShell, from the unpacked release directory:

```powershell
.\install.ps1
```

Keep `SHA256SUMS` beside the installer and VSIX. The installer fails closed if
the manifest is missing, malformed, or does not match. The only bypass is
`VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1`; it is intended solely for a
local development VSIX that you built and reviewed yourself, never for a
downloaded or customer release.

After the installer succeeds:

1. Return to VS Code.
2. Open the Command Palette with `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS).
3. Select **Developer: Reload Window** and press Enter.
4. If the right sidebar is hidden, select **View -> Appearance -> Secondary
   Side Bar**.
5. Select the **VSPiLink** view in the Secondary Side Bar.

If the VS Code CLI is missing, open the Command Palette and run **Shell
Command: Install 'code' command in PATH** where that command is available,
then rerun the installer.

The managed runtime is installed under the user's application-data directory:

- Linux/macOS: `$XDG_DATA_HOME/vspilink/node-v24.18.0` when
  `XDG_DATA_HOME` is set, otherwise `~/.local/share/vspilink/node-v24.18.0`;
- Windows: `%LOCALAPPDATA%\VSPiLink\node-v24.18.0`.

It does not change the developer's default `node` or `npm` command.

## Manual VSIX fallback

If you deliberately install a VSIX without the managed installer, first check
that an exact sidecar runtime is available:

```bash
node --version
```

The output must be `v24.18.0`. If multiple Node installations exist, configure
**VSPiLink: Node Executable** in VS Code to the exact binary.

1. Open VS Code.
2. Select **Extensions** in the Activity Bar.
3. Open the Extensions view's **…** menu.
4. Select **Install from VSIX…**.
5. Select the VSPiLink `.vsix` file.
6. Reload the window when VS Code asks.
7. Open the folder that VSPiLink should access.
8. Select **View -> Appearance -> Secondary Side Bar** if it is hidden, then
   select the **VSPiLink** view.

Do not download a VSIX from an untrusted mirror. A commercial distribution
should be signed and published through a documented release channel; the
current repository does not claim that a Marketplace listing is already
available.

## Build and install VSPiLink from source

This is the developer path for the optional extension. Verify both pinned
versions:

```bash
node --version   # v24.18.0
npm --version    # 11.16.0
```

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
node --version
npm --version
npm ci
npm run vscode:install
```

`npm run vscode:install` builds the core and extension, creates the VSIX, and
installs it into the profile reached by the `code` command. Core/VSIX build
paths use `build:core`, so packaging does not create or modify a user-level CLI
launcher as a side effect.

The source-tree installer paths are `./install/install.sh` and
`.\install\install.ps1`. They expect a complete staged release under
`release/`, including `SHA256SUMS`; for normal source development, prefer
`npm run vscode:install`.

To package without installing:

```bash
npm run vscode:package
```

## Remote SSH

VSPiLink is a workspace extension. In an SSH window:

1. Connect to the remote host with VS Code Remote SSH.
2. Open the remote project folder.
3. Run the release installer from the remote integrated terminal, or install
   or enable VSPiLink **on the SSH host** when prompted.
4. Let the installer provision managed Node.js 24.18.0, or set the remote
   `vspilink.nodeExecutable` value to an existing exact runtime.
5. Configure the tunnel or reverse proxy on that host.

The Integrated Browser is rendered by the local VS Code client, while the
sidecar, workspace, credentials, and public endpoint belong to the remote
host. Keep that distinction in mind when diagnosing paths or network access.

## First launch

1. Open the actual project folder, not an unrelated parent directory, unless
   broad parent-directory access is intentional.
2. Review VS Code Workspace Trust. Trust only code you understand because
   build and test scripts may execute repository code.
3. Choose the core runtime in [Runtime mode selection](operations/mode-selection.md):
   **Single agent** for the classic harness or **Collaborative public chat**
   for chat/tasks/work-loop/memory and supervised child agents.
4. Open VSPiLink and select **ChatGPT MCP** for the remote workflow or
   **Pi Local** for a separately configured provider. This surface choice is
   independent of the core runtime mode.
5. Follow [Connect ChatGPT Work](CONNECT_CHATGPT.md) or configure Pi Local.

Private state normally belongs outside the workspace. Do not place OAuth
clients, refresh tokens, tunnel credentials, agent chat, task data, or audit
logs in a repository.

The sanitized [illustrated setup walkthrough](ILLUSTRATED_GUIDE.md) shows the
install, Work plugin, OAuth, and monitoring screens without exposing real
paths, domains, codes, or credentials.

## Hosting prerequisites

ChatGPT Work must reach an HTTPS endpoint. PiLink supports:

| Mode | Intended use | URL stability |
| --- | --- | --- |
| Existing HTTPS domain | Operator-managed reverse proxy | Stable |
| Cloudflare Named Tunnel | Regular remote use | Stable |
| Cloudflare Quick Tunnel | Temporary evaluation | Changes after restart |
| Local only | Pi Local or same-machine clients | Not reachable by ChatGPT web |
| `nip.io` direct HTTPS | Legacy IPv4/router deployments | Depends on public IPv4 |

Prefer a stable endpoint for regular use. Quick Tunnel is a test mechanism;
when its hostname changes, OAuth metadata and the plugin connection refer to a
different origin.

Cloudflare credentials are provisioning inputs. They must remain private and
must never be embedded in the extension package, repository, prompt, or public
service unit.

### Verified hosting helper downloads

On Linux x64 and arm64, the standalone CLI can provision missing hosting
helpers without trusting an unversioned download:

- `cloudflared` **2026.7.2** is downloaded from the matching official
  Cloudflare GitHub release asset;
- Caddy **2.11.4** is downloaded from the matching official Caddy GitHub
  release archive when the legacy direct `nip.io` mode needs it;
- each supported architecture has a pinned SHA-256 in the PiLink release;
- the digest is verified before the binary is installed or executed;
- remote downloads and redirects must remain HTTPS. Plain HTTP is accepted
  only from loopback for local automated tests.

An operator may use a controlled mirror, but each override is an inseparable
URL/digest pair:

```dotenv
PI_CLOUDFLARED_URL=https://mirror.example/cloudflared
PI_CLOUDFLARED_SHA256=<64-lowercase-hex-characters>
PI_CADDY_URL=https://mirror.example/caddy.tar.gz
PI_CADDY_SHA256=<64-lowercase-hex-characters>
```

Supplying only the URL or only the digest fails closed. These four values are
download location and integrity metadata, not authentication secrets; they do
not belong in SecretStorage and are not redacted as credentials. An internal
mirror URL may still reveal private network topology, so organizations may
choose to keep it out of public examples and diagnostics. Tunnel tokens,
Cloudflare certificates, API tokens, and other credentials remain secrets.

For an operator-installed binary, set `PI_CLOUDFLARED_PATH` or `PI_CADDY_PATH`
to an executable you manage. Unsupported platforms and architectures require
that manual path instead of weakening download verification.

## Optional Textual monitor

The VS Code dashboard does not require Python. The preserved `pilink chat`
terminal monitor uses Python and Textual 0.51.x:

```bash
python3 -m pip install "textual>=0.51,<0.52"
pilink chat
```

## Upgrade

Before upgrading:

1. Stop the extension-owned or CLI-owned runtime.
2. Back up the private configuration and data directory with their file modes
   preserved.
3. Install the new VSIX or update the source checkout.
4. Run `npm ci && npm run build && npm run test:all` when upgrading from a
   source checkout; the build also refreshes/repairs the user CLI launcher.
5. Start once and verify local health, the public endpoint, OAuth discovery,
   and a read-only MCP action before allowing writes.

Do not run an old CLI instance and a new extension instance against the same
configuration at the same time.

## Uninstall and revoke

Removing the VSIX does not automatically revoke a remote OAuth client or delete
private data. A complete offboarding sequence is:

1. Remove or disable the PiLink plugin in ChatGPT Work.
2. Disable or delete its OAuth client locally.
3. Stop the PiLink runtime and public tunnel.
4. Disable only service units created and owned by PiLink.
5. Uninstall the extension.
6. Optionally remove PiLink private state after making any required backup.

Repository and workspace files are not generated state and must never be
removed by an uninstall/reset operation.
