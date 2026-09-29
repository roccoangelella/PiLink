import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const entrypointDocs = [
  "README.md",
  "packages/vscode/README.md",
  "plugins/pilink/README.md",
  "install/INSTALL.md",
  "release/INSTALL.md",
];

function withoutFencedCode(markdown) {
  let fence = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*([\x60~]{3,})/u)?.[1];
      if (marker) {
        if (fence === null) {
          fence = { char: marker[0], length: marker.length };
        } else if (marker[0] === fence.char && marker.length >= fence.length) {
          fence = null;
        }
        return "";
      }
      return fence === null ? line : "";
    })
    .join("\n");
}

function withoutInlineCode(markdown) {
  return markdown.replace(/\x60+[^\x60\n]*\x60+/gu, "");
}

function markdownLinkTargets(markdown) {
  const visible = withoutInlineCode(withoutFencedCode(markdown));
  const targets = new Set();

  for (let start = visible.indexOf("]("); start !== -1; start = visible.indexOf("](", start + 2)) {
    let cursor = start + 2;
    while (/\s/u.test(visible[cursor] ?? "")) cursor += 1;

    if (visible[cursor] === "<") {
      const end = visible.indexOf(">", cursor + 1);
      if (end !== -1) targets.add(visible.slice(cursor + 1, end));
      continue;
    }

    let depth = 1;
    let target = "";
    for (; cursor < visible.length; cursor += 1) {
      const char = visible[cursor];
      if (char === "\\" && cursor + 1 < visible.length) {
        target += visible[cursor + 1];
        cursor += 1;
        continue;
      }
      if (char === "(") {
        depth += 1;
        target += char;
        continue;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
        target += char;
        continue;
      }
      if (/\s/u.test(char) && depth === 1) break;
      target += char;
    }
    if (target) targets.add(target);
  }

  for (const match of visible.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gmu)) {
    targets.add(match[1] ?? match[2]);
  }

  for (const match of visible.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
    targets.add(match[1]);
  }

  return [...targets];
}

function normalizeHeadingText(text) {
  return text
    .replace(/<[^>]+>/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\x60([^\x60]*)\x60/gu, "$1")
    .replace(/\\([\\\x60*_[\]{}()#+.!~-])/gu, "$1")
    .replace(/[*_~]/gu, "")
    .trim();
}

function githubSlug(text) {
  return normalizeHeadingText(text)
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

function markdownAnchors(markdown) {
  const visible = withoutFencedCode(markdown);
  const anchors = new Set();
  const slugCounts = new Map();
  const lines = visible.split("\n");

  const addHeading = (heading) => {
    const base = githubSlug(heading);
    if (!base) return;
    const count = slugCounts.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    slugCounts.set(base, count + 1);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const atx = lines[index].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/u);
    if (atx) {
      addHeading(atx[1]);
      continue;
    }
    if (
      index + 1 < lines.length &&
      lines[index].trim() &&
      /^\s{0,3}(?:=+|-+)\s*$/u.test(lines[index + 1])
    ) {
      addHeading(lines[index]);
      index += 1;
    }
  }

  for (const match of visible.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/giu)) {
    anchors.add(match[1]);
  }

  return anchors;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isExternalOrDynamic(target) {
  return (
    !target ||
    target.startsWith("//") ||
    target.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) ||
    /[{}$*<>]/u.test(target) ||
    target.includes("?")
  );
}

async function documentationFiles() {
  const [docsEntries, operationsEntries] = await Promise.all([
    fs.readdir("docs", { withFileTypes: true }),
    fs.readdir("docs/operations", { withFileTypes: true }),
  ]);
  return [
    ...entrypointDocs,
    ...docsEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.posix.join("docs", entry.name)),
    ...operationsEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.posix.join("docs/operations", entry.name)),
  ].sort();
}

test("public documentation has valid relative links, images, and simple heading anchors", async () => {
  const files = await documentationFiles();
  const markdownByFile = new Map(
    await Promise.all(files.map(async (file) => [file, await fs.readFile(file, "utf8")])),
  );
  const anchorsByFile = new Map();
  const failures = [];

  const anchorsFor = async (file) => {
    if (!anchorsByFile.has(file)) {
      let markdown = markdownByFile.get(file);
      if (markdown === undefined) {
        markdown = await fs.readFile(file, "utf8");
      }
      anchorsByFile.set(file, markdownAnchors(markdown));
    }
    return anchorsByFile.get(file);
  };

  for (const sourceFile of files) {
    for (const rawTarget of markdownLinkTargets(markdownByFile.get(sourceFile))) {
      const target = rawTarget.trim();
      if (isExternalOrDynamic(target)) continue;

      const hashIndex = target.indexOf("#");
      const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const rawFragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
      const decodedPath = safeDecode(rawPath);
      if (decodedPath === null) {
        failures.push(`${sourceFile}: invalid URL encoding in relative target ${JSON.stringify(target)}`);
        continue;
      }

      const targetFile = decodedPath
        ? path.normalize(path.join(path.dirname(sourceFile), decodedPath))
        : sourceFile;

      try {
        await fs.access(targetFile);
      } catch {
        failures.push(`${sourceFile}: missing relative target ${JSON.stringify(target)} -> ${targetFile}`);
        continue;
      }

      if (!rawFragment || !/\.md$/iu.test(targetFile)) continue;
      const decodedFragment = safeDecode(rawFragment);
      if (
        decodedFragment === null ||
        !/^[\p{L}\p{M}\p{N}_.-]+$/u.test(decodedFragment)
      ) {
        continue;
      }

      const anchors = await anchorsFor(targetFile);
      if (!anchors.has(decodedFragment)) {
        failures.push(
          `${sourceFile}: missing heading anchor #${decodedFragment} in ${targetFile} (from ${JSON.stringify(target)})`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
});
