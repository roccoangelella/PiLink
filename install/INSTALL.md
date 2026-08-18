# Install PiLink's optional VS Code extension bundle

Keep every downloaded file in this directory. In particular, do not separate
the installer, `vspilink-*.vsix`, and `SHA256SUMS`: the installer refuses to
install a VSIX whose release checksum cannot be verified.

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

The installer does not require administrator privileges and does not replace
the system `node` command. When necessary, it downloads the pinned official
Node.js 24.18.0 archive, verifies its built-in SHA-256, and installs it under a
private per-user PiLink data directory.

## Final VS Code clicks

1. Return to VS Code.
2. Press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS).
3. Select **Developer: Reload Window** and press Enter.
4. If the right sidebar is hidden, select **View -> Appearance -> Secondary
   Side Bar**.
5. Open the **PiLink** view.
6. Open the project PiLink should access and review Workspace Trust.
7. Use the main PiLink card:
   - **Quick start for ChatGPT** for the simplest safe remote setup;
   - **Local only** when no public endpoint is needed.
8. When the public endpoint is ready, select **Connect ChatGPT** and complete
   the remote OAuth flow.

Fresh ordinary graphical setups use Single agent and Project-folder access by
default. If you deliberately need a stable domain, legacy hosting, or another
specialist configuration, use **Advanced setup...** and review the additional
workflow/access choices it may expose.

Collaboration, Full access, local model-provider execution, native VS Code MCP
compatibility, and manual OAuth registration are not presented as parallel
products in the normal launcher UI.

For Remote SSH, run this installer in the remote VS Code integrated terminal.
After the reload, open Extensions and verify that the extension says **Installed
on SSH: _host_**. If it is installed only under Local, use the extension gear
menu and select **Install in SSH: _host_**.

## Development-only checksum override

`VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1` permits installation when
`SHA256SUMS` is absent. This escape hatch is only for a local VSIX that you
built and reviewed yourself. Never use it for a downloaded bundle, customer
installation, CI release, or production deployment.

Complete setup, hosting, OAuth, security, and troubleshooting documentation is
available at <https://github.com/roccoangelella/PiLink/tree/master/docs>. The
sanitized illustrated walkthrough is at
<https://github.com/roccoangelella/PiLink/blob/master/docs/ILLUSTRATED_GUIDE.md>.
