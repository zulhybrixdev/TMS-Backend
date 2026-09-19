import { NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";
import { ValidationError } from "../errors";

type Target = "body" | "query" | "params";

// Shared Zod validation wrapper. On success, replaces req[target] with the
// parsed (and coerced/defaulted) value so downstream handlers get clean data.
export function validate(schema: ZodTypeAny, target: Target = "body") {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return next(new ValidationError(result.error.flatten()));
    }
    (req as any)[target] = result.data;
    next();
  };
}
