-- CoPrep Backend — Initial Database Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- ─── Interviews ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  config      JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_interviews_user_id ON interviews(user_id);
CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews(status);

-- ─── Transcripts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transcripts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  speaker       TEXT NOT NULL CHECK (speaker IN ('user', 'interviewer')),
  text          TEXT NOT NULL,
  is_final      BOOLEAN NOT NULL DEFAULT true,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_interview_id ON transcripts(interview_id);

-- ─── AI Answers ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_answers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question      TEXT NOT NULL DEFAULT '',
  answer        TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'transcript' CHECK (type IN ('transcript', 'manual', 'screen')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_answers_interview_id ON ai_answers(interview_id);

-- ─── Row Level Security ───────────────────────────────────────────
-- Enable RLS on all tables (service-role key bypasses RLS by default)
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_answers ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only read their own interviews
CREATE POLICY "Users can view own interviews"
  ON interviews FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Users can insert their own interviews
CREATE POLICY "Users can create own interviews"
  ON interviews FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own interviews
CREATE POLICY "Users can update own interviews"
  ON interviews FOR UPDATE
  USING (auth.uid() = user_id);
