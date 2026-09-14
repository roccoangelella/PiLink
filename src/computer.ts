import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const COMMAND_STDOUT_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

export interface ComputerPoint {
  x: number;
  y: number;
}

export interface ComputerObservation {
  data: Buffer;
  mimeType: "image/png";
  width: number;
  height: number;
  cursor?: ComputerPoint;
  capturedAt: string;
  backend: string;
}

export type ComputerMouseButton = "left" | "middle" | "right";

export type ComputerAction =
  | { action: "click"; x: number; y: number; button?: ComputerMouseButton }
  | { action: "double_click"; x: number; y: number; button?: ComputerMouseButton }
  | { action: "move"; x: number; y: number }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number; button?: ComputerMouseButton }
  | { action: "scroll"; dx: number; dy: number }
  | { action: "type"; text: string }
  | { action: "keypress"; keys: string[] }
  | { action: "wait"; durationMs: number };

export interface ComputerBackend {
  readonly name: string;
  observe(): Promise<ComputerObservation>;
  action(input: ComputerAction): Promise<void>;
}

export function createSystemComputerBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ComputerBackend {
  if (platform !== "linux") {
    return new UnavailableComputerBackend(
      `${platform} desktop control is not implemented in the first PiLink Computer Use preview. ` +
      "This branch currently supports Linux X11 sessions only.",
    );
  }

  const sessionType = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (sessionType === "wayland" || (env.WAYLAND_DISPLAY && sessionType !== "x11")) {
    return new UnavailableComputerBackend(
      "PiLink Computer Use v1 does not inject input into Wayland sessions. " +
      "Use an X11 desktop session for this preview; a portal-based Wayland backend should be added separately.",
    );
  }
  if (!env.DISPLAY?.trim()) {
    return new UnavailableComputerBackend(
      "PiLink Computer Use needs an interactive Linux X11 session, but DISPLAY is not set.",
    );
  }
  return new LinuxX11ComputerBackend(env);
}

class UnavailableComputerBackend implements ComputerBackend {
  public readonly name = "unavailable";

  public constructor(private readonly reason: string) {}

  public async observe(): Promise<ComputerObservation> {
    throw new Error(this.reason);
  }

  public async action(_input: ComputerAction): Promise<void> {
    throw new Error(this.reason);
  }
}

interface ScreenshotProvider {
  executable: string;
  args(file: string): string[];
  label: string;
}

class LinuxX11ComputerBackend implements ComputerBackend {
  public readonly name = "linux-x11";
  private readonly xdotool?: string;
  private readonly screenshotProvider?: ScreenshotProvider;
  private readonly env: NodeJS.ProcessEnv;

  public constructor(env: NodeJS.ProcessEnv) {
    this.env = { ...env };
    this.xdotool = findExecutable("xdotool", env);
    this.screenshotProvider = resolveScreenshotProvider(env);
  }

  public async observe(): Promise<ComputerObservation> {
    if (!this.screenshotProvider) {
      throw new Error(
        "No supported screenshot helper was found. Install gnome-screenshot, scrot, or ImageMagick 'import' in the PiLink user's PATH.",
      );
    }
    const data = await capturePng(this.screenshotProvider, this.env);
    const { width, height } = parsePngSize(data);
    const cursor = this.xdotool ? await this.cursorPosition().catch(() => undefined) : undefined;
    return {
      data,
      mimeType: "image/png",
      width,
      height,
      ...(cursor ? { cursor } : {}),
      capturedAt: new Date().toISOString(),
      backend: this.name,
    };
  }

  public async action(input: ComputerAction): Promise<void> {
    if (input.action === "wait") {
      await delay(validateDuration(input.durationMs));
      return;
    }

    const xdotool = this.requireXdotool();
    if (input.action === "type") {
      if (Buffer.byteLength(input.text, "utf8") > 16_384 || /\0/u.test(input.text)) {
        throw new Error("Typed text is invalid or exceeds 16 KiB");
      }
      await runCommand(xdotool, ["type", "--clearmodifiers", "--delay", "1", "--", input.text], this.env);
      return;
    }

    if (input.action === "keypress") {
      const chord = normalizeKeyChord(input.keys);
      await runCommand(xdotool, ["key", "--clearmodifiers", chord], this.env);
      return;
    }

    if (input.action === "scroll") {
      const dx = validateScrollAmount(input.dx, "dx");
      const dy = validateScrollAmount(input.dy, "dy");
      if (dy < 0) await clickRepeated(xdotool, 4, Math.abs(dy), this.env);
      if (dy > 0) await clickRepeated(xdotool, 5, dy, this.env);
      if (dx < 0) await clickRepeated(xdotool, 6, Math.abs(dx), this.env);
      if (dx > 0) await clickRepeated(xdotool, 7, dx, this.env);
      return;
    }

    const geometry = await this.displayGeometry();
    if (input.action === "drag") {
      assertPoint(input.fromX, input.fromY, geometry);
      assertPoint(input.toX, input.toY, geometry);
      const button = mouseButtonNumber(input.button);
      await runCommand(xdotool, ["mousemove", String(input.fromX), String(input.fromY)], this.env);
      await runCommand(xdotool, ["mousedown", String(button)], this.env);
      try {
        await runCommand(xdotool, ["mousemove", String(input.toX), String(input.toY)], this.env);
      } finally {
        await runCommand(xdotool, ["mouseup", String(button)], this.env).catch(() => undefined);
      }
      return;
    }

    assertPoint(input.x, input.y, geometry);
    await runCommand(xdotool, ["mousemove", String(input.x), String(input.y)], this.env);
    if (input.action === "move") return;

    const button = mouseButtonNumber(input.button);
    if (input.action === "double_click") {
      await runCommand(xdotool, ["click", "--repeat", "2", "--delay", "120", String(button)], this.env);
      return;
    }
    await runCommand(xdotool, ["click", String(button)], this.env);
  }

