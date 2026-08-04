#!/bin/sh

set -eu

EXPECTED_NODE_VERSION="v24.18.0"
EXTENSION_ID="0xfunboy.vspilink"
NODE_DOWNLOAD_BASE="https://nodejs.org/dist/v24.18.0"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail() {
  printf 'VSPiLink installer: %s\n' "$1" >&2
  exit 1
}

find_vsix() {
  if [ -n "${VSPILINK_VSIX:-}" ]; then
    [ -f "$VSPILINK_VSIX" ] || fail "VSPILINK_VSIX does not point to a file."
    printf '%s\n' "$VSPILINK_VSIX"
    return
  fi

  found=""
  count=0
  for candidate in "$SCRIPT_DIR"/vspilink-*.vsix "$SCRIPT_DIR"/../release/vspilink-*.vsix; do
    [ -f "$candidate" ] || continue
    candidate_directory=$(CDPATH= cd -- "$(dirname -- "$candidate")" && pwd)
    candidate="$candidate_directory/$(basename -- "$candidate")"
    [ "$found" = "$candidate" ] && continue
    found="$candidate"
    count=$((count + 1))
  done

  [ "$count" -eq 1 ] || fail "expected exactly one bundled release/vspilink-<version>.vsix; found $count."
  printf '%s\n' "$found"
}

find_node() {
  data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
  managed_node="$data_home/vspilink/node-v24.18.0/bin/node"
  if [ -x "$managed_node" ]; then
    printf '%s\n' "$managed_node"
    return
  fi
  command -v node 2>/dev/null || true
}

find_code() {
  if [ -n "${VSCODE_CLI:-}" ]; then
    [ -x "$VSCODE_CLI" ] || fail "VSCODE_CLI is not executable."
    printf '%s\n' "$VSCODE_CLI"
    return
  fi

  for command_name in code code-insiders; do
    command_path=$(command -v "$command_name" 2>/dev/null || true)
    if [ -n "$command_path" ]; then
      printf '%s\n' "$command_path"
      return
    fi
  done

  for app_cli in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"; do
    if [ -x "$app_cli" ]; then
      printf '%s\n' "$app_cli"
      return
    fi
  done
}

sha256_file() {
  target=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$target" | awk '{print tolower($NF)}'
  else
    fail "SHA-256 verification is required, but sha256sum, shasum, and openssl are unavailable."
  fi
}

bootstrap_managed_node() {
  [ "${VSPILINK_SKIP_NODE_BOOTSTRAP:-0}" != "1" ] || fail "exact Node.js is unavailable and managed runtime bootstrap was disabled with VSPILINK_SKIP_NODE_BOOTSTRAP=1."
  command -v curl >/dev/null 2>&1 || fail "curl is required to download the verified Node.js runtime."
  command -v tar >/dev/null 2>&1 || fail "tar is required to unpack the verified Node.js runtime."

  operating_system=$(uname -s)
  machine=$(uname -m)
  case "$operating_system:$machine" in
    Linux:x86_64|Linux:amd64)
      node_platform="linux-x64"
      archive_extension="tar.xz"
      expected_archive_sha="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
      extract_flag="-xJf"
      ;;
    Linux:aarch64|Linux:arm64)
      node_platform="linux-arm64"
      archive_extension="tar.xz"
      expected_archive_sha="58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"
      extract_flag="-xJf"
      ;;
    Darwin:x86_64|Darwin:amd64)
      node_platform="darwin-x64"
      archive_extension="tar.gz"
      expected_archive_sha="dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080"
      extract_flag="-xzf"
      ;;
    Darwin:arm64|Darwin:aarch64)
      node_platform="darwin-arm64"
      archive_extension="tar.gz"
      expected_archive_sha="e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1"
      extract_flag="-xzf"
      ;;
    *) fail "automatic Node.js bootstrap does not support $operating_system/$machine." ;;
  esac

  archive_name="node-v24.18.0-$node_platform.$archive_extension"
  source_url="$NODE_DOWNLOAD_BASE/$archive_name"
  temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/vspilink-node.XXXXXX") || fail "could not create a private temporary directory."
  cleanup_bootstrap() {
    if [ -n "${temporary_directory:-}" ] && [ -d "$temporary_directory" ]; then
      rm -rf -- "$temporary_directory"
    fi
  }
  trap cleanup_bootstrap EXIT
  trap 'exit 130' HUP INT TERM

  archive_path="$temporary_directory/$archive_name"
  printf 'Downloading verified Node.js runtime from %s\n' "$source_url" >&2
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$archive_path" "$source_url" \
    || fail "Node.js download failed."
  actual_archive_sha=$(sha256_file "$archive_path")
  [ "$actual_archive_sha" = "$expected_archive_sha" ] || fail "downloaded Node.js archive failed pinned SHA-256 verification."

  tar "$extract_flag" "$archive_path" -C "$temporary_directory" || fail "verified Node.js archive could not be extracted."
  extracted_directory="$temporary_directory/node-v24.18.0-$node_platform"
  [ -x "$extracted_directory/bin/node" ] || fail "verified Node.js archive has an unexpected layout."
  extracted_version=$("$extracted_directory/bin/node" --version 2>/dev/null || true)
  [ "$extracted_version" = "$EXPECTED_NODE_VERSION" ] || fail "verified archive did not contain Node.js $EXPECTED_NODE_VERSION."

  data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
  managed_parent="$data_home/vspilink"
  managed_root="$managed_parent/node-v24.18.0"
  mkdir -p "$managed_parent" || fail "could not create $managed_parent."
  if [ -e "$managed_root" ]; then
    backup_path="$managed_root.backup.$(date +%Y%m%d%H%M%S).$$"
    mv "$managed_root" "$backup_path" || fail "existing managed runtime could not be preserved at $backup_path."
    printf 'Preserved the previous managed runtime at %s\n' "$backup_path" >&2
  fi
  mv "$extracted_directory" "$managed_root" || fail "verified Node.js runtime could not be installed at $managed_root."
  managed_node="$managed_root/bin/node"
  installed_version=$("$managed_node" --version 2>/dev/null || true)
  [ "$installed_version" = "$EXPECTED_NODE_VERSION" ] || fail "managed Node.js verification failed after installation."

  printf 'Installed verified Node.js %s at %s\n' "$installed_version" "$managed_node" >&2
  printf '%s\n' "$managed_node"
}

