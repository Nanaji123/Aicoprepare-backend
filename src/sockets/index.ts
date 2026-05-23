import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { registerCopilotHandlers } from "./copilot.js";
import { env } from "../config/env.js";

/**
 * Initialize Socket.IO and register all namespace handlers.
 */
export function initializeSocketIO(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS,
      methods: ["GET", "POST"],
      credentials: true,
    },
    // Allow large payloads for screenshot uploads
    maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB
    transports: ["websocket", "polling"],
  });

  // Register the /copilot namespace (used by the desktop app)
  const copilotNamespace = io.of("/copilot");
  registerCopilotHandlers(copilotNamespace);

  console.log("[Socket.IO] Initialized with /copilot namespace");

  return io;
}
