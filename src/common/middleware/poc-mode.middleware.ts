import { NextFunction, Request, Response } from "express";
import { platformConfigService } from "../platform-config.service";

// Enforces PlatformConfig.pocMode as a live redirect, DB-driven, no
// rebuild needed: pocMode=true bounces every non-POC page to its /poc
// equivalent; pocMode=false bounces the other way. /api and /platform are
// never touched, regardless of the mode - /platform must always stay
// directly reachable, since it's the only place pocMode gets flipped back.
export async function pocModeRedirect(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith("/api") || req.path.startsWith("/platform")) return next();

  try {
    const pocMode = await platformConfigService.getPocMode();
    const isPocPath = req.path === "/poc" || req.path.startsWith("/poc/");

    if (pocMode && !isPocPath) {
      return res.redirect(302, "/poc" + req.originalUrl);
    }
    if (!pocMode && isPocPath) {
      const stripped = req.originalUrl.replace(/^\/poc/, "") || "/";
      return res.redirect(302, stripped);
    }
    next();
  } catch {
    // Fail open: a DB hiccup here should never take the whole site down -
    // just serve whichever build the path already points at.
    next();
  }
}
