import OpenAI from "openai";
import { env } from "../config/env.js";
import type { InterviewConfig } from "../types/index.js";

/**
 * LLM Service — handles AI answer generation via Groq (OpenAI-compatible).
 *
 * Features:
 * - Per-session conversation memory (sliding window)
 * - Smart question classification (coding/behavioral/system-design/situational/general)
 * - Question-type-specific prompt routing
 * - Tuned parameters for interview-quality answers
 * - Streaming via callbacks for real-time Socket.IO delivery
 */

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// ─── Conversation Memory ───────────────────────────────────────────

interface MemoryEntry {
  role: "user" | "assistant";
  content: string;
}

/** Per-session sliding-window conversation memory. */
class ConversationMemory {
  private sessions = new Map<string, MemoryEntry[]>();
  private readonly maxPairs: number;

  constructor(maxPairs = 6) {
    this.maxPairs = maxPairs; // Keep last N Q&A pairs (2 entries each)
  }

  /** Add a question + answer pair to the session history. */
  addExchange(sessionId: string, question: string, answer: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    const history = this.sessions.get(sessionId)!;
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: answer });

    // Trim to sliding window (maxPairs * 2 entries)
    const maxEntries = this.maxPairs * 2;
    if (history.length > maxEntries) {
      this.sessions.set(sessionId, history.slice(-maxEntries));
    }
  }

  /** Get conversation history as OpenAI-compatible messages. */
  getHistory(sessionId: string): MemoryEntry[] {
    return this.sessions.get(sessionId) || [];
  }

  /** Clear session memory (on leave/disconnect). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const conversationMemory = new ConversationMemory(6);

// ─── Question Classification ───────────────────────────────────────

type QuestionType = "coding" | "behavioral" | "system_design" | "situational" | "general";

const CODING_KEYWORDS = [
  "code", "function", "algorithm", "implement", "write a", "program",
  "data structure", "array", "linked list", "tree", "graph", "hash",
  "sort", "search", "binary", "dynamic programming", "recursion",
  "time complexity", "space complexity", "big o", "leetcode",
  "reverse", "palindrome", "fibonacci", "two sum", "matrix",
  "stack", "queue", "heap", "trie", "dfs", "bfs",
  "api", "endpoint", "database query", "sql", "regex",
  "debug", "bug", "error", "fix this", "what's wrong",
];

const BEHAVIORAL_KEYWORDS = [
  "tell me about a time", "describe a situation", "give me an example",
  "how did you handle", "what would you do if", "challenge",
  "conflict", "failure", "mistake", "difficult", "teamwork",
  "leadership", "mentor", "feedback", "disagreement",
  "proud of", "achievement", "accomplishment", "overcame",
  "tell me about yourself", "why should we hire", "strengths",
  "weaknesses", "where do you see yourself",
];

const SYSTEM_DESIGN_KEYWORDS = [
  "design", "architect", "system", "scalab", "microservice",
  "load balancer", "cache", "database design", "distributed",
  "high availability", "throughput", "latency", "cdn",
  "message queue", "kafka", "redis", "sharding", "replication",
  "api gateway", "rate limit", "url shortener", "chat system",
  "notification", "newsfeed", "payment", "search engine",
];

const SITUATIONAL_KEYWORDS = [
  "what would you do", "how would you approach", "imagine",
  "scenario", "if you were", "hypothetical", "suppose",
  "how would you handle", "prioritize", "deadline",
  "stakeholder", "trade-off", "decision",
];

function classifyQuestion(question: string): QuestionType {
  const lower = question.toLowerCase();

  // Score each category
  const scores: Record<QuestionType, number> = {
    coding: 0,
    behavioral: 0,
    system_design: 0,
    situational: 0,
    general: 1, // Default bias
  };

  for (const kw of CODING_KEYWORDS) {
    if (lower.includes(kw)) scores.coding += 2;
  }
  for (const kw of BEHAVIORAL_KEYWORDS) {
    if (lower.includes(kw)) scores.behavioral += 2;
  }
  for (const kw of SYSTEM_DESIGN_KEYWORDS) {
    if (lower.includes(kw)) scores.system_design += 2;
  }
  for (const kw of SITUATIONAL_KEYWORDS) {
    if (lower.includes(kw)) scores.situational += 2;
  }

  // Return highest-scoring type
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const result = sorted[0][0] as QuestionType;

  console.log(`[LLM] Question classified as: ${result} (scores: ${JSON.stringify(scores)})`);
  return result;
}

// ─── System Prompts ────────────────────────────────────────────────

function buildSystemPrompt(config?: InterviewConfig, questionType?: QuestionType): string {
  const ctx = config ? [
    config.role && `Role: ${config.role}`,
    config.company && `Company: ${config.company}`,
    config.experienceLevel && `Level: ${config.experienceLevel}`,
    config.jobDescription && `JD: ${config.jobDescription}`,
  ].filter(Boolean).join(" | ") : "General";

  // Base persona
  let prompt = `You are an elite interview copilot. You ARE the candidate — confident, articulate, and technically sharp. You speak from first-person experience with real depth.

Context: ${ctx}

Core Rules:
- Start with a strong opening sentence that directly answers the question.
- Then use **bullet points** with **bold key terms** for the details.
- Sound natural, confident, and human — not robotic or generic.
- Reference specific technologies, metrics, and real-world examples.
- Never say "Here is how I would answer" or similar meta-commentary. Just answer.
- If prior conversation context is provided, reference it naturally ("As I mentioned earlier...", "Building on my previous point...").
- Use Markdown formatting: bold, bullets, code blocks where appropriate.`;

  // Question-type-specific instructions
  switch (questionType) {
    case "coding":
      prompt += `

Coding Question Rules:
- Provide complete, working code with inline comments on key lines.
- State the **time complexity** and **space complexity**.
- Mention edge cases and how the solution handles them.
- If multiple approaches exist, briefly mention the brute-force then present the optimal.
- Use proper code blocks with language tags.`;
      break;

    case "behavioral":
      prompt += `

Behavioral Question Rules:
- Use the **STAR method**: Situation → Task → Action → Result.
- Keep it to 4-5 bullet points maximum.
- Include a specific, quantifiable result when possible (e.g., "reduced latency by 40%").
- Make the story feel real and personal — use specific team names, project names, or technologies.
- End with a brief reflection or lesson learned.`;
      break;

    case "system_design":
      prompt += `

System Design Question Rules:
- Start with **requirements clarification** (1-2 bullets on scope/scale).
- Break into components: **High-Level Architecture** → **Core Components** → **Data Model** → **Scaling**.
- Discuss **trade-offs** explicitly (SQL vs NoSQL, consistency vs availability, etc.).
- Mention specific technologies by name (Redis, Kafka, PostgreSQL, etc.).
- Address bottlenecks and how to mitigate them.`;
      break;

    case "situational":
      prompt += `

Situational Question Rules:
- Show structured thinking: acknowledge the situation → outline your approach → explain your decision.
- Demonstrate leadership qualities and emotional intelligence.
- Mention how you'd communicate with stakeholders.
- Give a concrete example if possible.`;
      break;

    case "general":
    default:
      prompt += `

General Question Rules:
- Be concise but substantial — don't give one-word answers.
- Show enthusiasm and genuine interest in the role/company.
- Connect your experience to the specific opportunity.
- Keep introductions to 3-4 strong bullet points max.`;
      break;
  }

  return prompt;
}

const SCREEN_ANALYSIS_PROMPT =
  `You are an elite interview copilot analyzing a screenshot. Respond as the candidate — sharp and direct.

Rules:
- **Coding problem** → Provide complete solution code with key line comments, state time/space complexity.
- **MCQ** → State the correct answer in **bold**, then give a clear 1-2 line justification.
- **Bug/error** → Identify the **root cause** in bold, then provide the corrected code.
- **Design diagram** → Identify gaps, suggest improvements as bold-labeled bullets.
- **Text question** → Answer directly using bullet points with bold key terms.

Start with a direct opening line, then use bullets. No preamble. Markdown only.`;

// ─── Text Answer Streaming ──────────────────────────────────────────

export interface StreamCallbacks {
  onStart: () => void;
  onChunk: (chunk: string) => void;
  onComplete: (fullAnswer: string) => void;
  onError: (error: string) => void;
}

/**
 * Stream an AI answer for an interview question (from transcript).
 * Includes conversation memory and smart prompt routing.
 */
