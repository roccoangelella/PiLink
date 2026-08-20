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

## Automatic VS Code graphical bootstrap

Selecting **VS Code graphical** from `pilink start`, or running
`pilink start --mode vscode`, checks the VS Code profile reached by the selected
`code` command for the matching PiLink extension version. If it is missing or
outdated, PiLink uses a matching local release VSIX when available; otherwise it
downloads the exact versioned VSIX and `SHA256SUMS` from the corresponding
PiLink GitHub release, verifies the SHA-256, installs the extension, verifies the
installed version, and opens the project.

After this one-time bootstrap, use the PiLink Activity Bar view or the
**PiLink: Start PiLink**, **PiLink: Stop PiLink**, and **PiLink: Restart PiLink**
commands for normal session lifecycle control. The CLI is not required for each
VS Code session. For an offline/reviewed local build, `PI_VSCODE_VSIX_PATH` may
point to a trusted local VSIX.

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
3. select **PiLink** in the Activity Bar.

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
6. select **PiLink** in the Activity Bar.

If several Node installations exist, set **PiLink: Node Executable** to the
exact 24.18.0 binary.

Do not install a VSIX from an untrusted mirror.

## First launch

The current VS Code flow fixes the server/access policy and asks only how PiLink
should be reached.

1. Open the actual project folder, not a broad parent directory unless that
   broader access is intentional.
2. Review VS Code Workspace Trust.
3. Open **PiLink**.
4. Choose one endpoint path:
   - **Set up stable endpoint** — recommended for ChatGPT; choose a Cloudflare
     fixed domain or an existing HTTPS domain/reverse proxy;
   - **Temporary quick start** — Cloudflare Quick Tunnel for evaluation;
   - **Local only** — no public endpoint.
5. Every graphical setup writes **Single agent** and **Project-folder** access.
6. When a public endpoint is ready, select **Connect ChatGPT** and follow
   [Connect ChatGPT Work](CONNECT_CHATGPT.md).

The graphical flow does not offer collaboration, Full access, provider/model
setup, native VS Code MCP, or manual OAuth registration.

## Graphical hosting choices

| Hosting | Intended use | URL stability |
| --- | --- | --- |
| Cloudflare fixed domain | Recommended regular remote use | Stable |
| Existing HTTPS domain | Operator-managed reverse proxy | Stable |
| Cloudflare Quick Tunnel | Temporary evaluation | Changes when recreated |
| Local only | Same-machine clients | Not reachable by ChatGPT web |

The stable path is primary because OAuth/plugin configuration is easier to keep
when the public origin does not change.

For Cloudflare fixed-domain provisioning, the extension asks for a scoped API
token with the documented tunnel/DNS permissions, passes it only to the
provisioning command, and does not save that API token. The generated private
tunnel-token file is stored outside the workspace and referenced by the private
PiLink configuration.

The core PiLink CLI retains additional legacy hosting modes, including managed
Named-Tunnel and `nip.io` paths, but the simplified VS Code launcher does not
own those services.

## Reconfiguration

Use **Details & recovery -> Reconfigure endpoint...** or **PiLink: Reconfigure
PiLink**. The graphical reconfiguration choices are the same safe endpoint
families: fixed Cloudflare domain, existing HTTPS domain, Quick Tunnel, or
local-only.

Reconfiguration always reapplies Single agent and Project-folder access. It is
also the safe migration path when the launcher detects a saved Full-access
configuration.

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
the same configuration/port at the same time. The launcher refuses to take
ownership of a PiLink process already running outside the current VS Code
session.

## Specialist core features

No Python or model-provider credential is required to use the extension as a
PiLink launcher.

Provider-backed agents, collaboration services, manual OAuth client management,
Full access, and legacy service hosting remain core PiLink CLI/operator
capabilities where appropriate. They are not separate products in the current
VS Code extension.

The optional `pilink chat` terminal monitor is for the collaboration workflow
and requires its own Python/Textual environment when deliberately used.

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
