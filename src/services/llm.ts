import OpenAI from "openai";
import sharp from "sharp";
import { env } from "../config/env.js";
import type { InterviewConfig } from "../types/index.js";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

// ─── Extended Types ────────────────────────────────────────────────

export interface ExtendedInterviewConfig extends InterviewConfig {
  interviewRound?: string;
  userCvText?: string;
  interviewType?: string;
  jobDescription?: string;
}

/** The shape the web actually sends (snake_case), stored verbatim in `config`. */
interface RawSessionConfig {
  job_title?: string;
  interview_type?: string;
  experience_level?: string;
  interview_round?: string;
  user_cv_text?: string;
  job_description?: string;
}

/**
 * Reconcile the session config with the field names the prompt expects.
 *
 * The dashboard writes snake_case keys (`job_title`, `user_cv_text`, …) while
 * this module reads camelCase (`role`, `userCvText`, …). Nothing translated
 * between them, so every prompt was being built with an empty context and no
 * CV. Accept both spellings and prefer whichever is present.
 */
export function normalizeConfig(
  config?: ExtendedInterviewConfig
): ExtendedInterviewConfig | undefined {
  if (!config) return undefined;

  const raw = config as ExtendedInterviewConfig & RawSessionConfig;

  return {
    ...config,
    role: raw.role || raw.job_title,
    company: raw.company,
    experienceLevel: raw.experienceLevel || raw.experience_level,
    interviewRound: raw.interviewRound || raw.interview_round,
    interviewType: raw.interviewType || raw.interview_type,
    jobDescription: raw.jobDescription || raw.job_description,
    userCvText: raw.userCvText || raw.user_cv_text,
  };
}

interface MemoryEntry {
  role: "user" | "assistant";
  content: string;
}

// ─── Conversation Memory ───────────────────────────────────────────

class ConversationMemory {
  private sessions = new Map<string, MemoryEntry[]>();
  private readonly maxPairs: number;

  constructor(maxPairs = 6) {
    this.maxPairs = maxPairs;
  }

