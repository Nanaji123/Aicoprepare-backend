import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import {
  createSession,
  endSession,
  getInterviewHistory,
  getInterviewDetails,
} from "../services/interview.js";
import { generateTemporaryKey } from "../services/deepgram.js";

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
    const sessionId = req.params.id as string;
    const { transcript = [], answer = [], ended_at } = req.body;

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
 * GET /api/interviews/history
 *
 * Fetches the user's past interview sessions.
 */
router.get("/history", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const history = await getInterviewHistory(userId);
    res.json(history);
  } catch (err) {
    console.error("[Interview] Failed to get history:", err);
    res.status(500).json({ message: "Failed to get interview history" });
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
