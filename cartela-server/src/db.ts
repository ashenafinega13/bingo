/**
 * db.ts
 *
 * SQLite persistence using Node's BUILT-IN `node:sqlite` module (available
 * since Node 22.5, no flag needed since Node 22.13/23.4+, and a Release
 * Candidate as of Node 24.15+) — no native addon to compile, so no
 * Visual Studio / build tools requirement on Windows.
 *
 * Same money-safety pattern as the Python bot's database.py: every
 * balance change happens inside a single transaction alongside its
 * ledger row, so a crash mid-write can never desync the two. node:sqlite
 * doesn't ship a `.transaction()` helper like better-sqlite3 did, so
 * transactions are wrapped manually with BEGIN/COMMIT/ROLLBACK below.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "crypto";

const db = new DatabaseSync(process.env.DB_PATH || "cartela.db");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id     INTEGER PRIMARY KEY,
  username        TEXT,
  full_name       TEXT,
  balance_cents   INTEGER NOT NULL DEFAULT 0,
  personal_card   TEXT,
  phone_number    TEXT,
  created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id              TEXT PRIMARY KEY,
  telegram_id     INTEGER NOT NULL,
  type            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  balance_after   INTEGER NOT NULL,
  reference       TEXT,
  created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS game_history (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL,
  tier_key        TEXT NOT NULL,
  entry_fee_cents INTEGER NOT NULL,
  player_count    INTEGER NOT NULL,
  pot_cents       INTEGER NOT NULL,
  rake_cents      INTEGER NOT NULL,
  payout_cents    INTEGER NOT NULL,
  winner_id       INTEGER,
  winning_pattern TEXT,
  drawn_numbers   TEXT NOT NULL,
  status          TEXT NOT NULL,
  completed_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS game_participants (
  id              TEXT PRIMARY KEY,
  game_id         TEXT NOT NULL,
  telegram_id     INTEGER NOT NULL,
  FOREIGN KEY (game_id) REFERENCES game_history(id)
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id              TEXT PRIMARY KEY,
  telegram_id     INTEGER NOT NULL,
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL,   -- PENDING, APPROVED, REJECTED
  created_at      REAL NOT NULL,
  resolved_at     REAL
);
`);

// Migration for databases created before phone_number existed — the
// CREATE TABLE above only applies to brand-new databases, so an existing
// one (like your already-running Render deployment) needs this column
// added explicitly. Safe to run on every startup: SQLite throws if the
// column already exists, which we simply ignore.
try {
  db.exec("ALTER TABLE users ADD COLUMN phone_number TEXT;");
} catch {
  /* column already exists — nothing to do */
}

export class InsufficientBalanceError extends Error {}

/** Runs `fn` inside a manual BEGIN/COMMIT, rolling back on any thrown error. */
function withTransaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const SIGNUP_BONUS_CENTS = 5000; // 50 Birr, credited once on a brand-new account

export function ensureUser(telegramId: number, username: string | undefined, fullName: string): void {
  const existing = db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(telegramId);
  if (!existing) {
    db.prepare(
      "INSERT INTO users (telegram_id, username, full_name, balance_cents, created_at) VALUES (?, ?, ?, 0, ?)"
    ).run(telegramId, username || null, fullName, Date.now() / 1000);
    // Bonus is credited as its own transaction, after the user row exists,
    // so it goes through the exact same ledger-writing path as every other
    // balance change — never a special-cased direct balance write.
    credit(telegramId, SIGNUP_BONUS_CENTS, "SIGNUP_BONUS");
  }
}

export function getBalanceCents(telegramId: number): number {
  const row = db.prepare("SELECT balance_cents FROM users WHERE telegram_id = ?").get(telegramId) as
    | { balance_cents: number }
    | undefined;
  if (!row) throw new Error("User not found");
  return row.balance_cents;
}

export function credit(telegramId: number, amountCents: number, type: string, reference?: string): number {
  if (amountCents <= 0) throw new Error("Credit amount must be positive");
  return withTransaction(() => {
    db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE telegram_id = ?").run(amountCents, telegramId);
    const newBalance = getBalanceCents(telegramId);
    db.prepare(
      `INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), telegramId, type, amountCents, newBalance, reference || null, Date.now() / 1000);
    return newBalance;
  });
}

export function debit(telegramId: number, amountCents: number, type: string, reference?: string): number {
  if (amountCents <= 0) throw new Error("Debit amount must be positive");
  return withTransaction(() => {
    const balance = getBalanceCents(telegramId);
    if (balance < amountCents) {
      throw new InsufficientBalanceError(`Insufficient balance: have ${balance}, need ${amountCents}`);
    }
    db.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE telegram_id = ?").run(amountCents, telegramId);
    const newBalance = getBalanceCents(telegramId);
    db.prepare(
      `INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), telegramId, type, amountCents, newBalance, reference || null, Date.now() / 1000);
    return newBalance;
  });
}

