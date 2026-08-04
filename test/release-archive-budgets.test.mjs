import assert from "node:assert/strict";
import test from "node:test";
import {
  assertArchiveBudget,
  releaseArchiveBudgets,
} from "../scripts/release-archive-budgets.mjs";

test("release archive budgets accept their exact boundaries", () => {
  for (const [kind, budget] of Object.entries(releaseArchiveBudgets)) {
    assert.doesNotThrow(() => assertArchiveBudget(kind, { ...budget }, budget));
  }
});

test("release archive budgets reject each kind of package bloat with a clear error", () => {
  const budget = releaseArchiveBudgets.vsix;

  assert.throws(
    () => assertArchiveBudget("VSIX", { compressedBytes: budget.compressedBytes + 1 }, budget),
    /VSIX compressed size is .* release budget is 40\.00 MiB/,
  );
  assert.throws(
    () => assertArchiveBudget("VSIX", { entries: budget.entries + 1 }, budget),
    /VSIX contains 20,001 entries; release budget is 20,000/,
  );
  assert.throws(
    () => assertArchiveBudget("VSIX", { uncompressedBytes: budget.uncompressedBytes + 1 }, budget),
    /VSIX uncompressed size is .* release budget is 128\.00 MiB/,
  );
});

test("npm release budgets remain materially smaller than VSIX budgets", () => {
  const { npm, vsix } = releaseArchiveBudgets;
  assert.ok(npm.compressedBytes < vsix.compressedBytes);
  assert.ok(npm.entries < vsix.entries);
  assert.ok(npm.uncompressedBytes < vsix.uncompressedBytes);
});
