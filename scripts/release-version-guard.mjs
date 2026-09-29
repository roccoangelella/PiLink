import fs from "node:fs";
import path from "node:path";

const checksumLine = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u;

export function assertNoPinnedReleaseVersionCollision({
  releaseDirectory,
  packageName,
  extensionName,
  version,
}) {
  if (!fs.existsSync(releaseDirectory)) return;

  const manifestPath = path.join(releaseDirectory, "SHA256SUMS");
  const pinnedNames = new Set();
  if (fs.existsSync(manifestPath)) {
    for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/u).filter(Boolean)) {
      const match = line.match(checksumLine);
      if (!match) {
        throw new Error("refusing to replace a release directory with an unreadable SHA256SUMS manifest");
      }
      pinnedNames.add(match[2]);
    }
  }

  const versionedArtifacts = [
    `${packageName}-${version}.tgz`,
    `${packageName}-${version}.cdx.json`,
    `${extensionName}-${version}.vsix`,
  ];
  // An interrupted or incomplete stage may have versioned artifacts but no manifest yet.
  const collisions = versionedArtifacts.filter((name) =>
    pinnedNames.has(name) || fs.existsSync(path.join(releaseDirectory, name)));
  if (collisions.length > 0) {
    throw new Error(
      `refusing to replace existing release artifact(s) for version ${version}: ${collisions.join(", ")}`,
    );
  }
}
