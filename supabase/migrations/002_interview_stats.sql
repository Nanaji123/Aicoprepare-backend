-- PathMaker4u Backend — Interview Stats Aggregate
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Backs the dashboard Overview stats (total sessions / time practiced /
-- last session). Computed entirely in Postgres so the API returns three
-- numbers instead of pulling every session row to compute them client-side.

CREATE OR REPLACE FUNCTION get_interview_stats(p_user_id UUID)
RETURNS TABLE (
  total_sessions BIGINT,
  total_minutes BIGINT,
  last_session_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*) AS total_sessions,
    COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)::bigint, 0) AS total_minutes,
    MAX(started_at) AS last_session_at
  FROM interviews
  WHERE user_id = p_user_id;
$$;
