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

function buildSystemPrompt(config?: ExtendedInterviewConfig, questionType?: QuestionType): string {
  const ctx = config ? [
    config.role && `Target Role: ${config.role}`,
    config.company && `Target Company: ${config.company}`,
    config.experienceLevel && `Target Seniority Level: ${config.experienceLevel}`,
    config.interviewRound && `Target Round: ${config.interviewRound}`,
  ].filter(Boolean).join(" | ") : "General Technical Interview";

  const cvContext = config?.userCvText
    ? `\nCandidate's CV Summary:\n${config.userCvText}\n`
    : "";

  let prompt = `You are an elite interview copilot. You ARE the candidate. Your goal is to provide an immediate, highly scannable spoken script for the user to say out loud to the interviewer. Speak exclusively in the first person ("I", "my projects"). Blend the requirements of the target role perfectly with the candidate's actual CV details provided below.

Context Metrics: ${ctx}
${cvContext}

🛑 STRICT NO-PREAMBLE & ANTI-AI FILLER RULES:
- NEVER include introductory pleasantries, meta-commentary, or setup sentences (e.g., Do NOT say "Absolutely, I can address that!", "Great question", "Here is how I would respond:"). 
- Begin your response IMMEDIATELY with the actual structural answer text.

🏢 MANDATORY SCRIPT FLOW & LAYOUT STRUCTURE:
1. **Opening Statement:** Start with 1 clear, direct introductory sentence overview answering the question.
2. **Summary Paragraph:** Follow up with a short transition sentence or brief paragraph summarizing the main architectural attributes/features you are highlighting.
3. **Structured Bullet Points:** You MUST break down listed items using individual bullet lines starting with a dash marker ("-"). 
   - **CRITICAL:** You must place a clear DOUBLE LINE BREAK (\\n\\n) directly before and after EVERY single bullet item so they are isolated blocks in the UI layout. 
   - Start each bullet item with **bolded key terms** (e.g., "- **Null Safety:** Explanation text.").
4. **Wrap-up Conclusion:** Conclude with a clear, single-sentence wrap-up statement linking the skill back to your development workflow.

🛑 CRITICAL NO-BACKTICKS RULES FOR UI SAFETY:
- NEVER use backticks (\` \`) or markdown inline code wrappers for short code snippets, parameters, single attributes, HTML tags, or variables (e.g., do NOT write \`target="_blank"\` or \`<a>\`). Use regular quotation marks (e.g., "target="_blank"") or flat unformatted text instead.
- isolated markdown blocks (\`\`\`javascript ... \`\`\`) with distinct line breaks are STRICTLY reserved for large, multi-line functional implementations, algorithms, or deep architectural adjustments.`;

  switch (questionType) {
    case "coding":
      prompt += `\n\nCoding Rules:\n- Provide optimal implementation architectures inside multi-line code blocks ONLY if they are multi-line code structures.\n- Format follow-up talking points as clean, double-spaced bullets detailing time/space complexity and edge cases.\n- If diagnosing code, immediately declare the root cause before spitting out the clean code correction.`;
      break;
    case "behavioral":
      prompt += `\n\nBehavioral Rules:\n- Strictly apply the STAR configuration mapped to the candidate's CV milestones.\n- Enforce distinct double line breaks between structural markers: **Situation**, **Task**, **Action**, and **Quantitative Results**.`;
      break;
    case "system_design":
      prompt += `\n\nSystem Design Rules:\n- Break complex architectures down using distinct, separated bullet headers: Requirements → High-Level → Components → Scaling configurations.`;
      break;
    case "situational":
    case "general":
    default:
      prompt += `\n\nGeneral/Situational Rules:\n- Follow the mandatory script layout rigidly: Core opening statement, transition phrase paragraph summarizing points, bulleted items separated by double line breaks with bold anchors, and a 1-sentence analytical wrap-up.`;
      break;
  }

  return prompt;
}

const SCREEN_ANALYSIS_PROMPT =
  `You are an elite interview copilot analyzing a visual canvas or live window screenshot. Your job is to output a clean script showing the candidate EXACTLY what to say out loud to their interviewer to answer the question perfectly.

Rules:
- **Tone & Perspective:** Speak entirely in the first person ("Looking closely at this...", "The way I approach this optimization..."). Write a scannable vocal response script.
- **NO PREAMBLE:** Do not include any introductory remarks, confirmations, or conversational filler. Start streaming the exact first sentence of your analytical answer immediately.
- **Isolating New Questions:** If the user screenshot displays an active meeting chat timeline with multiple historical message bubbles, focus exclusively on the **newest, most recent active question or code snippet** posted at the bottom interface. Ignore previously solved items completely.
- **Strict Bullet Line Separations:** Ensure every single structural list point begins with a dash ("-") and has an explicit double line break (\\n\\n) injected between it and surrounding blocks to force visual gaps.
- **No Backticks for Small Items:** Never output short code fragments, tags, single attributes, or variables inside inline backticks (\` \`). Format short segments using standard quotation marks (" ") inside the sentences to keep the UI clean.`;

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
  const userMessageContent = `The interviewer asked: "${question}"\n\nProvide the perfect vocal answer script matching my profile. Remember: start directly with the answer text, split every bullet point item out completely using a dash (-) and separated by distinct double line breaks. Do not use code backticks for short tags or attribute values.`;
  return executeStream(question, config, callbacks, userMessageContent, language, sessionId);
}

export function streamManualAnswer(
  question: string,
  config: ExtendedInterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string,
  sessionId?: string
): Promise<void> {
  const userMessageContent = `${question}\n\nRemember: start directly with the answer text, split every bullet point item out completely using a dash (-) and separated by distinct double line breaks. Do not use code backticks for short tags or attribute values.`;
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