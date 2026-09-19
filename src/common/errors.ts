// Common Service: typed application errors mapped to HTTP status codes
// by the central error-handling middleware.

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
  }
}

// Thrown by requireModule() when the tenant's current plan doesn't include
// a gated module - distinct code so the frontend can show an upsell prompt
// instead of a generic "forbidden" toast.
export class PlanUpgradeRequiredError extends AppError {
  constructor(message = "This feature requires a plan upgrade", details?: unknown) {
    super(403, "PLAN_UPGRADE_REQUIRED", message, details);
  }
}

// Thrown at login and on every subsequent request (tenant.middleware.ts)
// when a platform admin has suspended the tenant.
export class TenantSuspendedError extends AppError {
  constructor(message = "This organisation has been suspended. Contact support.") {
    super(403, "TENANT_SUSPENDED", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

// Thrown when a plan's user/bank-account seat limit (or the Individual
// account type's 1-user cap) would be exceeded.
export class LimitReachedError extends AppError {
  constructor(message = "Plan limit reached", details?: unknown) {
    super(409, "LIMIT_REACHED", message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = "Validation failed") {
    super(422, "VALIDATION_ERROR", message, details);
  }
}
