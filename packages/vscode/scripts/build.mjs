import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(extensionDirectory, "..", "..");
const outputDirectory = path.join(extensionDirectory, "dist");
const originalLogo = path.join(repositoryRoot, "docs", "assets", "logo.png");

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

fs.copyFileSync(originalLogo, path.join(extensionDirectory, "media", "logo.png"));
await sharp(originalLogo)
  .resize(256, 256, { fit: "contain", background: "#ffffff" })
  .png()
  .toFile(path.join(extensionDirectory, "media", "icon.png"));

await build({
  entryPoints: [path.join(extensionDirectory, "src", "extension.ts")],
  outfile: path.join(outputDirectory, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
