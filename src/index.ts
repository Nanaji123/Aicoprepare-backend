import { createServer } from "http";
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import routes from "./routes/index.js";
import { initializeSocketIO } from "./sockets/index.js";

/**
 * CoPrep Backend Server
 *
 * Express REST API + Socket.IO real-time server.
 * Powers the CoPrep Desktop interview copilot app.
 */

const app = express();
const httpServer = createServer(app);

// ─── Middleware ─────────────────────────────────────────────────────

// CORS — allow the Electron app and dev server
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (Electron, Postman, curl)
      if (!origin) return callback(null, true);
      if (env.CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      // Explicitly allow production frontend
      if (origin === "https://aicoprepare.vercel.app") {
        return callback(null, true);
      }
      // In development, be more permissive
      if (env.NODE_ENV === "development") {
        return callback(null, true);
      }
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// Parse JSON bodies (up to 15 MB for screenshot uploads)
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Request logging in development
if (env.NODE_ENV === "development") {
  app.use((req, _res, next) => {
    console.log(`[${req.method}] ${req.path}`);
    next();
  });
}

// ─── Routes ────────────────────────────────────────────────────────

app.use("/api", routes);

// ─── Socket.IO ─────────────────────────────────────────────────────

const io = initializeSocketIO(httpServer);

// ─── Start Server ──────────────────────────────────────────────────

httpServer.listen(env.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   🚀 CoPrep Backend Server                           ║
║                                                      ║
║   REST API:    http://localhost:${env.PORT}/api         ║
║   Socket.IO:   ws://localhost:${env.PORT}/copilot       ║
║   Health:      http://localhost:${env.PORT}/api/health   ║
║   Environment: ${env.NODE_ENV.padEnd(12)}                     ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down gracefully...");
  io.close();
  httpServer.close(() => {
    console.log("[Server] Goodbye!");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  io.close();
  httpServer.close(() => process.exit(0));
});
