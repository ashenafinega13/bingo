/**
 * db.ts
 *
 * SQLite persistence via better-sqlite3 (synchronous — no async/await
 * needed, and simpler to reason about for a single-process server this
 * size). Swap for Postgres later by replacing this file only; nothing
 * above this layer needs to change since callers just use the exported
 * functions.
 *
 * Same money-safety pattern as the Python bot's database.py: every
 * balance change happens inside a single transaction alongside its
 * ledger row, so a crash mid-write can never desync the two.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";

const db = new Database(process.env.DB_PATH || "cartela.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id     INTEGER PRIMARY KEY,
  username        TEXT,
  full_name       TEXT,
  balance_cents   INTEGER NOT NULL DEFAULT 0,
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
`);

export class InsufficientBalanceError extends Error {}

export function ensureUser(telegramId: number, username: string | undefined, fullName: string): void {
  const existing = db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(telegramId);
  if (!existing) {
    db.prepare(
      "INSERT INTO users (telegram_id, username, full_name, balance_cents, created_at) VALUES (?, ?, ?, 0, ?)"
    ).run(telegramId, username || null, fullName, Date.now() / 1000);
  }
}

export function getBalanceCents(telegramId: number): number {
  const row = db.prepare("SELECT balance_cents FROM users WHERE telegram_id = ?").get(telegramId) as
    | { balance_cents: number }
    | undefined;
  if (!row) throw new Error("User not found");
  return row.balance_cents;
}

const creditTxn = db.transaction((telegramId: number, amountCents: number, type: string, reference?: string) => {
  db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE telegram_id = ?").run(amountCents, telegramId);
  const newBalance = getBalanceCents(telegramId);
  db.prepare(
    `INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), telegramId, type, amountCents, newBalance, reference || null, Date.now() / 1000);
  return newBalance;
});

export function credit(telegramId: number, amountCents: number, type: string, reference?: string): number {
  if (amountCents <= 0) throw new Error("Credit amount must be positive");
  return creditTxn(telegramId, amountCents, type, reference);
}

const debitTxn = db.transaction((telegramId: number, amountCents: number, type: string, reference?: string) => {
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

export function debit(telegramId: number, amountCents: number, type: string, reference?: string): number {
  if (amountCents <= 0) throw new Error("Debit amount must be positive");
  return debitTxn(telegramId, amountCents, type, reference);
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

const recordGameTxn = db.transaction((g: GameRecordInput) => {
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

export function recordGame(g: GameRecordInput): void {
  recordGameTxn(g);
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

export default db;
