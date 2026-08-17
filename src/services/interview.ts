import { supabaseAdmin } from "../lib/supabase.js";
import { reconcileSessionCredits, isMetering } from "./metering.js";
import type {
  InterviewConfig,
  InterviewSession,
  InterviewSessionListItem,
  InterviewStats,
  TranscriptEntry,
} from "../types/index.js";

/**
 * Interview session CRUD operations via Supabase.
 */

/** Create a new interview session */
export async function createSession(
  userId: string,
  config: InterviewConfig
): Promise<InterviewSession> {
  const { data, error } = await supabaseAdmin
    .from("interviews")
    .insert({
      user_id: userId,
      config,
      status: "active",
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("[Interview] Failed to create session:", error);
    throw new Error(`Failed to create session: ${error.message}`);
  }

  return data as InterviewSession;
}

/** Get a session by ID */
export async function getSession(
  sessionId: string
): Promise<InterviewSession | null> {
  const { data, error } = await supabaseAdmin
    .from("interviews")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // Not found
    console.error("[Interview] Failed to get session:", error);
    throw new Error(`Failed to get session: ${error.message}`);
  }

  return data as InterviewSession;
}

/**
 * Fetch a session only if it belongs to this user.
 *
 * Every route that acts on a session by ID must go through this — the ID alone
 * is not authorisation, and session IDs travel through deep links and client
 * logs where they're easy to come by.
 */
export async function getOwnedSession(
  sessionId: string,
  userId: string
): Promise<InterviewSession | null> {
  const session = await getSession(sessionId);
  if (!session || session.user_id !== userId) return null;
  return session;
}

/**
 * Get a user's interview history (session list, not full details).
 *
 * Only pulls the columns the list view needs — `config` can carry a
 * multi-KB embedded CV text blob per session (see Overview.tsx CV upload),
 * so pulling `select("*")` here was dragging that along for every past
 * session on every page load. `job_title`/`interview_type` are extracted
 * from `config` directly so that blob never leaves the database.
 */
export async function getInterviewHistory(
  userId: string,
  limit = 100,
  offset = 0
): Promise<InterviewSessionListItem[]> {
  const { data, error } = await supabaseAdmin
    .from("interviews")
    .select(
      "id, status, started_at, ended_at, metered_minutes, job_title:config->>job_title, interview_type:config->>interview_type"
    )
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[Interview] Failed to get interview history:", error);
    throw new Error(`Failed to get interview history: ${error.message}`);
  }

  return data as InterviewSessionListItem[];
}

/** The user's currently-running session, if any. */
export async function getActiveSession(
  userId: string
): Promise<InterviewSession | null> {
  const { data, error } = await supabaseAdmin
    .from("interviews")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[Interview] Failed to get active session:", error);
    throw new Error(`Failed to get active session: ${error.message}`);
  }

  return (data?.[0] as InterviewSession) ?? null;
}

/**
 * Force-close a session that was left `active` (client crashed, force-quit,
 * lost network) without billing for the idle wall-clock time.
 *
 * `ended_at` is backdated to the last minute we actually metered rather than
 * "now", so closing a session that's been open for days doesn't retroactively
 * charge for days. Settlement is skipped for the same reason.
 */
export async function completeStaleSession(
  session: InterviewSession
): Promise<string> {
  const metered = Number(session.metered_minutes ?? 0);
  const startMs = new Date(session.started_at).getTime();
  const endedAt = new Date(startMs + metered * 60_000).toISOString();

  const { error } = await supabaseAdmin
    .from("interviews")
    .update({ status: "ended", ended_at: endedAt })
    .eq("id", session.id);

  if (error) {
    console.error("[Interview] Failed to complete stale session:", error);
    throw new Error(`Failed to complete session: ${error.message}`);
  }

  return endedAt;
}

/**
 * Delete a session and everything under it.
 *
 * `transcripts` and `ai_answers` are removed by ON DELETE CASCADE; the ledger
 * keeps its rows (with `interview_id` nulled by ON DELETE SET NULL) so deleting
 * a session never erases the record of credits already spent on it.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("interviews").delete().eq("id", sessionId);

  if (error) {
    console.error("[Interview] Failed to delete session:", error);
    throw new Error(`Failed to delete session: ${error.message}`);
  }
}

/**
 * Sweep sessions still marked `active` long after anyone stopped metering them.
 *
 * Runs periodically so abandoned sessions don't sit "active" forever, block the
 * UI, or look like live sessions. Safe to run repeatedly.
 */
