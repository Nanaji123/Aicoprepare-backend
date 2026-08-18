import { randomUUID } from "crypto";
import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";

/**
 * Carries the session setup payload (job description, CV text, etc.) from
 * the website to the desktop app without putting it in the coprep:// /
 * pathmaker4u:// deep link — Windows' ShellExecute silently refuses to launch
 * a protocol handler once the URL passes roughly ~2000 characters, which a
 * job description + CV easily do. The deep link instead carries only the
 * short id this returns.
 *
 * POST /api/session-handoff — website stores the payload, gets an id back
 * GET  /api/session-handoff/:id — desktop app consumes it once
 */

const TTL_MS = 5 * 60 * 1000;

interface Entry {
  userId: string;
  payload: unknown;
  expiresAt: number;
}

const pending = new Map<string, Entry>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

const router = Router();

router.post("/", authMiddleware, (req: Request, res: Response) => {
  sweepExpired();
  const id = randomUUID();
  pending.set(id, {
    userId: req.user!.id,
    payload: req.body,
    expiresAt: Date.now() + TTL_MS,
  });
  res.json({ id });
});

router.get("/:id", authMiddleware, (req: Request, res: Response) => {
  const id = req.params.id as string;
  const entry = pending.get(id);

  if (!entry || entry.expiresAt <= Date.now()) {
    res.status(404).json({ message: "Handoff not found or expired" });
    return;
  }
  if (entry.userId !== req.user!.id) {
    res.status(403).json({ message: "Handoff belongs to a different user" });
    return;
  }

  pending.delete(id); // single-use
  res.json({ payload: entry.payload });
});

export default router;
