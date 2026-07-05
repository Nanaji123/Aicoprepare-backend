import { Router, Request, Response } from "express";

/**
 * Dev-only bridge for passing session data from the website
 * to the desktop app without requiring deep link protocol registration.
 *
 * POST /api/dev/session  — Website pushes session data here
 * GET  /api/dev/session   — Desktop app polls and consumes it
 */

const router = Router();

// In-memory store for pending session data (one at a time)
let pendingSession: any = null;

// Website pushes session data
router.post("/session", (_req: Request, res: Response) => {
  pendingSession = _req.body;
  console.log("[DevBridge] Session data received from website");
  res.json({ success: true });
});

// Desktop app polls and consumes session data
router.get("/session", (_req: Request, res: Response) => {
  if (pendingSession) {
    const data = pendingSession;
    pendingSession = null; // Consume it (one-time read)
    res.json({ available: true, data });
  } else {
    res.json({ available: false });
  }
});

export default router;
