import { supabaseAdmin } from "../lib/supabase.js";
import { debitCredits, CREDITS_PER_MINUTE } from "./credits.js";
import type { InterviewSession } from "../types/index.js";

/**
 * Session metering — turns elapsed interview time into credit debits.
 *
 * Metering is server-authoritative: the desktop client never reports its own
 * usage. See CREDITS.md §4 for the full model and failure modes.
 */

/** Emits an event to everyone watching a session (supplied by the socket layer). */
export type MeterEmitter = (event: string, payload: unknown) => void;

/** Live metering timers (sessionId → interval). One per active session. */
const meteringTimers = new Map<string, NodeJS.Timeout>();

/** Warn the user when their remaining balance crosses these thresholds. */
const LOW_CREDIT_WARNINGS = [5, 2, 1];

/**
 * Most minutes we'll charge at settlement beyond what was metered live.
 *
 * Without this, a session whose end call arrives days late (client crash, lost
 * network, manual cleanup) would bill every wall-clock minute since it started
 * and wipe out the user's balance. We only ever bill slightly past the last
 * minute we actually observed.
 */
const SETTLEMENT_GRACE_MINUTES = 5;

// ─── Live metering loop ─────────────────────────────────────────────

/**
 * Start charging a session 1 credit per elapsed minute.
 *
 * Idempotent per session — starting twice (e.g. a client reconnecting) will
 * not double-charge.
 */
export function startMetering(
  sessionId: string,
  userId: string,
  emit: MeterEmitter
): void {
  if (meteringTimers.has(sessionId)) return;

  const timer = setInterval(async () => {
    try {
      const { success, balance } = await meterOneMinute(sessionId, userId);

      if (!success) {
        // Out of credits — stop the session rather than giving away time.
        emit("session_terminated", {
          sessionId,
          reason: "INSUFFICIENT_CREDITS",
          message: "You've run out of credits. This session has ended.",
          balance,
        });
        stopMetering(sessionId);
        console.log(`[Metering] Session ${sessionId} terminated — out of credits`);
        return;
      }

      emit("credits_update", { sessionId, balance });

      if (LOW_CREDIT_WARNINGS.includes(balance)) {
        emit("credits_warning", {
          sessionId,
          balance,
          message: `${balance} minute${balance === 1 ? "" : "s"} of credit remaining.`,
        });
      }
    } catch (err) {
      // Never let a metering failure kill the session — settlement will charge
      // for any minutes missed here.
      console.error(`[Metering] Tick failed for session ${sessionId}:`, err);
    }
  }, 60_000);

  meteringTimers.set(sessionId, timer);
  console.log(`[Metering] Started for session ${sessionId}`);
}

/** Stop charging a session (disconnect, leave, end, delete or exhaustion). */
export function stopMetering(sessionId: string): boolean {
  const timer = meteringTimers.get(sessionId);
  if (!timer) return false;
  clearInterval(timer);
  meteringTimers.delete(sessionId);
  console.log(`[Metering] Stopped for session ${sessionId}`);
  return true;
}

/** Is this session currently being billed? */
export function isMetering(sessionId: string): boolean {
  return meteringTimers.has(sessionId);
}

/** How many sessions are being billed right now (for health/diagnostics). */
export function activeMeteringCount(): number {
  return meteringTimers.size;
}

// ─── Charging ───────────────────────────────────────────────────────

/** Charge one minute against a running session. */
export async function meterOneMinute(
  sessionId: string,
  userId: string
): Promise<{ success: boolean; balance: number }> {
  const result = await debitCredits(
    userId,
    CREDITS_PER_MINUTE,
    sessionId,
    "Interview time"
  );

  if (result.success) {
    // Record that this minute has been charged, so settlement doesn't charge
    // for it a second time.
    await incrementMeteredMinutes(sessionId, 1);
  }

  return result;
}

/** Bump the already-charged minute counter for a session. */
async function incrementMeteredMinutes(sessionId: string, by: number): Promise<void> {
  // Read-then-write is safe here: only the one metering loop for this session
  // touches this column, and the credit debit itself is already atomic.
  const { data, error: readError } = await supabaseAdmin
    .from("interviews")
    .select("metered_minutes")
    .eq("id", sessionId)
    .single();

  if (readError) {
    console.error("[Metering] Failed to read metered_minutes:", readError);
    return;
  }

  const current = Number((data as { metered_minutes: number }).metered_minutes ?? 0);

  const { error } = await supabaseAdmin
    .from("interviews")
    .update({ metered_minutes: current + by })
    .eq("id", sessionId);

  if (error) {
    console.error("[Metering] Failed to update metered_minutes:", error);
  }
}

/**
 * Settle a finished session: charge elapsed minutes the live loop didn't cover
 * (the partial final minute, ticks lost to a restart).
 *
 * Charges `ceil(elapsed) - metered_minutes`, capped at SETTLEMENT_GRACE_MINUTES
 * so a late-arriving end call can't bill hours of wall-clock time. It is a
 * no-op when the loop kept up, and can never double-charge.
 */
export async function reconcileSessionCredits(
  session: InterviewSession,
  endedAt: string
): Promise<void> {
  const startMs = new Date(session.started_at).getTime();
  const endMs = new Date(endedAt).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return;
  }

  const elapsedMinutes = Math.ceil((endMs - startMs) / 60000);
  const alreadyMetered = Number(session.metered_minutes ?? 0);

  const billable = Math.min(elapsedMinutes, alreadyMetered + SETTLEMENT_GRACE_MINUTES);
  const outstanding = billable - alreadyMetered;

  if (outstanding <= 0) return;

  const result = await debitCredits(
    session.user_id,
    outstanding * CREDITS_PER_MINUTE,
    session.id,
    `Final settlement (${outstanding} min)`
  );

  // A short balance here means the user ran out mid-session; we charge what we
  // can and let it settle at zero rather than pushing the account negative.
  if (!result.success) {
    console.warn(
      `[Metering] Could not fully settle session ${session.id}: ` +
        `${outstanding} min outstanding, balance ${result.balance}`
    );
    return;
  }

  await incrementMeteredMinutes(session.id, outstanding);
}
