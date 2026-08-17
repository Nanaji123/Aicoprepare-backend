import { supabaseAdmin } from "../lib/supabase.js";
import type {
  CreditActivityItem,
  CreditBalance,
  CreditPack,
  CreditTransaction,
} from "../types/index.js";

/**
 * Credit system — 1 credit = 1 minute of live interview time.
 * See CREDITS.md for the full design, failure modes and payment-gateway plan.
 *
 * All balance mutations go through the Postgres functions defined in
 * migration 003 so that check-and-subtract is atomic; never read-modify-write
 * a balance in application code.
 */

/** Minutes of interview time one credit buys. */
export const CREDITS_PER_MINUTE = 1;

/** Credits granted once, on first access of a new account. */
export const SIGNUP_BONUS_CREDITS = 10;

/** Currency all packs are priced in. */
export const CREDIT_CURRENCY = "INR";

/**
 * Price of one credit in the currency's minor unit (paise).
 * ₹3 per credit = per minute of interview time.
 */
export const CREDIT_PRICE_MINOR = 300;

function buildPack(
  id: string,
  name: string,
  credits: number,
  popular = false
): CreditPack {
  return {
    id,
    name,
    credits,
    bonus: 0,
    // Flat rate — every pack is credits × ₹3, so the headline price always
    // reconciles with the "1 credit = 1 minute = ₹3" promise.
    priceMinor: credits * CREDIT_PRICE_MINOR,
    currency: CREDIT_CURRENCY,
    popular,
  };
}

/**
 * Purchasable packs. Static catalogue — when a real payment gateway is added,
 * `priceMinor` becomes the amount charged and the gateway webhook grants
 * `credits + bonus`. Never grant from a client-side callback.
 */
export const CREDIT_PACKS: CreditPack[] = [
  buildPack("starter", "Starter", 100),
  buildPack("practice", "Practice", 300, true),
  buildPack("intensive", "Intensive", 500),
];

export function getPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === packId);
}

/**
 * Read a user's balance, lazily creating the account and granting the signup
 * bonus on first ever call. Safe to call on every request — the bonus is
 * guarded by `free_granted` inside the DB function.
 */
export async function getBalance(userId: string): Promise<CreditBalance> {
  const { data, error } = await supabaseAdmin
    .rpc("ensure_credit_account", {
      p_user_id: userId,
      p_free_credits: SIGNUP_BONUS_CREDITS,
    })
    .single();

  if (error) {
    console.error("[Credits] Failed to get balance:", error);
    throw new Error(`Failed to get credit balance: ${error.message}`);
  }

  const row = data as {
    balance: number;
    lifetime_purchased: number;
    lifetime_used: number;
    free_granted: boolean;
  };

  return {
    balance: Number(row.balance),
    lifetimePurchased: Number(row.lifetime_purchased),
    lifetimeUsed: Number(row.lifetime_used),
    freeGranted: row.free_granted,
  };
}

/** Add credits (purchase, bonus or manual adjustment). */
export async function grantCredits(
  userId: string,
  amount: number,
  type: "grant" | "purchase" | "refund" | "adjustment" = "purchase",
  note?: string
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .rpc("grant_credits", {
      p_user_id: userId,
      p_amount: amount,
      p_type: type,
      p_note: note ?? null,
    })
    .single();

  if (error) {
    console.error("[Credits] Failed to grant credits:", error);
    throw new Error(`Failed to grant credits: ${error.message}`);
  }

  return Number((data as { balance: number }).balance);
}

/**
 * Spend credits. Returns `success: false` (rather than throwing) when the
 * balance is insufficient, so the metering loop can end the session cleanly.
 */