export async function closeStaleSessions(olderThanHours = 6): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("interviews")
    .select("*")
    .eq("status", "active")
    .lt("started_at", cutoff);

  if (error) {
    console.error("[Interview] Failed to query stale sessions:", error);
    return 0;
  }

  const stale = (data ?? []) as InterviewSession[];
  let closed = 0;

  for (const session of stale) {
    // Skip anything still actively being billed — it's genuinely running.
    if (isMetering(session.id)) continue;
    try {
      await completeStaleSession(session);
      closed++;
    } catch (err) {
      console.error(`[Interview] Failed to close stale session ${session.id}:`, err);
    }
  }

  if (closed > 0) {
    console.log(`[Interview] Auto-closed ${closed} stale session(s)`);
  }

  return closed;
}

/**
 * Get dashboard Overview stats (total sessions, minutes practiced, last
 * session date) via a single Postgres aggregate (see migration 002) —
 * computed across ALL of the user's sessions, not just the capped/paginated
 * list `getInterviewHistory` returns, so it stays accurate for power users
 * with more than 100 sessions.
 */
export async function getInterviewStats(userId: string): Promise<InterviewStats> {
  const { data, error } = await supabaseAdmin
    .rpc("get_interview_stats", { p_user_id: userId })
    .single();

  if (error) {
    console.error("[Interview] Failed to get interview stats:", error);
    throw new Error(`Failed to get interview stats: ${error.message}`);
  }

  const row = data as {
    total_sessions: number;
    total_minutes: number;
    last_session_at: string | null;
  };

  return {
    totalSessions: Number(row.total_sessions),
    totalMinutes: Number(row.total_minutes),
    lastSessionAt: row.last_session_at,
  };
}

/** Get full details of a session including transcripts and AI answers */
export async function getInterviewDetails(
  sessionId: string,
  userId: string
): Promise<{
  session: InterviewSession;
  transcripts: TranscriptEntry[];
  answers: any[];
}> {
  // First verify the session belongs to the user
  const session = await getSession(sessionId);
  if (!session || session.user_id !== userId) {
    throw new Error("Session not found or unauthorized");
  }

  const { data: transcripts, error: transcriptsError } = await supabaseAdmin
    .from("transcripts")
    .select("*")
    .eq("interview_id", sessionId)
    .order("timestamp", { ascending: true });

  if (transcriptsError) {
    console.error("[Interview] Failed to get transcripts:", transcriptsError);
  }

  const { data: answers, error: answersError } = await supabaseAdmin
    .from("ai_answers")
    .select("*")
    .eq("interview_id", sessionId)
    .order("created_at", { ascending: true });

  if (answersError) {
    console.error("[Interview] Failed to get AI answers:", answersError);
  }

  return {
    session,
    transcripts: transcripts || [],
    answers: answers || [],
  };
}

/** End a session — save transcript, answers, and mark as ended */
export async function endSession(
  sessionId: string,
  transcript: TranscriptEntry[],
  answers: Array<{ answer: string; timestamp: string }>,
  endedAt: string
): Promise<void> {
  // Read before updating so we can reconcile credits against the real elapsed
  // time and what was already metered during the live session.
  const existing = await getSession(sessionId);

  // 1. Update session status
  const { error: updateError } = await supabaseAdmin
    .from("interviews")
    .update({
      status: "ended",
      ended_at: endedAt,
    })
    .eq("id", sessionId);

  if (updateError) {
    console.error("[Interview] Failed to end session:", updateError);
    throw new Error(`Failed to end session: ${updateError.message}`);
  }

  // 1b. Reconcile credits — charge only the minutes not already metered by the
  // live socket loop. Covers the partial final minute plus any ticks lost to a
  // server restart, and because it charges the delta it can't double-charge.
  if (existing) {
    await reconcileSessionCredits(existing, endedAt);
  }

  // 2. Bulk-insert transcript entries
  if (transcript && transcript.length > 0) {
    const transcriptRows = transcript.map((t) => ({
      interview_id: sessionId,
      speaker: t.speaker,
      text: t.text,
      is_final: t.is_final ?? true,
      timestamp: t.timestamp || new Date().toISOString(),
    }));

    const { error: transcriptError } = await supabaseAdmin
      .from("transcripts")
      .insert(transcriptRows);

    if (transcriptError) {
      console.error("[Interview] Failed to save transcripts:", transcriptError);
      // Non-fatal — don't throw, session is already ended
    }
  }

  // Note: AI Answers are inserted in real-time by the copilot socket. 
  // We no longer bulk insert them here to prevent duplicates and missing question text.

  console.log(`[Interview] Session ${sessionId} ended successfully`);
}

/** Save a single AI answer to the database */
export async function saveAIAnswer(
  interviewId: string,
  question: string,
  answer: string,
  type: "transcript" | "manual" | "screen"
): Promise<void> {
  const { error } = await supabaseAdmin.from("ai_answers").insert({
    interview_id: interviewId,
    question,
    answer,
    type,
  });

  if (error) {
    console.error("[Interview] Failed to save AI answer:", error);
    // Non-fatal
  }
}
