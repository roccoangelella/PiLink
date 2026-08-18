# Installation

PiLink can run from the CLI without VS Code. The optional PiLink VS Code
extension starts and manages the same PiLink server for the project open in the
editor.

## Requirements

For a source checkout:

- Git;
- Node.js **24.18.0 exactly**;
- npm **11.16.0 exactly**;
- a project folder you are willing to trust.

For the VS Code extension additionally:

- VS Code 1.106 or newer;
- the PiLink sidecar running with Node.js **24.18.0 exactly**;
- for remote ChatGPT use, a reachable HTTPS endpoint and permission to use the
  relevant ChatGPT Work plugin.

## Standalone CLI from source

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
node --version   # v24.18.0
npm --version    # 11.16.0
npm ci
npm run build
```

`npm run build` compiles the core and attempts to make the `pilink` command
available from an existing user-writable directory already on `PATH`. It never
uses `sudo`, edits a shell profile, or overwrites an unrelated command.

On Linux/macOS the generated launcher is marked with
`PILINK_GENERATED_SOURCE_LAUNCHER_V1`, so a later build can safely repair a
launcher created by this checkout. On Windows the generated `.cmd` shim is
likewise PiLink-owned and repairable.

If no eligible user-owned `PATH` directory exists, the build still succeeds.
Use the built CLI directly:

```bash
npm run cli -- start
npm run cli -- start --setup
```

If you later add a user-owned bin directory to `PATH`, rerun `npm run build`.
Set `PILINK_SKIP_CLI_LINK=1` when you explicitly want a build that does not
create or repair a launcher.

Development commands are separate:

```bash
npm run dev          # compile/watch only
npm run dev:server   # run the raw development server
```

For ordinary use, prefer `pilink start` or `npm run cli -- start`.

## Recommended VS Code release install

Use the installer shipped in a release bundle. It verifies the release
integrity metadata, installs the VSIX, and provisions the exact sidecar Node.js
runtime when necessary without replacing the system Node installation.

Linux/macOS:

```bash
./install.sh
```

Windows PowerShell:

```powershell
.\install.ps1
```

Keep `SHA256SUMS` beside the installer and VSIX. The installer fails closed if
the manifest is missing, malformed, or does not match the release contents.

`VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1` exists only for a local VSIX
you built and reviewed yourself. Do not use it for downloaded release files.

After installation:

1. return to VS Code;
2. run **Developer: Reload Window**;
3. open **View -> Appearance -> Secondary Side Bar** when the right sidebar is
   hidden;
4. open the **PiLink** view.

The managed runtime lives in user application data, not in the system Node
installation:

- Linux/macOS: `$XDG_DATA_HOME/vspilink/node-v24.18.0` or
  `~/.local/share/vspilink/node-v24.18.0`;
- Windows: `%LOCALAPPDATA%\VSPiLink\node-v24.18.0`.

## Build and install the VS Code extension from source

From the repository root, with the exact Node/npm versions:

```bash
npm ci
npm run vscode:install
```

That builds the core and extension, packages the VSIX, and installs it into the
VS Code profile reached by the `code` command.

To package without installing:

```bash
npm run vscode:package
```

The extension packaging path uses `build:core`; it does not create or repair a
user-level CLI launcher as a packaging side effect.

## Manual VSIX fallback

If you deliberately install a VSIX without the release installer:

1. verify `node --version` is exactly `v24.18.0` on the host that will run the
   sidecar;
2. open **Extensions** in VS Code;
3. use **Install from VSIX...**;
4. reload the window;
5. open the project PiLink should access;
6. open the **PiLink** view in the Secondary Side Bar.

If several Node installations exist, set **PiLink: Node Executable** to the
exact 24.18.0 binary.

Do not install a VSIX from an untrusted mirror.

## First launch

The redesigned first run does not ask you to understand PiLink's internal
workflow modes before starting the bridge.

1. Open the actual project folder, not a broad parent directory unless that
   broader access is intentional.
2. Review VS Code Workspace Trust.
3. Open **PiLink**.
4. Choose an ordinary safe launch action:
   - **Quick start for ChatGPT** — Single agent, Project-folder access, and a
     temporary Cloudflare HTTPS endpoint;
   - **Local only** — Single agent and Project-folder access without a public
     endpoint.
5. When a public endpoint is ready, select **Connect ChatGPT** and follow
   [Connect ChatGPT Work](CONNECT_CHATGPT.md).

Fresh ordinary graphical configurations use **Single agent** and
**Project-folder** access automatically. Full access, collaboration, and model
provider setup are not normal first-run choices.

For a durable domain or other specialist configuration, deliberately enter
**Advanced setup...**. That retained compatibility flow supports stable and
legacy hosting and can expose additional workflow/access choices. Review those
choices explicitly and keep **Project folder only** unless broader authority is
actually intended.

## Hosting choices

| Hosting | Intended use | URL stability |
| --- | --- | --- |
| Existing HTTPS domain | Operator-managed reverse proxy | Stable |
| Cloudflare fixed/Named Tunnel | Regular remote use | Stable |
| Cloudflare Quick Tunnel | Temporary evaluation | Changes when recreated |
| Local only | Same-machine clients | Not reachable by ChatGPT web |
| `nip.io` direct HTTPS | Legacy IPv4/router deployment | Environment-dependent |

Quick start uses the temporary option because it is the shortest safe setup.
For regular use, enter Advanced setup deliberately and choose a stable endpoint.
Recreating a Quick Tunnel changes the public origin, so clients configured with
the old URL must be updated.

Cloudflare credentials are provisioning inputs. Keep them out of the
repository, prompts, logs, screenshots, and extension package.

## Verified hosting helper downloads

Where automatic helper installation is supported, PiLink pins official helper
versions and verifies SHA-256 before execution. Remote downloads and redirects
must stay on HTTPS.

An operator-controlled mirror must supply both the URL and the independently
verified digest:

```dotenv
PI_CLOUDFLARED_URL=https://mirror.example/cloudflared
PI_CLOUDFLARED_SHA256=<64-lowercase-hex-characters>
PI_CADDY_URL=https://mirror.example/caddy.tar.gz
PI_CADDY_SHA256=<64-lowercase-hex-characters>
```

Supplying only one half of a URL/digest pair fails closed.

For an operator-installed binary, set `PI_CLOUDFLARED_PATH` or `PI_CADDY_PATH`
to the reviewed executable.

## Remote SSH

The PiLink extension is a workspace extension. In Remote SSH, the workspace and
PiLink sidecar belong on the remote host even though the VS Code UI is displayed
on your local computer.

1. connect with VS Code Remote SSH;
2. open the remote project;
3. install/enable the PiLink extension on the SSH host;
4. ensure the remote sidecar has Node.js 24.18.0 exactly;
5. configure hosting on that host;
6. complete browser/OAuth steps in the browser presented by the local VS Code
   client.

Do not run a CLI-owned PiLink process and an extension-owned process against
the same configuration/port at the same time.

## Specialist compatibility features

No Python or model-provider credential is required merely to use the extension
as a graphical PiLink launcher.

The backend still retains local provider/agent support, collaboration services,
native VS Code MCP compatibility, and manual OAuth paths for existing/operator
workflows, but the normal dashboard does not promote them as separate products.
Use the relevant CLI or deliberately enter a compatibility flow only when you
need that capability.

The optional `pilink chat` terminal monitor is for the collaboration workflow
and requires its own Python/Textual environment when you deliberately use it.

## Private state

PiLink private state normally belongs outside the project folder. Do not place
OAuth clients, refresh-token state, tunnel credentials, provider credentials,
collaboration data, or audit stores in the repository.

See [Security model](SECURITY_MODEL.md) before changing execution or access
policy.

## Upgrade

Before upgrading:

1. stop the extension-owned or CLI-owned runtime;
2. back up private PiLink configuration/data with file modes preserved;
3. install the new VSIX or update the source checkout;
4. for source updates run `npm ci && npm run build && npm run test:all`;
5. start PiLink and verify local health, the public endpoint, OAuth readiness,
   and a read-only MCP action before allowing writes.

A source `npm run build` also refreshes/repairs the generated user CLI launcher
when an eligible `PATH` directory is available.

## Uninstall and revoke

Removing the extension does not revoke an OAuth client or delete PiLink private
state. For complete offboarding:

1. remove/disable the PiLink plugin at the remote client;
2. disable or delete its local OAuth client;
3. stop the PiLink runtime and tunnel;
4. disable only service units owned by PiLink;
5. uninstall the PiLink VS Code extension;
6. remove private PiLink state only after any required backup.

Never treat project/workspace files as disposable PiLink generated state.