export async function debitCredits(
  userId: string,
  amount: number,
  interviewId?: string,
  note?: string
): Promise<{ success: boolean; balance: number }> {
  const { data, error } = await supabaseAdmin
    .rpc("debit_credits", {
      p_user_id: userId,
      p_amount: amount,
      p_interview_id: interviewId ?? null,
      p_note: note ?? null,
    })
    .single();

  if (error) {
    console.error("[Credits] Failed to debit credits:", error);
    // Treat a DB failure as "couldn't charge" rather than throwing — the
    // end-of-session reconciliation will catch up on any missed minutes.
    return { success: false, balance: 0 };
  }

  const row = data as { success: boolean; balance: number };
  return { success: row.success, balance: Number(row.balance) };
}

/** Has the user got enough credits to start a session at all? */
export async function hasCreditsToStart(userId: string): Promise<boolean> {
  const { balance } = await getBalance(userId);
  return balance >= CREDITS_PER_MINUTE;
}

/** Paginated ledger for the billing page. */
export async function listTransactions(
  userId: string,
  limit = 50
): Promise<CreditTransaction[]> {
  const { data, error } = await supabaseAdmin
    .from("credit_transactions")
    .select("id, delta, balance_after, type, note, interview_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[Credits] Failed to list transactions:", error);
    throw new Error(`Failed to list transactions: ${error.message}`);
  }

  return data as CreditTransaction[];
}

/**
 * Billing history with per-minute interview debits rolled up per session.
 *
 * The ledger records one row per metered minute, which is right for auditing
 * but unreadable as a history ("−1, −1, −1, …"). This collapses all debits
 * belonging to one interview into a single row showing the total time, while
 * leaving grants, purchases and adjustments as individual entries.
 *
 * The raw ledger is unchanged — see listTransactions for the audit view.
 */
export async function listActivity(
  userId: string,
  limit = 50,
  offset = 0
): Promise<CreditActivityItem[]> {
  // Grouping happens after fetching, so paging can't be pushed into SQL: a
  // single long session collapses dozens of ledger rows into one item. Pull a
  // window wide enough to cover everything up to the requested page, then slice.
  const raw = await listTransactions(
    userId,
    Math.min((offset + limit) * 20, 2000)
  );

  const sessions = new Map<string, CreditActivityItem>();
  const items: CreditActivityItem[] = [];

  for (const tx of raw) {
    // Only interview usage groups; everything else stands alone.
    const groupable = tx.type === "debit" && tx.interview_id;

    if (!groupable) {
      items.push({
        id: tx.id,
        kind: "entry",
        type: tx.type,
        delta: tx.delta,
        balance_after: tx.balance_after,
        note: tx.note,
        interview_id: tx.interview_id,
        created_at: tx.created_at,
        started_at: tx.created_at,
      });
      continue;
    }

    const key = tx.interview_id as string;
    const existing = sessions.get(key);

    if (!existing) {
      // Rows arrive newest-first, so the first one seen is the latest —
      // its balance_after is the balance at the end of the session.
      sessions.set(key, {
        id: `session:${key}`,
        kind: "session",
        type: "debit",
        delta: tx.delta,
        balance_after: tx.balance_after,
        note: null,
        interview_id: key,
        created_at: tx.created_at,
        started_at: tx.created_at,
        minutes: Math.abs(tx.delta),
      });
      continue;
    }

    existing.delta += tx.delta;
    existing.minutes = Math.abs(existing.delta);
    // Older row — it moves the session's start earlier.
    if (tx.created_at < existing.started_at) existing.started_at = tx.created_at;
  }

  items.push(...sessions.values());

  // Label session rows with the interview they belong to.
  const interviewIds = [...sessions.keys()];
  if (interviewIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("interviews")
      .select("id, job_title:config->>job_title")
      .in("id", interviewIds);

    if (error) {
      console.error("[Credits] Failed to label sessions:", error);
    } else {
      const titles = new Map(
        (data as { id: string; job_title: string | null }[]).map((r) => [
          r.id,
          r.job_title,
        ])
      );
      for (const item of sessions.values()) {
        item.jobTitle = titles.get(item.interview_id as string) ?? null;
      }
    }
  }

  items.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return items.slice(offset, offset + limit);
}
