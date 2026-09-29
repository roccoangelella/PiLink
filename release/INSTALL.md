# Install PiLink's optional VSPiLink extension bundle

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
   and signature/checksum first, then run `Unblock-File .\install.ps1` and
   repeat the command.

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
5. Select the **VSPiLink** view in the Secondary Side Bar.
6. Open the Command Palette and run **VSPiLink: Connect ChatGPT via MCP** to
   start the guided connection.

For Remote SSH, run this installer in the remote VS Code integrated terminal.
After the reload, open Extensions and verify that VSPiLink says **Installed on
SSH: _host_**. If it is installed only under Local, use the extension gear menu
and select **Install in SSH: _host_**.

## Development-only checksum override

`VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1` permits installation when
`SHA256SUMS` is absent. This escape hatch is only for a local VSIX that you
built and reviewed yourself. Never use it for a downloaded bundle, customer
installation, CI release, or production deployment.

Complete setup, hosting, OAuth, security, and troubleshooting documentation is
available at <https://github.com/roccoangelella/PiLink/tree/master/docs>. The
sanitized illustrated walkthrough is at
<https://github.com/roccoangelella/PiLink/blob/master/docs/ILLUSTRATED_GUIDE.md>.