  private requireXdotool(): string {
    if (!this.xdotool) {
      throw new Error(
        "Mouse and keyboard actions require xdotool in the PiLink user's PATH. " +
        "Computer observation can still work when a screenshot helper is available.",
      );
    }
    return this.xdotool;
  }

  private async displayGeometry(): Promise<{ width: number; height: number }> {
    const stdout = await runCommand(this.requireXdotool(), ["getdisplaygeometry"], this.env);
    const match = stdout.toString("utf8").trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) throw new Error("xdotool returned an invalid display geometry");
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error("xdotool returned an invalid display geometry");
    }
    return { width, height };
  }

  private async cursorPosition(): Promise<ComputerPoint> {
    const stdout = await runCommand(this.requireXdotool(), ["getmouselocation", "--shell"], this.env);
    const text = stdout.toString("utf8");
    const x = Number(text.match(/^X=(\d+)$/mu)?.[1]);
    const y = Number(text.match(/^Y=(\d+)$/mu)?.[1]);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
      throw new Error("xdotool returned an invalid cursor position");
    }
    return { x, y };
  }
}

function resolveScreenshotProvider(env: NodeJS.ProcessEnv): ScreenshotProvider | undefined {
  const gnomeScreenshot = findExecutable("gnome-screenshot", env);
  if (gnomeScreenshot) {
    return {
      executable: gnomeScreenshot,
      args: (file) => ["-f", file],
      label: "gnome-screenshot",
    };
  }
  const scrot = findExecutable("scrot", env);
  if (scrot) {
    return {
      executable: scrot,
      args: (file) => ["-o", file],
      label: "scrot",
    };
  }
  const imageMagickImport = findExecutable("import", env);
  if (imageMagickImport) {
    return {
      executable: imageMagickImport,
      args: (file) => ["-window", "root", file],
      label: "ImageMagick import",
    };
  }
  return undefined;
}

async function capturePng(provider: ScreenshotProvider, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pilink-computer-"));
  await fs.promises.chmod(directory, 0o700);
  const file = path.join(directory, "screen.png");
  try {
    await runCommand(provider.executable, provider.args(file), env);
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SCREENSHOT_BYTES) {
        throw new Error(`${provider.label} produced an invalid or oversized screenshot`);
      }
      const data = await handle.readFile();
      parsePngSize(data);
      return data;
    } finally {
      await handle.close();
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

export function parsePngSize(data: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Desktop capture did not produce a valid PNG image");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width > 32_768 || height > 32_768) {
    throw new Error("Desktop capture returned an invalid image size");
  }
  return { width, height };
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name || /[\0\r\n]/u.test(name)) return undefined;
  const candidates = path.isAbsolute(name)
    ? [name]
    : (env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

function mouseButtonNumber(button: ComputerMouseButton | undefined): number {
  if (button === undefined || button === "left") return 1;
  if (button === "middle") return 2;
  if (button === "right") return 3;
  throw new Error("Unsupported mouse button");
}

function assertPoint(x: number, y: number, geometry: { width: number; height: number }): void {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) {
    throw new Error(`Desktop coordinates (${x}, ${y}) are outside the ${geometry.width}x${geometry.height} display`);
  }
}

function validateScrollAmount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 100) {
    throw new Error(`${field} must be an integer between -100 and 100`);
  }
  return value;
}

function validateDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error("durationMs must be an integer between 0 and 10000");
  }
  return value;
}

async function clickRepeated(command: string, button: number, count: number, env: NodeJS.ProcessEnv): Promise<void> {
  if (count === 0) return;
  await runCommand(command, ["click", "--repeat", String(count), "--delay", "30", String(button)], env);
}

function normalizeKeyChord(keys: string[]): string {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) {
    throw new Error("keys must contain between 1 and 8 key names");
  }
  return keys.map(normalizeKeyToken).join("+");
}

function normalizeKeyToken(value: string): string {
  const token = value.trim().toUpperCase();
  const aliases: Record<string, string> = {
    CTRL: "ctrl",
    CONTROL: "ctrl",
    ALT: "alt",
    SHIFT: "shift",
    META: "super",
    SUPER: "super",
    CMD: "super",
    COMMAND: "super",
    ENTER: "Return",
    RETURN: "Return",
    TAB: "Tab",
    ESC: "Escape",
    ESCAPE: "Escape",
    SPACE: "space",
    BACKSPACE: "BackSpace",
    DELETE: "Delete",
    HOME: "Home",
    END: "End",
    PAGEUP: "Page_Up",
    PAGEDOWN: "Page_Down",
    UP: "Up",
    DOWN: "Down",
    LEFT: "Left",
    RIGHT: "Right",
  };
  if (aliases[token]) return aliases[token];
  if (/^[A-Z0-9]$/u.test(token)) return token.toLowerCase();
  if (/^F(?:[1-9]|1\d|2[0-4])$/u.test(token)) return token;
  throw new Error(`Unsupported key name '${value}'`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error?: Error, stdout?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout ?? Buffer.alloc(0));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > COMMAND_STDOUT_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("Desktop helper produced too much output"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.resume();
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        finish(new Error("Desktop helper timed out"));
        return;
      }
      if (code !== 0) {
        finish(new Error(`Desktop helper failed (${code ?? signal ?? "unknown"})`));
        return;
      }
      finish(undefined, Buffer.concat(stdoutChunks));
    });
  });
}
