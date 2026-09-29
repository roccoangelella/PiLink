# Install PiLink for VS Code

Keep every downloaded file in this directory. In particular, do not separate
the installer, `vspilink-*.vsix`, and `SHA256SUMS`: the installer refuses to
install a VSIX whose release checksum cannot be verified.

The release installer does not require administrator privileges and does not
replace the system `node` command. When necessary, it downloads the pinned
official Node.js 24.18.0 archive, verifies its built-in SHA-256, and installs it
under PiLink's private per-user data directory.

## Linux or macOS

1. Open a terminal in this directory.
2. Run:

   ```bash
   ./install.sh
   ```

3. If the shell reports that the file is not executable, run
   `chmod u+x ./install.sh` and repeat the command.

## Windows PowerShell

1. Open PowerShell in this directory.
2. Run:

   ```powershell
   .\install.ps1
   ```

3. If Windows has marked the downloaded script as blocked, inspect its origin
   and checksum first, then run `Unblock-File .\install.ps1` and repeat the
   command.

## First launch in VS Code

1. Return to VS Code and run **Developer: Reload Window**.
2. Open the exact project PiLink may access and review **Workspace Trust**.
3. Select **PiLink** in the Activity Bar.
4. Choose the endpoint that matches your use:
   - **Set up stable endpoint** for regular remote ChatGPT Work use with an
     HTTPS origin you control;
   - **Temporary quick start** for a public Quick Tunnel used for evaluation;
   - **Local only** for same-machine MCP clients. Remote ChatGPT Work cannot
     reach this endpoint.
5. For remote ChatGPT Work, make sure your ChatGPT workspace already provides
   the intended private PiLink plugin or allows you to create/import it. PiLink
   cannot grant those ChatGPT workspace controls.
6. When a public HTTPS endpoint is ready, select **Connect ChatGPT**.
7. Complete local owner verification first, then complete OAuth for the
   intended private PiLink plugin.
8. Start with a read-only task that confirms the selected project before
   allowing edits or repository execution.

Fresh graphical setup uses **Single agent** and **Project-folder** access.
Collaboration, Full access, manual OAuth-client management, provider-backed
agents, and legacy hosting remain explicit CLI/operator concerns.

## Remote SSH

In a Remote SSH window, the project, PiLink extension host, sidecar runtime,
and hosting process belong on the **remote SSH host**. Run this release installer
from the **remote VS Code integrated terminal**, then reload the window and
verify the extension is installed on the SSH host.

The VS Code desktop UI and the browser used for owner verification/OAuth remain
on the local UI machine. Do not install only on the local machine and expect it
to control a remote workspace.

## Development-only checksum override

`VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1` permits installation when
`SHA256SUMS` is absent. This escape hatch is only for a local VSIX that you
built and reviewed yourself. Never use it for a downloaded bundle, customer
installation, CI release, or production deployment.

Current documentation:

- Getting started: <https://github.com/roccoangelella/PiLink/blob/main/docs/GETTING_STARTED.md>
- Installation and Remote SSH: <https://github.com/roccoangelella/PiLink/blob/main/docs/INSTALLATION.md>
- Connect ChatGPT Work: <https://github.com/roccoangelella/PiLink/blob/main/docs/CONNECT_CHATGPT.md>
- Illustrated walkthrough: <https://github.com/roccoangelella/PiLink/blob/main/docs/ILLUSTRATED_GUIDE.md>