export async function streamAnswer(
  question: string,
  config: InterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string,
  sessionId?: string
): Promise<void> {
  try {
    callbacks.onStart();

    const questionType = classifyQuestion(question);
    const languageInstruction = language
      ? `\n\nIMPORTANT: Respond in ${language}.`
      : "";

    // Build messages with conversation history
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: buildSystemPrompt(config, questionType) + languageInstruction,
      },
    ];

    // Inject conversation memory if available
    if (sessionId) {
      const history = conversationMemory.getHistory(sessionId);
      if (history.length > 0) {
        messages.push({
          role: "system",
          content: "Previous conversation context (use this to avoid repetition and build coherent answers):",
        });
        for (const entry of history) {
          messages.push({ role: entry.role, content: entry.content });
        }
      }
    }

    messages.push({
      role: "user",
      content: `The interviewer asked: "${question}"\n\nProvide a clear, confident, interview-ready answer.`,
    });

    const stream = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages,
      stream: true,
      max_tokens: 2000,
      temperature: 0.4,
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

    // Save to conversation memory
    if (sessionId) {
      conversationMemory.addExchange(sessionId, question, fullAnswer);
    }

    console.log(`\n[LLM] AI Response (streamAnswer | type=${questionType}):\n`, fullAnswer, "\n");
    callbacks.onComplete(fullAnswer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM streaming failed";
    console.error("[LLM] Stream error:", message);
    callbacks.onError(message);
  }
}

