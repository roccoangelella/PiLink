from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)

ext_path = Path("packages/vscode/src/extension.ts")
ext = ext_path.read_text(encoding="utf-8")
ext = replace_once(
    ext,
    '    const hosting = await this.collectHostingSelection(selected.value);\n',
    '    const hosting = await this.collectHostingSelection(selected.value, workspace);\n',
    "guided collector call",
)
ext = replace_once(
    ext,
    '  private async collectHostingSelection(\n    kind: Exclude<HostingSelection["kind"], "nip-io">,\n  ): Promise<HostingSelection | undefined> {\n',
    '  private async collectHostingSelection(\n    kind: Exclude<HostingSelection["kind"], "nip-io">,\n    workspace: string,\n  ): Promise<HostingSelection | undefined> {\n',
    "collector signature",
)
anchor = '''      const credential = await this.selectCloudflareCredential("tunnel-token-file");
      if (!credential) return undefined;
      const normalized = normalizeHostingSelection({
'''
insert = '''      const credential = await this.selectCloudflareCredential("tunnel-token-file");
      if (!credential) return undefined;
      const origin = `http://127.0.0.1:${this.snapshot(workspace).port}`;
      const routeReady = await vscode.window.showInformationMessage(
        `Configure the Cloudflare Published application route for ${new URL(publicUrl).hostname}.`,
        {
          modal: true,
          detail: `In Cloudflare, point the hostname to ${origin}. Keep this route and tunnel so the same /sse and OAuth URLs remain valid across PiLink restarts.`,
        },
        "Route is configured",
      );
      if (routeReady !== "Route is configured") return undefined;
      const normalized = normalizeHostingSelection({
'''
ext = replace_once(ext, anchor, insert, "fixed-domain route confirmation")
ext_path.write_text(ext, encoding="utf-8")

helper_path = Path("src/hosting/fixed-domain.ts")
helper = helper_path.read_text(encoding="utf-8")
helper = replace_once(
    helper,
    '  if (!trimmed || /[\\r\\n\\0]/u.test(trimmed)) throw new Error("Cloudflare tunnel token file path is invalid");\n',
    '  if (!trimmed || /[\\r\\n\\0#]/u.test(trimmed)) throw new Error("Cloudflare tunnel token file path is invalid or cannot be stored safely in PiLink configuration");\n',
    "token path config safety",
)
helper_path.write_text(helper, encoding="utf-8")

test_path = Path("test/fixed-domain-hosting.test.mjs")
test = test_path.read_text(encoding="utf-8")
anchor = '  assert.throws(() => normalizeFixedDomainTunnelId("not-a-tunnel"), /valid UUID/);\n'
test = replace_once(
    test,
    anchor,
    anchor + '  assert.throws(() => resolveFixedDomainTokenFile("/tmp/token#unsafe"), /cannot be stored safely/);\n',
    "unsafe token path test",
)
test_path.write_text(test, encoding="utf-8")
