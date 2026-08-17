import type { Namespace, Socket } from "socket.io";
import {
  streamAnswer,
  streamManualAnswer,
  streamScreenAnalysis,
  conversationMemory,
  needsResponse,
} from "../services/llm.js";
import { getSession, saveAIAnswer } from "../services/interview.js";
import { startMetering, stopMetering } from "../services/metering.js";
import { getBalance } from "../services/credits.js";
import type {
  JoinSessionPayload,
  TranscriptFinalPayload,
  ManualQuestionPayload,
  ScreenCapturePayload,
  SetAnswerModePayload,
  RequestAnswerPayload,
  InterviewConfig,
} from "../types/index.js";

/**
 * Socket.IO /copilot namespace handler.
 *
 * This is the real-time brain of the app. It handles:
 * - Session room management (join/leave)
 * - Receiving finalized transcripts and generating AI answers
 * - Receiving manual questions and generating AI answers
 * - Receiving screenshots and generating visual analysis
 * - Answer mode switching (auto vs normal with intent classification)
 *
 * All AI answers are streamed chunk-by-chunk to the client.
 */

// In-memory session config cache (sessionId → config)
const sessionConfigs = new Map<string, InterviewConfig>();
// Answer mode per session: "auto" = always answer, "normal" = use intent classifier
const answerModes = new Map<string, "auto" | "normal">();

