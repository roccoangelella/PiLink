export type ProgressToken = string | number;

export interface ProgressRequestContext {
  _meta?: { progressToken?: ProgressToken };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: ProgressToken;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ProgressReporter {
  finish(message: string): Promise<void>;
}

export interface ProgressReporterOptions {
  intervalMs?: number;
  now?: () => number;
}

const NOOP_REPORTER: ProgressReporter = {
  async finish() {},
};

/** Best-effort, rate-limited progress for one in-flight MCP request. */
export async function startProgressReporter(
  context: ProgressRequestContext,
  label: string,
  options: ProgressReporterOptions = {},
): Promise<ProgressReporter> {
  const progressToken = context._meta?.progressToken;
  if (progressToken === undefined) return NOOP_REPORTER;

  const intervalMs = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("intervalMs must be a positive safe integer");
  }
  const now = options.now ?? Date.now;
  const startedAt = now();
  let nextProgress = 0;
  let stopped = false;
  let queue = Promise.resolve();

  const send = (message: string): Promise<void> => {
    const progress = nextProgress;
    nextProgress += 1;
    queue = queue
      .then(() => context.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message },
      }))
      .catch(() => undefined);
    return queue;
  };

  await send(`${label} started`);
  const timer = setInterval(() => {
    if (stopped) return;
    const elapsedSeconds = Math.max(0, Math.floor((now() - startedAt) / 1000));
    void send(`${label} running for ${elapsedSeconds}s`);
  }, intervalMs);
  timer.unref?.();

  return {
    async finish(message: string): Promise<void> {
      if (stopped) return queue;
      stopped = true;
      clearInterval(timer);
      await send(message);
    },
  };
}
