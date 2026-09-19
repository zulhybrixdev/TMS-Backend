import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors";
import { fail } from "../response";

export function notFoundHandler(req: Request, res: Response) {
  fail(res, 404, "NOT_FOUND", `Route not found: ${req.method} ${req.path}`);
}

// Central error handler - every thrown/next(err) call in the app lands here.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return fail(res, err.status, err.code, err.message, err.details);
  }

  // eslint-disable-next-line no-console
  console.error("[unhandled error]", err);
  return fail(res, 500, "INTERNAL_ERROR", "An unexpected error occurred");
}