/**
 * Stream an AI answer for a manually typed question.
 * Includes conversation memory and smart prompt routing.
 */
export async function streamManualAnswer(
  question: string,
  config: InterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string,
  sessionId?: string
): Promise<void> {
  try {
    callbacks.onStart();

    const questionType = classifyQuestion(question);
    const languageInstruction = language
      ? `\n\nIMPORTANT: Respond in ${language}.`
      : "";

    // Build messages with conversation history
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: buildSystemPrompt(config, questionType) + languageInstruction,
      },
    ];

    // Inject conversation memory if available
    if (sessionId) {
      const history = conversationMemory.getHistory(sessionId);
      if (history.length > 0) {
        messages.push({
          role: "system",
          content: "Previous conversation context (use this to avoid repetition and build coherent answers):",
        });
        for (const entry of history) {
          messages.push({ role: entry.role, content: entry.content });
        }
      }
    }

    messages.push({
      role: "user",
      content: question,
    });

    const stream = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages,
      stream: true,
      max_tokens: 2000,
      temperature: 0.4,
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

    // Save to conversation memory
    if (sessionId) {
      conversationMemory.addExchange(sessionId, question, fullAnswer);
    }

    console.log(`\n[LLM] AI Response (streamManualAnswer | type=${questionType}):\n`, fullAnswer, "\n");
    callbacks.onComplete(fullAnswer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM streaming failed";
    console.error("[LLM] Manual answer stream error:", message);
    callbacks.onError(message);
  }
}

/**
 * Stream an AI analysis of a screenshot using the vision model.
 * Receives a raw image buffer and sends it to the vision API.
 */
export async function streamScreenAnalysis(
  imageBuffer: Buffer,
  mimeType: string,
  config: InterviewConfig | undefined,
  callbacks: StreamCallbacks
): Promise<void> {
  try {
    callbacks.onStart();

    // Convert buffer to base64 data URI
    const base64Image = imageBuffer.toString("base64");
    const dataUri = `data:${mimeType || "image/jpeg"};base64,${base64Image}`;

    const stream = await openai.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      messages: [
        {
          role: "system",
          content: SCREEN_ANALYSIS_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this screenshot from my interview and help me answer the question or solve the problem shown.",
            },
            {
              type: "image_url",
              image_url: {
                url: dataUri,
                detail: "high",
              },
            },
          ],
        },
      ],
      stream: true,
      max_tokens: 3000,
      temperature: 0.4,
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

    console.log("\n[LLM] AI Response (streamScreenAnalysis):\n", fullAnswer, "\n");
    callbacks.onComplete(fullAnswer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vision analysis failed";
    console.error("[LLM] Screen analysis error:", message);
    callbacks.onError(message);
  }
}