export function userExists(telegramId: number): boolean {
  const row = db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(telegramId);
  return !!row;
}

export function setPhoneNumber(telegramId: number, phoneNumber: string): void {
  db.prepare("UPDATE users SET phone_number = ? WHERE telegram_id = ?").run(phoneNumber, telegramId);
}

export function getPhoneNumber(telegramId: number): string | null {
  const row = db.prepare("SELECT phone_number FROM users WHERE telegram_id = ?").get(telegramId) as
    | { phone_number: string | null }
    | undefined;
  return row?.phone_number ?? null;
}

function transferTxn(senderId: number, recipientId: number, amountCents: number) {
  return withTransaction(() => {
    const senderBalance = getBalanceCents(senderId);
    if (senderBalance < amountCents) {
      throw new InsufficientBalanceError(`Insufficient balance: have ${senderBalance}, need ${amountCents}`);
    }
    db.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE telegram_id = ?").run(amountCents, senderId);
    const senderNew = getBalanceCents(senderId);
    db.prepare(
      `INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, 'TRANSFER_OUT', ?, ?, ?, ?)`
    ).run(randomUUID(), senderId, amountCents, senderNew, String(recipientId), Date.now() / 1000);

    db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE telegram_id = ?").run(amountCents, recipientId);
    const recipientNew = getBalanceCents(recipientId);
    db.prepare(
      `INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, 'TRANSFER_IN', ?, ?, ?, ?)`
    ).run(randomUUID(), recipientId, amountCents, recipientNew, String(senderId), Date.now() / 1000);

    return { senderNew, recipientNew };
  });
}

/** Atomic peer-to-peer transfer, identified by Telegram user ID. Both users
 * must already exist (i.e. have opened the bot/Mini App at least once). */
export function transfer(senderId: number, recipientId: number, amountCents: number): { senderNew: number; recipientNew: number } {
  if (senderId === recipientId) throw new Error("Cannot transfer to yourself.");
  if (amountCents <= 0) throw new Error("Transfer amount must be positive.");
  if (!userExists(recipientId)) throw new Error("That user hasn't started the bot yet.");
  return transferTxn(senderId, recipientId, amountCents);
}

interface GameRecordInput {
  roomId: string;
  tierKey: string;
  entryFeeCents: number;
  playerIds: number[];
  potCents: number;
  rakeCents: number;
  payoutCents: number;
  winnerId?: number;
  winningPattern?: string;
  drawnNumbers: number[];
  status: "COMPLETED" | "CANCELLED";
}

