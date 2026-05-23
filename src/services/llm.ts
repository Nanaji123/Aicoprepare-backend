import OpenAI from "openai";
import { env } from "../config/env.js";
import type { InterviewConfig } from "../types/index.js";

/**
 * LLM Service — handles AI answer generation via OpenAI.
 *
 * Uses GPT-4o-mini for text-based interview answers (fast + cheap)
 * and GPT-4o for screenshot/vision analysis (needs vision capability).
 */

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

// ─── System Prompts ────────────────────────────────────────────────

function buildSystemPrompt(config?: InterviewConfig): string {
  const ctx = config ? [
    config.role && `Role: ${config.role}`,
    config.company && `Company: ${config.company}`,
    config.experienceLevel && `Level: ${config.experienceLevel}`,
    config.jobDescription && `JD: ${config.jobDescription}`,
  ].filter(Boolean).join(" | ") : "General";

  return `You are an interview copilot. Answer as the candidate — sharp, direct, interview-ready.

Context: ${ctx}

Rules:
- Coding → working code + 1-line explanation per key step
- Behavioral → STAR in ≤4 bullet points  
- System design → components → trade-offs → scale, each as a short bullet
- Ambiguous question → pick most likely intent, answer it
- No preamble. No "here's how to answer". Start with the answer.
- Markdown: use bullets and code blocks only. No prose paragraphs.`;
}

const SCREEN_ANALYSIS_PROMPT =
  `Interview copilot. Analyze the screenshot and respond as the candidate.

- Coding problem → solution code + key line comments
- MCQ → answer + 1-line reason
- Bug/error → root cause + fix
- Design diagram → gaps + suggestions as bullets
No preamble. Markdown only. Be sharp.`;

// ─── Text Answer Streaming ──────────────────────────────────────────

export interface StreamCallbacks {
  onStart: () => void;
  onChunk: (chunk: string) => void;
  onComplete: (fullAnswer: string) => void;
  onError: (error: string) => void;
}

/**
 * Stream an AI answer for an interview question (text-based).
 * Uses GPT-4o-mini for speed and cost efficiency.
 */
export async function streamAnswer(
  question: string,
  config: InterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string
): Promise<void> {
  try {
    callbacks.onStart();

    const languageInstruction = language
      ? `\n\nIMPORTANT: Respond in ${language}.`
      : "";

    const stream = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(config) + languageInstruction,
        },
        {
          role: "user",
          content: `The interviewer asked: "${question}"\n\nProvide a clear, concise answer.`,
        },
      ],
      stream: true,
      max_tokens: 2000,
      temperature: 0.7,
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
    const message = err instanceof Error ? err.message : "LLM streaming failed";
    console.error("[LLM] Stream error:", message);
    callbacks.onError(message);
  }
}

/**
 * Stream an AI answer for a manually typed question.
 * Same as streamAnswer but with a slightly different prompt framing.
 */
export async function streamManualAnswer(
  question: string,
  config: InterviewConfig | undefined,
  callbacks: StreamCallbacks,
  language?: string
): Promise<void> {
  try {
    callbacks.onStart();

    const languageInstruction = language
      ? `\n\nIMPORTANT: Respond in ${language}.`
      : "";

    const stream = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(config) + languageInstruction,
        },
        {
          role: "user",
          content: question,
        },
      ],
      stream: true,
      max_tokens: 2000,
      temperature: 0.7,
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
    const message = err instanceof Error ? err.message : "LLM streaming failed";
    console.error("[LLM] Manual answer stream error:", message);
    callbacks.onError(message);
  }
}

/**
 * Stream an AI analysis of a screenshot using GPT-4o (vision model).
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
      temperature: 0.5,
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
    console.error("[LLM] Screen analysis error:", message);
    callbacks.onError(message);
  }
}
