import { supabaseAdmin } from "../lib/supabase.js";
import type { InterviewConfig, InterviewSession, TranscriptEntry } from "../types/index.js";

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

/** Get a user's interview history (all sessions) */
export async function getInterviewHistory(
  userId: string
): Promise<InterviewSession[]> {
  const { data, error } = await supabaseAdmin
    .from("interviews")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false });

  if (error) {
    console.error("[Interview] Failed to get interview history:", error);
    throw new Error(`Failed to get interview history: ${error.message}`);
  }

  return data as InterviewSession[];
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