verify_checksum() {
  target=$1
  checksum_file=$(dirname -- "$target")/SHA256SUMS
  [ -f "$checksum_file" ] || {
    if [ "${VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL:-0}" = "1" ]; then
      printf '%s\n' \
        'WARNING: SHA256SUMS is missing.' \
        'Continuing only because VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1.' \
        'Use this override only for a local development VSIX that you built and reviewed yourself.' >&2
      return
    fi
    fail "SHA256SUMS is required beside the VSIX. Refusing an unverified install. For a local development build only, set VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1."
  }

  filename=$(basename -- "$target")
  expected=$(awk -v wanted="$filename" '
    NF >= 2 {
      name = $2
      sub(/^\*/, "", name)
      if (name == wanted) print tolower($1)
    }
  ' "$checksum_file")

  lines=$(printf '%s\n' "$expected" | awk 'NF { count += 1 } END { print count + 0 }')
  [ "$lines" -eq 1 ] || fail "SHA256SUMS must contain exactly one entry for $filename."
  printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "invalid SHA-256 entry for $filename."

  actual=$(sha256_file "$target")
  [ "$actual" = "$expected" ] || fail "checksum verification failed for $filename."
  printf 'Checksum verified: %s\n' "$filename"
}

node_cli=$(find_node)
actual_node_version=""
if [ -n "$node_cli" ]; then
  actual_node_version=$("$node_cli" --version 2>/dev/null || true)
fi
if [ "$actual_node_version" != "$EXPECTED_NODE_VERSION" ]; then
  if [ -n "$node_cli" ]; then
    printf 'Found %s at %s; VSPiLink requires %s exactly. Installing a verified per-user runtime.\n' "${actual_node_version:-an unreadable Node.js}" "$node_cli" "$EXPECTED_NODE_VERSION" >&2
  else
    printf 'Node.js %s was not found. Installing a verified per-user runtime.\n' "$EXPECTED_NODE_VERSION" >&2
  fi
  node_cli=$(bootstrap_managed_node)
  actual_node_version=$("$node_cli" --version 2>/dev/null || true)
fi
[ "$actual_node_version" = "$EXPECTED_NODE_VERSION" ] || fail "Node.js exact-version verification failed."
printf 'Node.js verified: %s\n' "$actual_node_version"

vsix=$(find_vsix)
vsix_name=$(basename -- "$vsix")
case "$vsix_name" in
  vspilink-*.vsix) extension_version=${vsix_name#vspilink-}; extension_version=${extension_version%.vsix} ;;
  *) fail "unexpected VSIX filename: $vsix_name" ;;
esac
printf '%s' "$extension_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$' || fail "cannot determine a safe version from $vsix_name."

verify_checksum "$vsix"

code_cli=$(find_code)
[ -n "$code_cli" ] || fail "VS Code CLI was not found. In VS Code press Ctrl+Shift+P (macOS: Cmd+Shift+P), run 'Shell Command: Install code command in PATH', then run this installer again."
printf 'VS Code CLI: %s\n' "$code_cli"

if [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
  printf '%s\n' \
    'Remote-SSH detected. When this script runs in the VS Code remote integrated terminal, the CLI should install VSPiLink into that remote extension host.' \
    'After installation, open Extensions and verify VSPiLink says "Installed on SSH: <host>". If it appears only under Local, use the extension gear menu and choose "Install in SSH: <host>".'
fi

"$code_cli" --install-extension "$vsix" --force >/dev/null || fail "VS Code rejected the VSIX installation."

installed=$($code_cli --list-extensions --show-versions 2>/dev/null || true)
printf '%s\n' "$installed" | grep -Fxi "$EXTENSION_ID@$extension_version" >/dev/null || fail "installation returned success, but $EXTENSION_ID@$extension_version was not reported by the selected VS Code CLI."

printf '%s\n' \
  "Installed and verified: $EXTENSION_ID@$extension_version" \
  'Final required click: return to VS Code, press Ctrl+Shift+P (macOS: Cmd+Shift+P), select "Developer: Reload Window", and press Enter.' \
  'With Remote-SSH, reload the remote VS Code window and re-check that VSPiLink is installed on the SSH host.'
