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
  /** Minutes already charged against this session (see CREDITS.md §4) */
  metered_minutes?: number;
}

/** Slim projection returned by the history list endpoint (no full config/CV blob) */
export interface InterviewSessionListItem {
  id: string;
  status: "active" | "ended";
  started_at: string;
  ended_at: string | null;
  job_title: string | null;
  interview_type: string | null;
}

/** Dashboard Overview aggregate, computed DB-side across ALL of the user's sessions */
export interface InterviewStats {
  totalSessions: number;
  totalMinutes: number;
  lastSessionAt: string | null;
}

// ─── Credits ──────────────────────────────────────────────────────

export interface CreditBalance {
  balance: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
  freeGranted: boolean;
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  /** Extra credits included free with the pack */
  bonus: number;
  /** Price in the currency's minor unit (paise for INR, cents for USD) */
  priceMinor: number;
  currency: string;
  popular: boolean;
}

export interface CreditTransaction {
  id: string;
  delta: number;
  balance_after: number;
  type: "grant" | "purchase" | "debit" | "refund" | "adjustment";
  interview_id: string | null;
  note: string | null;
  created_at: string;
}

/**
 * A billing-history row. Per-minute interview debits are collapsed into a
 * single entry per session — the raw ledger stays intact underneath, this is
 * just the readable view of it.
 */
export interface CreditActivityItem {
  id: string;
  /** "session" = many minute-debits rolled up; "entry" = one ledger row */
  kind: "session" | "entry";
  type: CreditTransaction["type"];
  /** Net credits: negative for usage, positive for grants/purchases */
  delta: number;
  balance_after: number;
  note: string | null;
  interview_id: string | null;
  /** Most recent event in this group — what the list sorts by */
  created_at: string;
  /** First event in the group (session start) */
  started_at: string;
  /** Minutes charged, for session rows */
  minutes?: number;
  jobTitle?: string | null;
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

/** Where an answer was triggered from — drives how the client labels it. */
export type AnswerSource = "transcript" | "manual" | "screen";

export interface AIAnswerStartEvent {
  sessionId: string;
  /** The question being answered, so the client can show it while streaming */
  question: string;
  source: AnswerSource;
  timestamp: string;
}

export interface AIAnswerChunkEvent {
  sessionId: string;
  chunk: string;
  timestamp: string;
}

export interface AIAnswerEvent {
  sessionId: string;
  /** The question this answer responds to */
  question: string;
  source: AnswerSource;
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
