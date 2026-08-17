import { Router } from "express";
import authRoutes from "./auth.js";
import interviewRoutes from "./interviews.js";
import creditRoutes from "./credits.js";
import devBridgeRoutes from "./devBridge.js";

const router = Router();

// Health check
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "pathmaker4u-backend",
  });
});

// Mount route groups
router.use("/auth", authRoutes);
router.use("/interviews", interviewRoutes);
router.use("/credits", creditRoutes);
router.use("/dev", devBridgeRoutes);

export default router;
