import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";

/**
 * JWKS is fetched once and cached in-memory for the life of the process
 * (jose only re-fetches if it sees an unrecognized `kid`), so verifying a
 * token costs zero network round-trips after the first request — unlike
 * supabaseAdmin.auth.getUser(), which calls out to Supabase on every call.
 */
const jwks = createRemoteJWKSet(
  new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

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
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
    });

    if (!payload.sub) {
      res.status(401).json({ message: "Invalid or expired token" });
      return;
    }

    // Attach user info to the request for downstream handlers
    req.user = {
      id: payload.sub,
      email: payload.email as string | undefined,
    };

    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}
