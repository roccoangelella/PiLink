export const CLOUDFLARED_VERSION = "2026.7.2";

export interface CloudflaredRelease {
  asset: string;
  sha256: string;
}

const LINUX_SHA256: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
  arm64: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
};

const WINDOWS_AMD64_SHA256 = "cdb5d4432f6ae1595654a692a51308b69d2bf7af961f5578d9391837cf072df9";

export function resolveCloudflaredRelease(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): CloudflaredRelease {
  if (platform === "linux") {
    if (architecture !== "x64" && architecture !== "arm64") {
      throw new Error(
        `Automatic cloudflared installation is unsupported for Linux architecture '${architecture}'. ` +
        "Install it manually and set PI_CLOUDFLARED_PATH.",
      );
    }
    return {
      asset: `cloudflared-linux-${architecture === "x64" ? "amd64" : "arm64"}`,
      sha256: LINUX_SHA256[architecture],
    };
  }

  if (platform === "win32") {
    if (architecture !== "x64") {
      throw new Error(
        `Automatic cloudflared installation is unsupported for Windows architecture '${architecture}'. ` +
        "Install it manually and set PI_CLOUDFLARED_PATH.",
      );
    }
    return {
      asset: "cloudflared-windows-amd64.exe",
      sha256: WINDOWS_AMD64_SHA256,
    };
  }

  throw new Error(
    `Automatic cloudflared installation is unsupported on platform '${platform}'. ` +
    "Install it manually and set PI_CLOUDFLARED_PATH.",
  );
}