export function registerCopilotHandlers(namespace: Namespace): void {
  namespace.on("connection", (socket: Socket) => {
    console.log(`[Copilot] Client connected: ${socket.id}`);

    let currentSessionId: string | null = null;
    let currentUserId: string | null = null;

    // ─── Join Session ──────────────────────────────────────────────
    socket.on("join_session", async (payload: JoinSessionPayload) => {
      const { sessionId, userId } = payload;

      if (!sessionId || !userId) {
        socket.emit("connection_status", {
          status: "error",
          message: "Missing sessionId or userId",
        });
        return;
      }

      // Join the Socket.IO room for this session
      socket.join(sessionId);
      currentSessionId = sessionId;
      currentUserId = userId;

      // Try to fetch and cache session config
      try {
        const session = await getSession(sessionId);
        if (session?.config) {
          sessionConfigs.set(sessionId, session.config);
        }
      } catch (err) {
        console.warn("[Copilot] Could not fetch session config:", err);
      }

      console.log(
        `[Copilot] User ${userId} joined session ${sessionId}`
      );

      // Refuse to run a session with no credits, then start metering it.
      let balance = 0;
      try {
        balance = (await getBalance(userId)).balance;
      } catch (err) {
        console.error("[Copilot] Could not read credit balance:", err);
      }

      if (balance < 1) {
        socket.emit("session_terminated", {
          sessionId,
          reason: "INSUFFICIENT_CREDITS",
          message: "You have no credits remaining. Top up to start a session.",
          balance,
        });
        return;
      }

      startMetering(sessionId, userId, (event, data) =>
        namespace.to(sessionId).emit(event, data)
      );

      socket.emit("connection_status", {
        status: "connected",
        sessionId,
        userId,
        balance,
      });
    });

    // ─── Set Answer Mode ────────────────────────────────────────────
    // Fired when the user toggles between "auto" and "normal" mode.
    socket.on("set_answer_mode", (payload: SetAnswerModePayload) => {
      const { sessionId, mode } = payload;
      answerModes.set(sessionId, mode);
      console.log(`[Copilot] Answer mode set to "${mode}" for session ${sessionId}`);
    });

    // ─── Transcript Final ──────────────────────────────────────────
    // Fired when Deepgram detects an utterance end from the interviewer.
    // The desktop client buffers the transcript and sends it here.
    socket.on("transcript_final", async (payload: TranscriptFinalPayload) => {
      const { sessionId, text, language } = payload;

      if (!text || !text.trim()) return;

      console.log(
        `[Copilot] Transcript received for session ${sessionId}: "${text.substring(0, 80)}..."`
      );

      const config = sessionConfigs.get(sessionId);
      const mode = answerModes.get(sessionId) || "normal";

      // In normal mode, check if the utterance actually needs a response
      if (mode === "normal") {
        const shouldRespond = await needsResponse(text);
        if (!shouldRespond) {
          console.log(`[Copilot] Skipped (no response needed): "${text.substring(0, 60)}..."`);
          socket.emit("transcript_skipped", {
            sessionId,
            text,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      // Stream AI answer back to the client (with conversation memory).
      // `question` rides along on every event so the client can show what each
      // answer is responding to — it was previously only persisted to the DB.
      await streamAnswer(text, config, {
        onStart: () => {
          socket.emit("ai_answer_start", {
            sessionId,
            question: text,
            source: "transcript",
            timestamp: new Date().toISOString(),
          });
        },
        onChunk: (chunk: string) => {
          socket.emit("ai_answer_chunk", {
            sessionId,
            chunk,
            timestamp: new Date().toISOString(),
          });
        },
        onComplete: async (fullAnswer: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question: text,
            source: "transcript",
            answer: fullAnswer,
            timestamp: new Date().toISOString(),
          });

          // Save to database (non-blocking)
          saveAIAnswer(sessionId, text, fullAnswer, "transcript").catch(
            (err) => console.error("[Copilot] Failed to save answer:", err)
          );
        },
        onError: (error: string) => {
          console.error("[Copilot] AI answer error:", error);
          socket.emit("ai_answer", {
            sessionId,
            question: text,
            source: "transcript",
            answer: `⚠️ Sorry, I couldn't generate an answer. Error: ${error}`,
            timestamp: new Date().toISOString(),
          });
        },
      }, language, sessionId);
    });

    // ─── Request Answer (Manual override for skipped transcripts) ──
    // Fired when the user clicks "Answer" on a skipped transcript.
    socket.on("request_answer", async (payload: RequestAnswerPayload) => {
      const { sessionId, text, language } = payload;

      if (!text || !text.trim()) return;

      console.log(
        `[Copilot] Manual answer requested for session ${sessionId}: "${text.substring(0, 80)}..."`
      );

      const config = sessionConfigs.get(sessionId);

      await streamAnswer(text, config, {
        onStart: () => {
          socket.emit("ai_answer_start", {
            sessionId,
            question: text,
            source: "transcript",
            timestamp: new Date().toISOString(),
          });
        },
        onChunk: (chunk: string) => {
          socket.emit("ai_answer_chunk", {
            sessionId,
            chunk,
            timestamp: new Date().toISOString(),
          });
        },
        onComplete: async (fullAnswer: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question: text,
            source: "transcript",
            answer: fullAnswer,
            timestamp: new Date().toISOString(),
          });

          saveAIAnswer(sessionId, text, fullAnswer, "manual").catch(
            (err) => console.error("[Copilot] Failed to save answer:", err)
          );
        },
        onError: (error: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question: text,
            source: "transcript",
            answer: `⚠️ Sorry, I couldn't generate an answer. Error: ${error}`,
            timestamp: new Date().toISOString(),
          });
        },
      }, language, sessionId);
    });

    // ─── Manual Question ───────────────────────────────────────────
    // Fired when the user types a question manually in the UI.
    socket.on("manual_question", async (payload: ManualQuestionPayload) => {
      const { sessionId, question, language } = payload;

      if (!question || !question.trim()) return;

      console.log(
        `[Copilot] Manual question for session ${sessionId}: "${question.substring(0, 80)}..."`
      );

      const config = sessionConfigs.get(sessionId);

      await streamManualAnswer(question, config, {
        onStart: () => {
          socket.emit("ai_answer_start", {
            sessionId,
            question,
            source: "manual",
            timestamp: new Date().toISOString(),
          });
        },
        onChunk: (chunk: string) => {
          socket.emit("ai_answer_chunk", {
            sessionId,
            chunk,
            timestamp: new Date().toISOString(),
          });
        },
        onComplete: async (fullAnswer: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question,
            source: "manual",
            answer: fullAnswer,
            timestamp: new Date().toISOString(),
          });

          saveAIAnswer(sessionId, question, fullAnswer, "manual").catch(
            (err) => console.error("[Copilot] Failed to save answer:", err)
          );
        },
        onError: (error: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question,
            source: "manual",
            answer: `⚠️ Sorry, I couldn't generate an answer. Error: ${error}`,
            timestamp: new Date().toISOString(),
          });
        },
      }, language, sessionId);
    });

    // ─── Screen Capture ────────────────────────────────────────────
    // Fired when the user presses Cmd+Shift+A to analyze their screen.
    socket.on("screen_capture", async (payload: ScreenCapturePayload) => {
      const { sessionId, mimeType, uint8Array } = payload;

      console.log(
        `[Copilot] Screen capture received for session ${sessionId} (${mimeType})`
      );

      const config = sessionConfigs.get(sessionId);

      // Convert the incoming data to a Buffer
      const imageBuffer = Buffer.from(uint8Array);

      // Screen analysis has no spoken question — the client labels it from
      // `source` rather than rendering this placeholder verbatim.
      const screenQuestion = "[Screenshot Analysis]";

      await streamScreenAnalysis(imageBuffer, mimeType, config, {
        onStart: () => {
          socket.emit("ai_answer_start", {
            sessionId,
            question: screenQuestion,
            source: "screen",
            timestamp: new Date().toISOString(),
          });
        },
        onChunk: (chunk: string) => {
          socket.emit("ai_answer_chunk", {
            sessionId,
            chunk,
            timestamp: new Date().toISOString(),
          });
        },
        onComplete: async (fullAnswer: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question: screenQuestion,
            source: "screen",
            answer: fullAnswer,
            timestamp: new Date().toISOString(),
          });

          saveAIAnswer(sessionId, screenQuestion, fullAnswer, "screen").catch(
            (err) =>
              console.error("[Copilot] Failed to save screen analysis:", err)
          );
        },
        onError: (error: string) => {
          socket.emit("ai_answer", {
            sessionId,
            question: screenQuestion,
            source: "screen",
            answer: `⚠️ Sorry, I couldn't analyze the screenshot. Error: ${error}`,
            timestamp: new Date().toISOString(),
          });
        },
      });
    });

    // ─── Leave Session ─────────────────────────────────────────────
    socket.on("leave_session", (payload: JoinSessionPayload) => {
      const { sessionId, userId } = payload;

      socket.leave(sessionId);
      sessionConfigs.delete(sessionId);
      answerModes.delete(sessionId);
      conversationMemory.clear(sessionId);
      // Stop billing the moment the user leaves.
      stopMetering(sessionId);

      console.log(
        `[Copilot] User ${userId} left session ${sessionId}`
      );
    });

    // ─── Disconnect ────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(
        `[Copilot] Client disconnected: ${socket.id} (${reason})`
      );

      // Clean up session config if this was the last connection
      if (currentSessionId) {
        sessionConfigs.delete(currentSessionId);
        answerModes.delete(currentSessionId);
        conversationMemory.clear(currentSessionId);
        // A dropped client must stop burning credits.
        stopMetering(currentSessionId);
      }
    });
  });
}
