import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");

async function workflowFiles() {
  return (await fs.readdir(workflowsDirectory))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

test("GitHub Actions dependencies are pinned to immutable commits", async () => {
  const files = await workflowFiles();
  assert.ok(files.length >= 3, "expected CI, dependency review, and release workflows");

  for (const file of files) {
    const content = await fs.readFile(path.join(workflowsDirectory, file), "utf8");
    for (const match of content.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s*#.*)?$/gm)) {
      const [, action, reference] = match;
      if (action.startsWith("./")) continue;
      assert.match(reference, /^[0-9a-f]{40}$/i, `${file}: ${action} must use a full commit SHA`);
    }
  }
});

test("release publishing is OIDC-only and verifies its dependency chain", async () => {
  const release = await fs.readFile(path.join(workflowsDirectory, "release.yml"), "utf8");
  assert.match(release, /id-token:\s*write/);
  assert.match(release, /environment:\s*npm/);
  assert.match(release, /persist-credentials:\s*false/);
  assert.match(release, /npm ci --ignore-scripts --audit=false/);
  assert.match(release, /npm audit signatures/);
  assert.match(release, /npm audit --audit-level=moderate/);
  assert.match(release, /npm publish/);
  assert.match(release, /release\.tag_name/);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|npm[_-]?token/i);
});

test("security reports are directed to a private disclosure channel", async () => {
  const policy = await fs.readFile(path.join(repositoryRoot, ".github", "SECURITY.md"), "utf8");
  assert.match(policy, /Report a vulnerability/);
  assert.match(policy, /GitHub Security Advisories/);
  assert.match(policy, /Do not open a public issue containing vulnerability details/);
  assert.match(policy, /allow-unsafe-full-access/);
});

test("dependency automation covers npm packages and GitHub Actions", async () => {
  const dependabot = await fs.readFile(path.join(repositoryRoot, ".github", "dependabot.yml"), "utf8");
  assert.match(dependabot, /package-ecosystem:\s*npm/);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/);

  const review = await fs.readFile(path.join(workflowsDirectory, "dependency-review.yml"), "utf8");
  assert.match(review, /actions\/dependency-review-action@[0-9a-f]{40}/i);
  assert.match(review, /fail-on-severity:\s*moderate/);
});