  addExchange(sessionId: string, question: string, answer: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    const history = this.sessions.get(sessionId)!;
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: answer });

    const maxEntries = this.maxPairs * 2;
    if (history.length > maxEntries) {
      this.sessions.set(sessionId, history.slice(-maxEntries));
    }
  }

  getHistory(sessionId: string): MemoryEntry[] {
    return this.sessions.get(sessionId) || [];
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const conversationMemory = new ConversationMemory(6);

// ─── Intent Classifier (needs response?) ───────────────────────────

/**
 * Lightweight intent classifier that determines whether an interviewer's
 * utterance requires the candidate to give a substantive answer.
 *
 * Returns `true` for real questions/prompts, `false` for casual chat,
 * filler, acknowledgments, or context-setting monologues.
 */
export async function needsResponse(text: string): Promise<boolean> {
  // Very short utterances are almost never real questions
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length < 3) return false;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an intent classifier for an interview copilot. Determine if the interviewer's speech requires the candidate to give a substantive answer.

Return "YES" if:
- It's a direct question (technical, behavioral, situational)
- It asks the candidate to explain, describe, or elaborate something
- It requests the candidate to introduce themselves or share experience
- It asks the candidate to solve a problem or write code

Return "NO" if:
- It's casual small talk or pleasantries ("Hi, how are you?", "Nice to meet you")
- It's the interviewer giving context or explaining something without asking
- It's filler speech ("Let me share my screen", "One moment", "Hold on")
- It's acknowledgment ("Sounds good", "Okay", "Got it", "That makes sense")
- It's too short or unclear to be a real question

Respond with ONLY "YES" or "NO".`,
        },
        { role: "user", content: trimmed },
      ],
      max_tokens: 3,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
    console.log(`[Intent Classifier] "${trimmed.substring(0, 60)}..." → ${answer}`);
    return answer === "YES";
  } catch (err) {
    // On error, default to generating a response (safe fallback)
    console.error("[Intent Classifier] Error, defaulting to YES:", err);
    return true;
  }
}

// ─── Question Classification ───────────────────────────────────────

type QuestionType = "coding" | "behavioral" | "system_design" | "situational" | "general";

const CODING_KEYWORDS = ["code", "function", "algorithm", "implement", "write a", "program", "data structure", "array", "fix this", "bug", "error", "wrong in"];
const BEHAVIORAL_KEYWORDS = ["tell me about a time", "describe a situation", "challenge", "conflict", "teamwork", "leadership"];
const SYSTEM_DESIGN_KEYWORDS = ["design", "architect", "system", "scalable", "microservice", "load balancer", "cache", "database design"];
const SITUATIONAL_KEYWORDS = ["what would you do", "how would you approach", "scenario", "deadline", "trade-off"];

function classifyQuestion(question: string): QuestionType {
  const lower = question.toLowerCase();
  const scores: Record<QuestionType, number> = { coding: 0, behavioral: 0, system_design: 0, situational: 0, general: 1 };

  for (const kw of CODING_KEYWORDS) if (lower.includes(kw)) scores.coding += 2;
  for (const kw of BEHAVIORAL_KEYWORDS) if (lower.includes(kw)) scores.behavioral += 2;
  for (const kw of SYSTEM_DESIGN_KEYWORDS) if (lower.includes(kw)) scores.system_design += 2;
  for (const kw of SITUATIONAL_KEYWORDS) if (lower.includes(kw)) scores.situational += 2;

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][0] as QuestionType;
}

// ─── System Prompts ────────────────────────────────────────────────

function buildSystemPrompt(rawConfig?: ExtendedInterviewConfig, questionType?: QuestionType): string {
  // Accepts the dashboard's snake_case config as well as camelCase.
  const config = normalizeConfig(rawConfig);

  const ctx = config ? [
    config.role && `Target Role: ${config.role}`,
    config.company && `Target Company: ${config.company}`,
    config.experienceLevel && `Target Seniority Level: ${config.experienceLevel}`,
    config.interviewRound && `Target Round: ${config.interviewRound}`,
    config.interviewType && `Interview Focus: ${config.interviewType}`,
  ].filter(Boolean).join(" | ") : "General Technical Interview";

  const cvContext = config?.userCvText
    ? `\nCandidate's CV Summary:\n${config.userCvText}\n`
    : "";

  // The job description is the strongest signal for what the interviewer will
  // probe, so it goes in ahead of the generic role label.
  const jdContext = config?.jobDescription
    ? `\nTarget Job Description (tailor answers to these requirements):\n${config.jobDescription}\n`
    : "";

  let prompt = `You are an interview copilot. You ARE the candidate. The person reading you is SITTING IN A LIVE INTERVIEW RIGHT NOW with the interviewer waiting for them to speak.

Everything you write must be words they can say out loud, immediately, exactly as written. You are writing SPEECH, not documentation.

Context Metrics: ${ctx}
${jdContext}${cvContext}

━━ FORMAT ━━
Line 1 — the opening sentence, in **bold**. One or two sentences that directly answer the question. The candidate reads this aloud verbatim and is already answering correctly. This is the most important line you write.

Then bullets, each starting with "- ". Each bullet is ONE COMPLETE SENTENCE the candidate can speak as-is.

**Give 5 bullets** for any question that asks you to explain, describe, justify, or tell a story. That is the default, and it is what makes an answer land as complete rather than thin. Go to 6 or 7 when the question genuinely holds that much.

**Exception — short factual questions.** Some questions have a one-line answer: notice period, salary expectation, years of experience, which database you used, whether you know a language. For these, the bold line IS the whole answer. Add at most ONE short bullet, and only if it carries real information (a constraint, a caveat, a number). Then stop.

Padding a factual question into five bullets is the single worst thing you can do here — it makes the candidate sound rehearsed and evasive, like they are talking to fill silence. "My notice period is two weeks." is a finished answer. Never follow it with lines like "I'm excited about the opportunity" or "I'll ensure a smooth transition" — that is exactly the filler an interviewer notices.

Ask yourself: could a real person answer this in one sentence? If yes, do that.

━━ THE RULE THAT MATTERS MOST ━━
NEVER write a bullet as "label + explanation".

WRONG (this is a document, nobody talks like this):
- **Analytical Skills:** I excel at breaking down complex problems.
- **Team Collaboration:** I have worked in diverse teams.

RIGHT (this is speech, they can just say it):
- I rewrote our billing reconciliation job when it started timing out, and got it from 40 minutes down to under 3.
- When the payments team and I disagreed on the retry strategy, I built a small load test so we could settle it with numbers.

Every bullet must read like a sentence a person says in conversation. If a bullet would sound strange spoken aloud in a room, rewrite it.

━━ BE SPECIFIC, NEVER GENERIC ━━
Vague self-praise is worthless in an interview and interviewers hear straight through it. NEVER write lines like "I consistently strive for excellence", "I thrive in dynamic environments", "I am committed to continuous learning", "I have strong analytical skills".
Instead name the actual thing: the system, the number, the tradeoff, the decision, the outcome. Pull real details from the CV above whenever it is relevant. If you genuinely have no specifics, describe a concrete approach rather than asserting a quality.

━━ LENGTH ━━
Aim for about 150–200 words: enough for five real points, short enough to scan while talking. Keep each individual bullet to roughly one breath — about 15–25 words. Never pad to hit a length; five sharp sentences beat eight vague ones.

━━ NEVER INCLUDE ━━
- Openers like "Great question", "Absolutely", "Certainly", "That's a great point".
- Meta-commentary such as "Here's how I would respond" or "Let me walk you through".
- A summary paragraph that describes what you are about to say. Just say it.
- A wrap-up or conclusion sentence ("Overall...", "In conclusion...", "This demonstrates my..."). Stop at the last real point.
- Headings, numbered sections, or bold labels acting as bullet titles.

━━ VOICE ━━
First person ("I", "my team", "we"). Natural spoken English — contractions are good ("I'd", "we're", "didn't"). Plain words over corporate abstractions. Confident, not boastful.

━━ FORMATTING FOR THE OVERLAY ━━
- NEVER use backticks or inline code wrappers for short snippets, parameters, attributes, tags, or variable names. Write them as plain text or in quotation marks.
- Fenced code blocks (\`\`\`) are ONLY for real multi-line code the candidate would type or talk through.`;

  switch (questionType) {
    case "coding":
      prompt += `

━━ CODING QUESTIONS ━━
- Bold opening line: state the approach in one spoken sentence ("I'd use a hash map to trade space for a single pass.").
- Then the code in one fenced block. Clean and runnable, no commentary inside it.
- After the block, 3–5 spoken bullets: how the approach works in plain words, the time complexity, the space complexity, the edge case you'd call out, and what you'd reach for if the input got much larger.
- If you are diagnosing broken code, say what is wrong in the bold line first, then show the fix.`;
      break;

    case "behavioral":
      prompt += `

━━ BEHAVIORAL QUESTIONS ━━
- Tell it as a story the candidate can speak, using the STAR shape as the ORDER of sentences — not as visible labels.
- Bold opening line: the situation and what was at stake, in one sentence.
- Then five bullets following the STAR arc: what your specific responsibility was, the first thing you actually did, the key decision or obstacle you hit, how you resolved it, and how it turned out with a number if one exists.
- Never print the words "Situation", "Task", "Action" or "Result" as labels. Nobody says those out loud.
- Anchor it in a real project from the CV wherever possible.`;
      break;

    case "system_design":
      prompt += `

━━ SYSTEM DESIGN QUESTIONS ━━
- Bold opening line: restate the constraint that actually drives the design ("At 100M reads a day this is read-heavy, so the cache design matters more than the database choice.").
- Then 5–7 spoken bullets moving through: rough scale numbers, the storage choice and why, the core components, where reads and writes actually go, the one real bottleneck, and how you'd scale past it.
- Each bullet is still a sentence they can say, not a component label.
- Naming a tradeoff you consciously accepted is worth more than listing technologies.
- You may go longer here — up to about 280 words.`;
      break;

    case "situational":
    case "general":
    default:
      prompt += `

━━ GENERAL & SITUATIONAL QUESTIONS ━━
- Bold opening line answers the question directly and plainly. No hedging, no throat-clearing.
- Then five spoken bullets, each adding one concrete point — a real example, a specific decision, a number, a tradeoff, an outcome.
- Vary what each bullet does. Five sentences that all make the same point in different words is worse than three that each add something new.
- This is where generic filler creeps in. Do not let it. If a sentence could appear on any candidate's answer to any question, delete it and write something real.`;
      break;
  }

  return prompt;
}

