import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors";
import { platformConfigService } from "../platform-config.service";

// Refuses self-service registration while it is switched off for this
// environment (Platform Console > Registration). Runs before body validation
// so a closed environment answers the same way whatever was submitted.
export async function requireRegistrationOpen(_req: Request, _res: Response, next: NextFunction) {
  if (!(await platformConfigService.isRegistrationEnabled())) {
    throw new AppError(403, "REGISTRATION_CLOSED", "New registrations are currently closed. Please try again later, or contact your administrator.");
  }
  next();
}