export function recordGame(g: GameRecordInput): void {
  withTransaction(() => {
    const gameId = randomUUID();
    db.prepare(
      `INSERT INTO game_history
       (id, room_id, tier_key, entry_fee_cents, player_count, pot_cents, rake_cents,
        payout_cents, winner_id, winning_pattern, drawn_numbers, status, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      gameId, g.roomId, g.tierKey, g.entryFeeCents, g.playerIds.length, g.potCents, g.rakeCents,
      g.payoutCents, g.winnerId || null, g.winningPattern || null, JSON.stringify(g.drawnNumbers),
      g.status, Date.now() / 1000
    );
    for (const playerId of g.playerIds) {
      db.prepare("INSERT INTO game_participants (id, game_id, telegram_id) VALUES (?, ?, ?)").run(
        randomUUID(), gameId, playerId
      );
    }
  });
}

export function getHistory(telegramId: number, limit = 10) {
  return db
    .prepare(
      `SELECT gh.* FROM game_history gh
       JOIN game_participants gp ON gp.game_id = gh.id
       WHERE gp.telegram_id = ?
       ORDER BY gh.completed_at DESC LIMIT ?`
    )
    .all(telegramId, limit);
}

// ------------------------------------------------------------------
// Withdrawal requests — the admin panel is where these get resolved.
// Requesting does NOT touch the balance; the deduction happens only
// when an admin approves it (and is re-validated against the CURRENT
// balance at that moment, since it may have changed since the request
// was filed).
// ------------------------------------------------------------------
export function createWithdrawalRequest(telegramId: number, amountCents: number): string {
  if (amountCents <= 0) throw new Error("Withdrawal amount must be positive.");
  const balance = getBalanceCents(telegramId);
  if (balance < amountCents) {
    throw new InsufficientBalanceError(`Insufficient balance: have ${balance}, need ${amountCents}`);
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO withdrawal_requests (id, telegram_id, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'PENDING', ?)`
  ).run(id, telegramId, amountCents, Date.now() / 1000);
  return id;
}

export function getPendingWithdrawals() {
  return db
    .prepare(
      `SELECT wr.*, u.username, u.full_name FROM withdrawal_requests wr
       JOIN users u ON u.telegram_id = wr.telegram_id
       WHERE wr.status = 'PENDING'
       ORDER BY wr.created_at ASC`
    )
    .all();
}

export function approveWithdrawal(requestId: string): number {
  const req = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(requestId) as
    | { id: string; telegram_id: number; amount_cents: number; status: string }
    | undefined;
  if (!req) throw new Error("Withdrawal request not found.");
  if (req.status !== "PENDING") throw new Error(`Request already ${req.status.toLowerCase()}.`);

  // debit() runs its own transaction — do NOT wrap this call in another
  // withTransaction(), node:sqlite has no nested-transaction/savepoint
  // support the way better-sqlite3 did, and a nested BEGIN throws.
  const newBalance = debit(req.telegram_id, req.amount_cents, "WITHDRAW", requestId);

  db.prepare("UPDATE withdrawal_requests SET status = 'APPROVED', resolved_at = ? WHERE id = ?").run(
    Date.now() / 1000, requestId
  );
  return newBalance;
}

export function rejectWithdrawal(requestId: string): void {
  const req = db.prepare("SELECT status FROM withdrawal_requests WHERE id = ?").get(requestId) as
    | { status: string }
    | undefined;
  if (!req) throw new Error("Withdrawal request not found.");
  if (req.status !== "PENDING") throw new Error(`Request already ${req.status.toLowerCase()}.`);
  db.prepare("UPDATE withdrawal_requests SET status = 'REJECTED', resolved_at = ? WHERE id = ?").run(
    Date.now() / 1000, requestId
  );
}

// ------------------------------------------------------------------
// Admin dashboard queries
// ------------------------------------------------------------------
export function getAdminStats() {
  const totalUsers = (db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  const dayAgo = Date.now() / 1000 - 86400;
  const newToday = (db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= ?").get(dayAgo) as { c: number }).c;
  const totalBalance = (db.prepare("SELECT COALESCE(SUM(balance_cents), 0) as s FROM users").get() as { s: number }).s;
  const totalGames = (db.prepare("SELECT COUNT(*) as c FROM game_history WHERE status = 'COMPLETED'").get() as { c: number }).c;
  const pendingWithdrawals = (db.prepare("SELECT COUNT(*) as c FROM withdrawal_requests WHERE status = 'PENDING'").get() as { c: number }).c;
  return { totalUsers, newToday, totalBalanceCents: totalBalance, totalGames, pendingWithdrawals };
}

export function getAllUsers(limit = 50, offset = 0, search = "") {
  if (search) {
    const like = `%${search}%`;
    return db
      .prepare(
        `SELECT telegram_id, username, full_name, phone_number, balance_cents, created_at FROM users
         WHERE CAST(telegram_id AS TEXT) LIKE ? OR username LIKE ? OR full_name LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(like, like, like, limit, offset);
  }
  return db
    .prepare(
      `SELECT telegram_id, username, full_name, phone_number, balance_cents, created_at FROM users
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

/** Manual balance adjustment by an admin. Positive amountCents credits,
 * negative debits (validated against current balance, same as any debit). */
export function adminAdjustBalance(telegramId: number, amountCents: number, reason: string): number {
  if (amountCents === 0) throw new Error("Adjustment amount cannot be zero.");
  if (amountCents > 0) {
    return credit(telegramId, amountCents, "ADMIN_CREDIT", reason);
  }
  return debit(telegramId, Math.abs(amountCents), "ADMIN_DEBIT", reason);
}

export function getReferralBonuses(limit = 50) {
  return db
    .prepare(
      `SELECT l.*, u.username, u.full_name FROM ledger l
       JOIN users u ON u.telegram_id = l.telegram_id
       WHERE l.type = 'REFERRAL_BONUS'
       ORDER BY l.created_at DESC LIMIT ?`
    )
    .all(limit);
}

export default db;
