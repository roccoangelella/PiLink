const mebibyte = 1024 * 1024;

// These ceilings intentionally leave routine release headroom while catching
// accidental dependency trees, copied build directories, and archive bombs.
// Baseline at 2.2.0: VSIX ~= 28.2 MiB / 17,900 entries / 87.7 MiB unpacked;
// npm package ~= 0.34 MiB / 100 entries / 1.33 MiB unpacked.
export const releaseArchiveBudgets = Object.freeze({
  vsix: Object.freeze({
    compressedBytes: 40 * mebibyte,
    entries: 20_000,
    uncompressedBytes: 128 * mebibyte,
  }),
  npm: Object.freeze({
    compressedBytes: 4 * mebibyte,
    entries: 512,
    uncompressedBytes: 8 * mebibyte,
  }),
});

function formatBytes(bytes) {
  return `${(bytes / mebibyte).toFixed(2)} MiB`;
}

export function assertArchiveBudget(label, usage, budget) {
  if (usage.compressedBytes !== undefined && usage.compressedBytes > budget.compressedBytes) {
    throw new Error(
      `${label} compressed size is ${formatBytes(usage.compressedBytes)}; ` +
      `release budget is ${formatBytes(budget.compressedBytes)}`,
    );
  }
  if (usage.entries !== undefined && usage.entries > budget.entries) {
    throw new Error(
      `${label} contains ${usage.entries.toLocaleString("en-US")} entries; ` +
      `release budget is ${budget.entries.toLocaleString("en-US")}`,
    );
  }
  if (usage.uncompressedBytes !== undefined && usage.uncompressedBytes > budget.uncompressedBytes) {
    throw new Error(
      `${label} uncompressed size is ${formatBytes(usage.uncompressedBytes)}; ` +
      `release budget is ${formatBytes(budget.uncompressedBytes)}`,
    );
  }
}
