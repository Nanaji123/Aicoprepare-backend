import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import {
  createSession,
  endSession,
  getInterviewHistory,
  getInterviewDetails,
  getInterviewStats,
  getOwnedSession,
  getActiveSession,
  completeStaleSession,
  deleteSession,
} from "../services/interview.js";
import { generateTemporaryKey } from "../services/deepgram.js";
import { getBalance, CREDITS_PER_MINUTE } from "../services/credits.js";
import { stopMetering, isMetering } from "../services/metering.js";

const router = Router();

/**
 * POST /api/interviews/start
 *
 * Creates a new interview session. The desktop app calls this
 * when the user clicks "Join Session" after receiving a deep link.
 *
 * Body: { role?, company?, experienceLevel?, jobDescription?, ... }
 * Returns: { id, status, started_at, ... }
 */
router.post("/start", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const config = req.body || {};

    // Credit gate — a session needs at least 1 credit (1 minute) to start.
    // Checked before the session row is created so a broke user leaves no
    // orphaned "active" sessions behind.
    const { balance } = await getBalance(userId);
    if (balance < CREDITS_PER_MINUTE) {
      res.status(402).json({
        message: "You're out of credits. Top up to start a new session.",
        code: "INSUFFICIENT_CREDITS",
        balance,
      });
      return;
    }

    const session = await createSession(userId, config);

    console.log(`[Interview] Session ${session.id} created for user ${userId}`);

    res.json(session);
  } catch (err) {
    console.error("[Interview] Failed to start session:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ message: `Failed to start session: ${message}` });
  }
});

/**
 * PUT /api/interviews/:id/end
 *
 * Ends an interview session and saves the transcript + answers.
 * The desktop app calls this when the user clicks "End Session".
 *
 * Body: { transcript: [...], answer: [...], ended_at: string }
 */
router.put("/:id/end", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;
    const { transcript = [], answer = [], ended_at } = req.body;

    // Ownership check — a session ID is not authorisation. Without this any
    // authenticated user could end someone else's session, write transcripts
    // into it, and trigger credit settlement against their balance.
    const session = await getOwnedSession(sessionId, userId);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    if (session.status === "ended") {
      res.status(409).json({ message: "Session has already ended" });
      return;
    }

    // Billing stops the moment the session does.
    stopMetering(sessionId);

    await endSession(
      sessionId,
      transcript,
      answer,
      ended_at || new Date().toISOString()
    );

    console.log(`[Interview] Session ${sessionId} ended`);

    res.json({ success: true, message: "Session ended successfully" });
  } catch (err) {
    console.error("[Interview] Failed to end session:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ message: `Failed to end session: ${message}` });
  }
});

/**
 * POST /api/interviews/:id/complete
 *
 * Force-closes a session stuck in `active` (client crashed, force-quit, lost
 * network). Unlike /end this takes no transcript and does not bill for the
 * idle time — see completeStaleSession.
 */
router.post("/:id/complete", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;

    const session = await getOwnedSession(sessionId, userId);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    if (session.status === "ended") {
      res.status(409).json({ message: "Session has already ended" });
      return;
    }

    stopMetering(sessionId);
    const endedAt = await completeStaleSession(session);

    console.log(`[Interview] Session ${sessionId} force-completed by user`);

    res.json({ success: true, id: sessionId, status: "ended", ended_at: endedAt });
  } catch (err) {
    console.error("[Interview] Failed to complete session:", err);
    res.status(500).json({ message: "Failed to complete session" });
  }
});

/**
 * DELETE /api/interviews/:id
 *
 * Permanently deletes a session with its transcripts and AI answers.
 * Credit ledger rows survive — spent credits stay on the record.
 */
router.delete("/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;

    const session = await getOwnedSession(sessionId, userId);
    if (!session) {
      res.status(404).json({ message: "Session not found" });
      return;
    }

    // Deleting a live session must also stop it billing.
    stopMetering(sessionId);
    await deleteSession(sessionId);

    console.log(`[Interview] Session ${sessionId} deleted by user ${userId}`);

    res.json({ success: true, id: sessionId });
  } catch (err) {
    console.error("[Interview] Failed to delete session:", err);
    res.status(500).json({ message: "Failed to delete session" });
  }
});

/**
 * GET /api/interviews/active
 *
 * The user's currently-running session, or null. Lets the web app show a
 * "session in progress" state and offer to close a stuck one.
 *
 * NOTE: must stay registered before GET /:id.
 */
router.get("/active", authMiddleware, async (req: Request, res: Response) => {
  try {
    const session = await getActiveSession(req.user!.id);
    res.json(
      session
        ? { ...session, isMetering: isMetering(session.id) }
        : null
    );
  } catch (err) {
    console.error("[Interview] Failed to get active session:", err);
    res.status(500).json({ message: "Failed to get active session" });
  }
});

/**
 * GET /api/interviews/history
 *
 * Fetches the user's past interview sessions.
 */
router.get("/history", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
    const history = await getInterviewHistory(userId, limit, offset);
    res.json(history);
  } catch (err) {
    console.error("[Interview] Failed to get history:", err);
    res.status(500).json({ message: "Failed to get interview history" });
  }
});

/**
 * GET /api/interviews/stats
 *
 * Dashboard Overview stats — total sessions, minutes practiced, last
 * session date. Computed DB-side across all sessions (see migration 002),
 * independent of the capped /history list.
 *
 * NOTE: must stay registered before GET /:id, or "stats" gets swallowed
 * as a session id by that catch-all route.
 */
router.get("/stats", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const stats = await getInterviewStats(userId);
    res.json(stats);
  } catch (err) {
    console.error("[Interview] Failed to get stats:", err);
    res.status(500).json({ message: "Failed to get interview stats" });
  }
});

/**
 * GET /api/interviews/deepgram-token
 *
 * Generates a temporary Deepgram API key for the desktop client.
 * The client uses this to connect directly to Deepgram's real-time STT API.
 * Keys expire after 10 minutes.
 */
router.get(
  "/deepgram-token",
  authMiddleware,
  async (_req: Request, res: Response) => {
    try {
      const accessToken = await generateTemporaryKey(600); // 10 min TTL

      res.json({ accessToken });
    } catch (err) {
      console.error("[Interview] Failed to generate Deepgram token:", err);
      res.status(500).json({ message: "Failed to generate transcription token" });
    }
  }
);

/**
 * GET /api/interviews/:id
 *
 * Fetches the details of a specific interview session.
 */
router.get("/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;
    const details = await getInterviewDetails(sessionId, userId);
    res.json(details);
  } catch (err) {
    console.error("[Interview] Failed to get session details:", err);
    res.status(500).json({ message: "Failed to get session details" });
  }
});

export default router;