const SCREEN_ANALYSIS_PROMPT =
  `You are an interview copilot looking at a screenshot of the candidate's screen. They are IN A LIVE INTERVIEW and the interviewer is waiting for them to speak.

Write the words they can say out loud, right now, exactly as written. You are writing SPEECH, not documentation.

━━ WHAT TO ANSWER ━━
Find the question or code the interviewer is actually asking about. If the screenshot shows a chat or meeting timeline with history, answer ONLY the newest message at the bottom — ignore anything already dealt with.

━━ FORMAT ━━
Line 1 — in **bold** — the opening sentence they read aloud verbatim. It answers the question or names what they're looking at and what they'd do about it.

Then bullets, each starting with "- ". Each is ONE COMPLETE SENTENCE they can speak as-is.

**Give 5 bullets** by default — that is what makes the answer feel complete. Drop to 3 or 4 only when the thing on screen is genuinely narrow and more points would be padding.

If the screen shows code that needs writing or fixing, put the code in one fenced block after the bold line, then 3–5 spoken bullets: how it works, the complexity, the edge case, and what you'd change if requirements grew.

━━ THE RULE THAT MATTERS MOST ━━
Never write a bullet as "label + explanation" (e.g. "- **Time Complexity:** It is O(n)."). Write what a person says: "- This runs in linear time because we only touch each element once."

If a line would sound strange said out loud in a room, rewrite it.

━━ NEVER INCLUDE ━━
- "Great question", "Absolutely", "Looking at this screenshot", "I can see that".
- Any description of what you are about to explain. Just explain it.
- A wrap-up or conclusion line. Stop at the last real point.
- Vague filler like "I approach problems analytically". Name the actual observation.

━━ VOICE & FORMATTING ━━
- First person, natural spoken English, contractions welcome.
- Around 150–200 words. Each bullet roughly one breath — 15–25 words.
- Never use backticks for short fragments, tags, attributes or variable names — use plain text or quotation marks. Fenced blocks are only for real multi-line code.`;

