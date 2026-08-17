-- PathMaker4u Backend — Credit System
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- 1 credit = 1 minute of live interview time. See CREDITS.md for the full design.

-- ─── Credit accounts (current balance, one row per user) ──────────
CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance             INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_purchased  INTEGER NOT NULL DEFAULT 0,
  lifetime_used       INTEGER NOT NULL DEFAULT 0,
  free_granted        BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Credit ledger (append-only audit trail) ──────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL CHECK (delta <> 0),
  balance_after INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('grant', 'purchase', 'debit', 'refund', 'adjustment')),
  interview_id  UUID REFERENCES interviews(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user_created
  ON credit_transactions(user_id, created_at DESC);

-- ─── Tracks minutes already charged per session ───────────────────
-- Makes metering crash-safe: end-of-session reconciliation charges only
-- ceil(elapsed) - metered_minutes, so a minute is never billed twice.
ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS metered_minutes INTEGER NOT NULL DEFAULT 0;

-- ─── RLS ──────────────────────────────────────────────────────────
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own credit account" ON credit_accounts;
CREATE POLICY "Users can view own credit account"
  ON credit_accounts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own transactions" ON credit_transactions;
CREATE POLICY "Users can view own transactions"
  ON credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

-- Note: no INSERT/UPDATE policies. Balance changes happen exclusively through
-- the SECURITY DEFINER functions below, called by the service role.

-- ─── Ensure an account exists (lazy creation + one-time signup bonus) ──
CREATE OR REPLACE FUNCTION ensure_credit_account(
  p_user_id UUID,
  p_free_credits INTEGER DEFAULT 0
)
RETURNS TABLE (
  balance INTEGER,
  lifetime_purchased INTEGER,
  lifetime_used INTEGER,
  free_granted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  INSERT INTO credit_accounts (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Grant the signup bonus exactly once. The WHERE guard means concurrent
  -- callers can't both grant it.
  IF p_free_credits > 0 THEN
    UPDATE credit_accounts
       SET balance      = credit_accounts.balance + p_free_credits,
           free_granted = true,
           updated_at   = now()
     WHERE credit_accounts.user_id = p_user_id
       AND credit_accounts.free_granted = false
    RETURNING credit_accounts.balance INTO v_new_balance;

    IF v_new_balance IS NOT NULL THEN
      INSERT INTO credit_transactions (user_id, delta, balance_after, type, note)
      VALUES (p_user_id, p_free_credits, v_new_balance, 'grant', 'Welcome bonus');
    END IF;
  END IF;

  RETURN QUERY
    SELECT a.balance, a.lifetime_purchased, a.lifetime_used, a.free_granted
      FROM credit_accounts a
     WHERE a.user_id = p_user_id;
END;
$$;

-- ─── Grant credits (purchase / bonus / adjustment) ────────────────
CREATE OR REPLACE FUNCTION grant_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_type TEXT DEFAULT 'purchase',
  p_note TEXT DEFAULT NULL
)
RETURNS TABLE (balance INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Grant amount must be positive, got %', p_amount;
  END IF;

  INSERT INTO credit_accounts (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE credit_accounts
     SET balance            = credit_accounts.balance + p_amount,
         lifetime_purchased = credit_accounts.lifetime_purchased
                              + CASE WHEN p_type = 'purchase' THEN p_amount ELSE 0 END,
         updated_at         = now()
   WHERE credit_accounts.user_id = p_user_id
  RETURNING credit_accounts.balance INTO v_balance;

  INSERT INTO credit_transactions (user_id, delta, balance_after, type, note)
  VALUES (p_user_id, p_amount, v_balance, p_type, p_note);

  RETURN QUERY SELECT v_balance;
END;
$$;

-- ─── Debit credits (metering) ─────────────────────────────────────
-- Returns success=false rather than raising when funds are short, so the
-- metering loop can end the session gracefully.
CREATE OR REPLACE FUNCTION debit_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_interview_id UUID DEFAULT NULL,
  p_note TEXT DEFAULT NULL
)
RETURNS TABLE (success BOOLEAN, balance INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Debit amount must be positive, got %', p_amount;
  END IF;

  -- The balance >= p_amount guard makes the check-and-subtract atomic:
  -- concurrent debits serialise on this row, so the balance can't go negative.
  UPDATE credit_accounts
     SET balance       = credit_accounts.balance - p_amount,
         lifetime_used = credit_accounts.lifetime_used + p_amount,
         updated_at    = now()
   WHERE credit_accounts.user_id = p_user_id
     AND credit_accounts.balance >= p_amount
  RETURNING credit_accounts.balance INTO v_balance;

  IF v_balance IS NULL THEN
    RETURN QUERY
      SELECT false, COALESCE((SELECT a.balance FROM credit_accounts a WHERE a.user_id = p_user_id), 0);
    RETURN;
  END IF;

  INSERT INTO credit_transactions (user_id, delta, balance_after, type, interview_id, note)
  VALUES (p_user_id, -p_amount, v_balance, 'debit', p_interview_id, p_note);

  RETURN QUERY SELECT true, v_balance;
END;
$$;
