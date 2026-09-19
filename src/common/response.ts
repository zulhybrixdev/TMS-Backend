import { Response } from "express";

// Common API response envelope used by every endpoint in the system.

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function okPaginated<T>(
  res: Response,
  data: T[],
  meta: PaginationMeta,
  status = 200
) {
  return res.status(status).json({ success: true, data, meta });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, 201);
}

export function noContent(res: Response) {
  return res.status(204).send();
}

export function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return res.status(status).json({
    success: false,
    error: { code, message, details },
  });
}
