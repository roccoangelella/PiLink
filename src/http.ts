import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Express 4 does not forward rejected handler promises to error middleware. */
export function asyncRoute(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Never expose stack traces, local paths, provider errors, or request bodies. */
export const safeHttpErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = safeHttpStatus(error);
  const code = status === 400
    ? "invalid_request"
    : status === 413
      ? "payload_too_large"
      : status === 415
        ? "unsupported_media_type"
        : status >= 400 && status < 500
          ? "request_rejected"
          : "internal_error";
  console.error(`[HTTP] Request failed safely: ${req.method} ${req.path} -> ${status}`);
  res.status(status).json({ error: code });
};

function safeHttpStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 500;
  const candidate = "status" in error
    ? (error as { status?: unknown }).status
    : "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  return Number.isInteger(candidate) && (candidate as number) >= 400 && (candidate as number) <= 599
    ? candidate as number
    : 500;
}
