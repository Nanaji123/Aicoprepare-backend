import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import {
  CREDIT_PACKS,
  getBalance,
  getPack,
  grantCredits,
  listActivity,
  listTransactions,
} from "../services/credits.js";

const router = Router();

/**
 * GET /api/credits/balance
 *
 * Current balance + lifetime stats. Lazily creates the credit account and
 * grants the one-time signup bonus, so it's safe to call on every page load.
 */
router.get("/balance", authMiddleware, async (req: Request, res: Response) => {
  try {
    const balance = await getBalance(req.user!.id);
    res.json(balance);
  } catch (err) {
    console.error("[Credits] Failed to get balance:", err);
    res.status(500).json({ message: "Failed to get credit balance" });
  }
});

/**
 * GET /api/credits/packs
 *
 * Static catalogue of purchasable credit packs.
 */
router.get("/packs", authMiddleware, (_req: Request, res: Response) => {
  res.json(CREDIT_PACKS);
});

/**
 * GET /api/credits/transactions
 *
 * The user's credit ledger, newest first.
 */
router.get("/transactions", authMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    const transactions = await listTransactions(req.user!.id, limit);
    res.json(transactions);
  } catch (err) {
    console.error("[Credits] Failed to list transactions:", err);
    res.status(500).json({ message: "Failed to list transactions" });
  }
});

/**
 * GET /api/credits/activity
 *
 * Billing history for the UI: per-minute interview debits are rolled up into
 * one row per session showing total time. Use /transactions for the raw ledger.
 */
router.get("/activity", authMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
    const activity = await listActivity(req.user!.id, limit, offset);
    res.json(activity);
  } catch (err) {
    console.error("[Credits] Failed to list activity:", err);
    res.status(500).json({ message: "Failed to list activity" });
  }
});

/**
 * POST /api/credits/purchase   { packId }
 *
 * ⚠️  STUB — grants credits immediately without taking payment.
 *
 * This exists so the ledger, metering and billing UI can be built and tested
 * before a payment gateway is chosen. Before going live this MUST be replaced
 * with a create-order endpoint that grants nothing, plus a signature-verified
 * webhook that performs the grant. See CREDITS.md §7.
 */
router.post("/purchase", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { packId } = req.body ?? {};
    const pack = getPack(String(packId));

    if (!pack) {
      res.status(400).json({ message: "Unknown credit pack" });
      return;
    }

    const total = pack.credits + pack.bonus;
    const balance = await grantCredits(
      req.user!.id,
      total,
      "purchase",
      `${pack.name} pack (stub purchase — no payment taken)`
    );

    console.warn(
      `[Credits] STUB purchase: granted ${total} credits to ${req.user!.id} without payment`
    );

    res.json({ balance, granted: total, pack: pack.id });
  } catch (err) {
    console.error("[Credits] Failed to process purchase:", err);
    res.status(500).json({ message: "Failed to process purchase" });
  }
});

export default router;
