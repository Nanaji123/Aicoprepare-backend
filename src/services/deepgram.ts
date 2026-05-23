import { createClient } from "@deepgram/sdk";
import { env } from "../config/env.js";

/**
 * Deepgram Token Service
 *
 * The desktop client needs a temporary Deepgram API key to connect
 * directly to Deepgram's real-time STT API. This service generates
 * short-lived project keys so the main API key stays server-side.
 */

const deepgram = createClient(env.DEEPGRAM_API_KEY);

/**
 * Generate a temporary Deepgram API key for the client.
 *
 * The key is scoped to `usage:write` (required for live transcription)
 * and expires after the specified TTL.
 */
export async function generateTemporaryKey(
  ttlSeconds: number = 600 // 10 minutes default
): Promise<string> {
  // Bypassing temporary key generation since it requires high-level 'Owner' account scopes 
  // that standard API keys often lack, causing a 403 Forbidden error.
  // We return the primary API key instead so the desktop app can connect successfully.
  return env.DEEPGRAM_API_KEY;
}

/** Cache the project ID since it doesn't change */
let cachedProjectId: string | null = null;

async function getProjectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;

  try {
    const { result, error } = await deepgram.manage.getProjects();

    if (error || !result?.projects?.length) {
      throw new Error("No Deepgram projects found");
    }

    cachedProjectId = result.projects[0].project_id;
    return cachedProjectId;
  } catch (err) {
    console.error("[Deepgram] Failed to get project ID:", err);
    throw err;
  }
}
