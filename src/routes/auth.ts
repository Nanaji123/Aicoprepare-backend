import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/auth/verify
 *
 * Verifies that the provided JWT token is valid and the userId matches.
 * The desktop app calls this after receiving a deep link to confirm the user.
 */
router.post("/verify", authMiddleware, (req: Request, res: Response) => {
  const { userId } = req.body;

  // If a userId was provided, check it matches the token's user
  if (userId && req.user?.id !== userId) {
    res.status(403).json({ message: "User ID does not match token" });
    return;
  }

  res.json({
    success: true,
    user: {
      id: req.user?.id,
      email: req.user?.email,
    },
  });
});

export default router;