// ─── Text Answer Streaming ──────────────────────────────────────────

export interface StreamCallbacks {
  onStart: () => void;
  onChunk: (chunk: string) => void;
  onComplete: (fullAnswer: string) => void;
  onError: (error: string) => void;
}

async function executeStream(
  question: string,
  config: ExtendedInterviewConfig | undefined,
  callbacks: StreamCallbacks,
  userMessageContent: string,
  language?: string,
  sessionId?: string
): Promise<void> {
  try {
    callbacks.onStart();
    const questionType = classifyQuestion(question);
    const languageInstruction = language ? `\n\nIMPORTANT: Respond in ${language}.` : "";

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: buildSystemPrompt(config, questionType) + languageInstruction,
      },
    ];

    if (sessionId) {
      const history = conversationMemory.getHistory(sessionId);
      for (const entry of history) {
        messages.push({ role: entry.role, content: entry.content });
      }
    }

    messages.push({
      role: "user",
      content: userMessageContent,
    });

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      stream: true,
      max_tokens: 2000,
      temperature: 0.3,
      top_p: 0.9,
    });

    let fullAnswer = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullAnswer += content;
        callbacks.onChunk(content);
      }
    }

    if (sessionId) conversationMemory.addExchange(sessionId, question, fullAnswer);
    callbacks.onComplete(fullAnswer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM streaming failed";
    callbacks.onError(message);
  }
}

export function streamAnswer(
  question: string,
  config: ExtendedInterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string,
  sessionId?: string
): Promise<void> {
  const userMessageContent = `The interviewer just asked me: "${question}"\n\nGive me the words to say. Bold first line I can read out verbatim, then short spoken bullets starting with a dash. No labels in front of bullets, no summary of what you're about to say, no wrap-up line, nothing generic. No backticks around short fragments.`;
  return executeStream(question, config, callbacks, userMessageContent, language, sessionId);
}

export function streamManualAnswer(
  question: string,
  config: ExtendedInterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string,
  sessionId?: string
): Promise<void> {
  const userMessageContent = `${question}\n\nGive me the words to say. Bold first line I can read out verbatim, then short spoken bullets starting with a dash. No labels in front of bullets, no summary of what you're about to say, no wrap-up line, nothing generic. No backticks around short fragments.`;
  return executeStream(question, config, callbacks, userMessageContent, language, sessionId);
}

// ─── Visual & Code Context Streaming ──────────────────────────────────

export async function streamScreenAnalysis(
  imageBuffer: Buffer,
  mimeType: string,
  config: ExtendedInterviewConfig | undefined,
  callbacks: StreamCallbacks,
  codeContextText?: string
): Promise<void> {
  try {
    callbacks.onStart();

    // Optimize image before sending to OpenAI
    const optimizedBuffer = await sharp(imageBuffer)
      .resize(1200, 1200, {
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64Image = optimizedBuffer.toString("base64");
    const dataUri = `data:image/jpeg;base64,${base64Image}`;

    const contextPrompt = buildSystemPrompt(config, "coding");

    const textPayload = codeContextText
      ? `Analyze this screenshot along with this context/code text: "${codeContextText}". Provide a highly scannable spoken explanation script addressing the core fix or solution for the interviewer. Start directly without introductory filler. Wrap small code properties or short tags completely in standard quotation marks. Separate list points cleanly with a dash (-) and explicit double line breaks.`
      : "Analyze this screenshot. Pinpoint the targeted problem or newest chat entry and provide a highly scannable spoken explanation script addressing the solution directly to the interviewer. Start directly without introductory filler. Wrap small code properties or short tags completely in standard quotation marks. Separate list points cleanly with a dash (-) and explicit double line breaks.";

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `${contextPrompt}\n\n${SCREEN_ANALYSIS_PROMPT}`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: textPayload },
            {
              type: "image_url",
              image_url: { url: dataUri, detail: "high" },
            },
          ],
        },
      ],
      stream: true,
      max_tokens: 3000,
      temperature: 0.2,
      top_p: 0.9,
    });

    let fullAnswer = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullAnswer += content;
        callbacks.onChunk(content);
      }
    }

    callbacks.onComplete(fullAnswer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vision analysis failed";
    callbacks.onError(message);
  }
}