import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const allowedDocumentationSections = new Set([
  "architecture",
  "archive",
  "decisions",
  "evaluation",
  "operations",
  "protocols",
  "reference",
  "research",
  "reviews",
  "security",
]);

function trackedMarkdownFiles() {
  return execFileSync("git", ["ls-files", "*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean).sort();
}

function localMarkdownTargets(file, contents) {
  const targets = [];
  const inline = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const reference = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const expression of [inline, reference]) {
    for (const match of contents.matchAll(expression)) {
      const raw = match[1];
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) continue;
      const withoutFragment = raw.split("#", 1)[0].split("?", 1)[0];
      if (!withoutFragment) continue;
      const decoded = decodeURIComponent(withoutFragment.replace(/^<|>$/g, ""));
      targets.push(path.resolve(repositoryRoot, path.dirname(file), decoded));
    }
  }
  return targets;
}

test("tracked documentation uses the purpose-based hierarchy", () => {
  const documentation = trackedMarkdownFiles().filter((file) => file.startsWith("docs/"));
  const rootMarkdown = documentation.filter((file) => path.posix.dirname(file) === "docs");
  assert.deepEqual(rootMarkdown, ["docs/README.md"],
    "docs/ must contain only its authority index; substantive documents belong in purpose folders");

  for (const file of documentation.filter((candidate) => candidate !== "docs/README.md")) {
    const parts = file.split("/");
    assert.equal(parts.length, 3, `${file} must be exactly one purpose folder below docs/`);
    assert.ok(allowedDocumentationSections.has(parts[1]), `${file} uses an unsupported documentation section`);
    assert.match(parts[2], /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
      `${file} must use a stable lowercase kebab-case filename`);
  }
});

test("the documentation authority index lists every tracked document exactly once", () => {
  const documentation = trackedMarkdownFiles()
    .filter((file) => file.startsWith("docs/") && file !== "docs/README.md");
  const indexPath = path.join(repositoryRoot, "docs/README.md");
  const index = fs.readFileSync(indexPath, "utf8");
  const inventoryStart = index.indexOf("## Document inventory");
  const inventoryEnd = index.indexOf("## Supersession and relationship summary");
  assert.ok(inventoryStart >= 0 && inventoryEnd > inventoryStart, "docs/README.md must contain a bounded inventory section");
  const inventory = index.slice(inventoryStart, inventoryEnd);
  const linked = localMarkdownTargets("docs/README.md", inventory)
    .map((target) => path.relative(repositoryRoot, target).split(path.sep).join("/"));

  for (const file of documentation) {
    assert.equal(linked.filter((target) => target === file).length, 1,
      `${file} must appear exactly once in docs/README.md`);
  }
});

test("tracked Markdown contains no broken local links", () => {
  for (const file of trackedMarkdownFiles()) {
    const contents = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    for (const target of localMarkdownTargets(file, contents)) {
      assert.ok(fs.existsSync(target), `${file} links to missing local target ${path.relative(repositoryRoot, target)}`);
    }
  }
});
