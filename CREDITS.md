# Credit System — Design & Operations

**Core rule: 1 credit = 1 minute of live interview time.**

Credits are the unit of consumption for the PathMaker4u desktop copilot. A session
cannot start without credits, burns them while it runs, and is force-ended when
the balance reaches zero.

---

## 1. Data model

### `credit_accounts` — one row per user, the current truth

| column               | type        | notes                                        |
| -------------------- | ----------- | -------------------------------------------- |
| `user_id`            | UUID PK     | FK → `auth.users`                            |
| `balance`            | INT         | never negative (DB CHECK constraint)         |
| `lifetime_purchased` | INT         | cumulative, for reporting                    |
| `lifetime_used`      | INT         | cumulative, for reporting                    |
| `free_granted`       | BOOL        | ensures the signup bonus is granted **once** |
| `created_at`         | TIMESTAMPTZ |                                              |
| `updated_at`         | TIMESTAMPTZ |                                              |

### `credit_transactions` — append-only ledger, the audit trail

| column          | type        | notes                                              |
| --------------- | ----------- | -------------------------------------------------- |
| `id`            | UUID PK     |                                                     |
| `user_id`       | UUID        | FK → `auth.users`                                   |
| `delta`         | INT         | `+` credit, `−` debit. Never 0.                     |
| `balance_after` | INT         | balance snapshot after applying — makes history readable without replaying |
| `type`          | TEXT        | `grant` \| `purchase` \| `debit` \| `refund` \| `adjustment` |
| `interview_id`  | UUID NULL   | set for `debit`/`refund` so usage ties to a session |
| `note`          | TEXT        | human-readable reason                               |
| `created_at`    | TIMESTAMPTZ |                                                     |

**Why both tables:** the account row gives O(1) balance reads on every session
start; the ledger explains *how* the balance got there. The balance is always
derivable from the ledger, so the ledger is the source of truth if they ever
disagree.

### `interviews.metered_minutes`

Tracks how many minutes of a given session have **already been charged**. This
is what makes metering crash-safe and non-double-charging — see §4.

---

## 2. Atomicity

All balance mutations go through two Postgres functions, never through
read-modify-write in Node. Concurrent sessions on one account (e.g. desktop app
open twice) would otherwise race and let a user overspend.

- **`grant_credits(user_id, amount, type, note)`** — adds credits, writes ledger row.
- **`debit_credits(user_id, amount, interview_id, note)`** — atomically checks and
  subtracts. Returns `success=false` when the balance is insufficient rather than
  raising, so callers can degrade gracefully. Clamps at zero; the CHECK constraint
  is the final backstop.

Both use `UPDATE ... RETURNING` on a single row, so Postgres row-level locking
serialises concurrent callers for free.

---

## 3. Earning credits

| Source        | Amount            | Trigger                                   |
| ------------- | ----------------- | ----------------------------------------- |
| Signup bonus  | **10**            | First `/credits/balance` call, once ever, guarded by `free_granted` |
| Purchase      | pack size + bonus | Payment gateway webhook (see §7)          |
| Refund        | variable          | Manual `adjustment` for support cases     |

Account rows are created lazily on first access, so no signup hook or trigger is
required — any authenticated call to the credits API self-heals a missing account.

---

## 4. Spending credits (metering)

Metering is **server-authoritative**. The desktop client is never trusted to
report its own usage.

1. **Pre-flight** — `POST /interviews/start` rejects with `402 Payment Required`
   if `balance < 1`. No session row is created.
2. **Live metering** — when the client joins the socket room, the server starts a
   60-second interval for that session. Each tick:
   - debits exactly 1 credit and increments `interviews.metered_minutes`
   - emits `credits_update { balance, minutesUsed }` to the room
   - emits `credits_warning` at 5, 2 and 1 credits remaining
   - on failure to debit (balance exhausted) emits `session_terminated` and
     force-ends the session
3. **Reconciliation on end** — `PUT /interviews/:id/end` computes
   `ceil(elapsed_minutes)` and charges only the **difference** against
   `metered_minutes`. This covers the partial final minute and any ticks missed
   to a server restart, and because it charges the delta it can never
   double-charge a minute already metered.
4. **Timer cleanup** — timers are cleared on socket disconnect and on session end,
   so a dropped client stops burning credits.

### Why per-minute rather than reserve-upfront

Reserving the full balance at session start would block a user's other sessions
and require refund logic on every exit path (crash, network drop, force quit).
Per-minute metering means the worst case for the user is being over-charged by
**one partial minute**, and the worst case for the business is one un-metered
minute on a hard crash.

---

## 5. API surface

| Method | Route                    | Purpose                                        |
| ------ | ------------------------ | ---------------------------------------------- |
| GET    | `/api/credits/balance`   | Balance + lifetime stats. Lazily creates account and grants signup bonus. |
| GET    | `/api/credits/packs`     | Purchasable packs (static catalogue)           |
| GET    | `/api/credits/transactions` | Paginated ledger for the billing page       |
| POST   | `/api/credits/purchase`  | **Stub** — grants credits directly. Replace with gateway checkout (§7). |

All routes require `authMiddleware`. Users can only ever read/mutate their own
account — `user_id` comes from the verified JWT, never from the request body.

---

## 6. Failure modes & guarantees

| Scenario                        | Behaviour                                                 |
| ------------------------------- | --------------------------------------------------------- |
| Two sessions started at once    | Both debit against the same row; Postgres serialises. Balance cannot go negative. |
| Server restarts mid-session     | Timers are lost, but end-reconciliation charges the unmetered remainder. |
| Client crashes / never ends     | Session stays `active` and stops being metered on disconnect. Un-ended sessions charge only what was metered. |
| Balance hits 0 mid-session      | Session force-ended within 60s of the zero crossing.       |
| Debit fails (DB down)           | Metering tick logs and skips; reconciliation catches up at end. |
| Negative balance attempted      | `debit_credits` returns `success=false`; CHECK constraint is the backstop. |

**Known gap (accepted for v1):** metering ticks every 60s, so a session ending
between ticks is charged for the partial minute on reconciliation (rounded up).
This is deliberate — sub-minute billing granularity isn't worth the complexity.

---

## 7. Adding a real payment gateway

The ledger is deliberately gateway-agnostic. To go live:

1. Add a `payments` table: `id`, `user_id`, `gateway`, `gateway_order_id`,
   `gateway_payment_id`, `pack_id`, `amount_cents`, `currency`, `status`.
2. Replace `POST /credits/purchase` with **create-order** — returns the gateway
   order/session ID to the client. **Grants nothing.**
3. Add `POST /credits/webhook` — verifies the gateway signature, marks the payment
   `paid`, then calls `grant_credits`. This is the *only* path that grants
   purchased credits.
4. Make the webhook idempotent by unique-indexing `gateway_payment_id`; gateways
   retry, and a replayed webhook must not grant twice.
5. Never grant credits from a client-side success callback — it's trivially
   forgeable. The webhook is the authority.

---

## 8. Operational notes

- **Reconciling a disputed balance:** `SELECT SUM(delta) FROM credit_transactions
  WHERE user_id = ?` must equal `credit_accounts.balance`. If it doesn't, the
  ledger wins.
- **Granting goodwill credits:** call `grant_credits` with type `adjustment` and a
  note explaining why. Never `UPDATE credit_accounts` by hand — it breaks the audit trail.
- **Changing the rate:** the 1-credit-per-minute rate is expressed as
  `CREDITS_PER_MINUTE` in `services/credits.ts`. Changing it does not require a
  migration, but does change the meaning of historical ledger rows — record the
  change date if you ever do it.
