import { Request } from "express";
import { PaginationMeta } from "./response";

export interface ParsedListQuery {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  sortBy?: string;
  sortDir: "asc" | "desc";
  search?: string;
}

// Shared parser for list endpoints: page/pageSize/sortBy/sortDir/search.
export function parseListQuery(
  req: Request,
  opts: { defaultSort?: string; allowedSort?: string[] } = {}
): ParsedListQuery {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20)
  );

  let sortBy = (req.query.sortBy as string) || opts.defaultSort;
  if (opts.allowedSort && sortBy && !opts.allowedSort.includes(sortBy)) {
    sortBy = opts.defaultSort;
  }
  const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";
  const search = (req.query.search as string) || undefined;

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    sortBy,
    sortDir,
    search,
  };
}

export function buildMeta(page: number, pageSize: number, total: number): PaginationMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
