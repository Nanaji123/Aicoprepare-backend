import { Request, Response, NextFunction } from "express";
import { supabaseAuth } from "../lib/supabase.js";

/**
 * Express middleware that verifies the Supabase JWT from the
 * Authorization header and attaches the user to `req.user`.
 *
 * Usage: router.get("/protected", authMiddleware, handler);
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ message: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const {
      data: { user },
      error,
    } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ message: "Invalid or expired token" });
      return;
    }

    // Attach user info to the request for downstream handlers
    req.user = {
      id: user.id,
      email: user.email,
    };

    next();
  } catch (err) {
    console.error("[Auth] Token verification error:", err);
    res.status(500).json({ message: "Authentication service error" });
  }
}
