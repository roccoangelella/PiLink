# Source CLI workflow and launcher recovery

Use this guide when running PiLink from a Git checkout rather than an installed
release package.

## What each npm command does

From the PiLink checkout:

| Command | Behavior |
| --- | --- |
| `npm ci` / `npm install` | Installs dependencies. It does not build PiLink or create/repair the user `pilink` launcher. |
| `npm run build` | Compiles PiLink and then safely creates or repairs the user-level `pilink` launcher when an eligible PATH directory exists. |
| `npm run dev` | Runs TypeScript compile/watch only. It does not start PiLink and does not create/repair the user launcher. |
| `npm run dev:server` | Explicitly starts the raw `src/index.ts` development server under `tsx watch`. |
| `npm run cli -- <args>` | Runs the built terminal launcher directly from the checkout without requiring a user PATH launcher. |
| `pilink start` | Normal guided PiLink startup after a successful build has exposed the command. |

For ordinary source installation or after pulling changes, use:

```bash
npm ci
npm run build
```

Do not use `npm run dev` as an installation step.

## Why the launcher lives outside the checkout

The source and the command have different jobs. The Git checkout contains the
code and can live anywhere. A shell can run `pilink` from any working directory
only when a small launcher is present in a directory already on `PATH`.

PiLink limits automatic launcher creation to an existing user-writable PATH
directory inside the user's home. A common Linux location is
`~/.local/bin/pilink`. Windows uses a generated `pilink.cmd` in a safe writable
user PATH directory.

Private PiLink configuration is separate again: it normally lives under
`~/.config/pilink` on Linux or `%USERPROFILE%\.config\pilink` on Windows. It is
not part of the launcher or source checkout.

## Repair `pilink: No such file or directory`

A shell error such as:

```text
bash: /home/ubuntu/.local/bin/pilink: No such file or directory
```

usually means the shell found an old launcher whose source target disappeared
or moved. Current source builds use a PiLink-marked POSIX launcher rather than
a fragile source-tree symlink, and `npm run build` can repair/repoint launchers
that PiLink can safely identify as its own.

On Linux/macOS, from the current checkout:

```bash
npm run build
hash -r
command -v pilink
pilink --help
```

On Windows PowerShell:

```powershell
npm run build
Get-Command pilink
pilink --help
```

If `npm run build` reports `CLI launcher repaired` or `CLI launcher updated`, no
manual removal is needed.

If the build reports that an existing `pilink` command **was not replaced**,
PiLink could not prove that the path belongs to this checkout. Inspect it before
deleting anything:

```bash
command -v pilink
ls -l "$(command -v pilink)"
```

Only remove the path manually when you have verified that it is a stale PiLink
launcher from a checkout you intentionally moved or deleted. Never remove an
unrelated command merely to make the build succeed. After removing a confirmed
stale PiLink launcher, rerun `npm run build`.

## If PiLink cannot create a PATH launcher

The build still succeeds when no safe user PATH directory is available. Use the
checkout-local CLI instead:

```bash
npm run cli -- start
npm run cli -- start --setup
npm run cli -- start --allow-unsafe-full-access
```

If you later add a user-owned bin directory to `PATH`, rerun `npm run build`.
PiLink will create the persistent launcher there. Set
`PILINK_SKIP_CLI_LINK=1` only when you intentionally want a source build with no
launcher changes.

## Raw server development

`npm run dev:server` is deliberately explicit because it starts the raw MCP
server directly from `src/index.ts`. It is intended for server development and
can read the existing PiLink environment/configuration. It is not a substitute
for the normal guided CLI workflow.

Use `pilink start` or `npm run cli -- start` when you want the normal launcher,
hosting setup, and CLI behavior.
