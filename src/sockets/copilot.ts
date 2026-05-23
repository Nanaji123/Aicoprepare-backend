import type { Namespace, Socket } from "socket.io";
import {
  streamAnswer,
  streamManualAnswer,
  streamScreenAnalysis,
} from "../services/llm.js";
import { getSession, saveAIAnswer } from "../services/interview.js";
import type {
  JoinSessionPayload,
  TranscriptFinalPayload,
  ManualQuestionPayload,
  ScreenCapturePayload,
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
 *
 * All AI answers are streamed chunk-by-chunk to the client.
 */

// In-memory session config cache (sessionId → config)
const sessionConfigs = new Map<string, InterviewConfig>();

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

      socket.emit("connection_status", {
        status: "connected",
        sessionId,
        userId,
      });
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

      // Stream AI answer back to the client
      await streamAnswer(text, config, {
        onStart: () => {
          socket.emit("ai_answer_start", {
            sessionId,
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
            answer: `⚠️ Sorry, I couldn't generate an answer. Error: ${error}`,
            timestamp: new Date().toISOString(),
          });
        },
      }, language);
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
            answer: `⚠️ Sorry, I couldn't generate an answer. Error: ${error}`,
            timestamp: new Date().toISOString(),
          });
        },
      }, language);
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

      await streamScreenAnalysis(imageBuffer, mimeType, config, {
        onStart: () => {
          socket.emit("ai_answer_start", {
            sessionId,
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
            answer: fullAnswer,
            timestamp: new Date().toISOString(),
          });

          saveAIAnswer(
            sessionId,
            "[Screenshot Analysis]",
            fullAnswer,
            "screen"
          ).catch((err) =>
            console.error("[Copilot] Failed to save screen analysis:", err)
          );
        },
        onError: (error: string) => {
          socket.emit("ai_answer", {
            sessionId,
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
      }
    });
  });
}
