// ─── Interview Session ────────────────────────────────────────────

export interface InterviewConfig {
  role?: string;
  company?: string;
  experienceLevel?: string;
  jobDescription?: string;
  [key: string]: unknown;
}

export interface InterviewSession {
  id: string;
  user_id: string;
  config: InterviewConfig;
  status: "active" | "ended";
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

// ─── Transcript ───────────────────────────────────────────────────

export interface TranscriptEntry {
  speaker: "user" | "interviewer";
  text: string;
  is_final: boolean;
  timestamp: string;
}

// ─── AI Answer ────────────────────────────────────────────────────

export interface AIAnswerRecord {
  id: string;
  interview_id: string;
  question: string;
  answer: string;
  type: "transcript" | "manual" | "screen";
  created_at: string;
}

// ─── Socket Events (Client → Server) ─────────────────────────────

export interface JoinSessionPayload {
  sessionId: string;
  userId: string;
}

export interface TranscriptFinalPayload {
  sessionId: string;
  text: string;
  isFinal: boolean;
  language?: string;
  timestamp: string;
}

export interface ManualQuestionPayload {
  sessionId: string;
  question: string;
  language?: string;
}

export interface ScreenCapturePayload {
  sessionId: string;
  mimeType: string;
  uint8Array: Uint8Array;
}

export interface SetAnswerModePayload {
  sessionId: string;
  mode: "auto" | "normal";
}

export interface RequestAnswerPayload {
  sessionId: string;
  text: string;
  language?: string;
}

// ─── Socket Events (Server → Client) ─────────────────────────────

export interface AIAnswerStartEvent {
  sessionId: string;
  timestamp: string;
}

export interface AIAnswerChunkEvent {
  sessionId: string;
  chunk: string;
  timestamp: string;
}

export interface AIAnswerEvent {
  sessionId: string;
  answer: string;
  timestamp: string;
}

// ─── Express Request Extension ────────────────────────────────────

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
