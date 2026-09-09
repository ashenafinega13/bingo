"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InsufficientBalanceError = void 0;
exports.ensureUser = ensureUser;
exports.getBalanceCents = getBalanceCents;
exports.credit = credit;
exports.debit = debit;
exports.recordGame = recordGame;
exports.getHistory = getHistory;
const node_sqlite_1 = require("node:sqlite");
const crypto_1 = require("crypto");
const db = new node_sqlite_1.DatabaseSync(process.env.DB_PATH || "cartela.db");
db.exec("PRAGMA journal_mode = WAL;");
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
class InsufficientBalanceError extends Error {
}
exports.InsufficientBalanceError = InsufficientBalanceError;
/** Runs `fn` inside a manual BEGIN/COMMIT, rolling back on any thrown error. */
function withTransaction(fn) {
    db.exec("BEGIN");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    }
    catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}
function ensureUser(telegramId, username, fullName) {
    const existing = db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(telegramId);
    if (!existing) {
        db.prepare("INSERT INTO users (telegram_id, username, full_name, balance_cents, created_at) VALUES (?, ?, ?, 0, ?)").run(telegramId, username || null, fullName, Date.now() / 1000);
    }
}
function getBalanceCents(telegramId) {
    const row = db.prepare("SELECT balance_cents FROM users WHERE telegram_id = ?").get(telegramId);
    if (!row)
        throw new Error("User not found");
    return row.balance_cents;
}
function credit(telegramId, amountCents, type, reference) {
    if (amountCents <= 0)
        throw new Error("Credit amount must be positive");
    return withTransaction(() => {
        db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE telegram_id = ?").run(amountCents, telegramId);
        const newBalance = getBalanceCents(telegramId);
        db.prepare(`INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run((0, crypto_1.randomUUID)(), telegramId, type, amountCents, newBalance, reference || null, Date.now() / 1000);
        return newBalance;
    });
}
function debit(telegramId, amountCents, type, reference) {
    if (amountCents <= 0)
        throw new Error("Debit amount must be positive");
    return withTransaction(() => {
        const balance = getBalanceCents(telegramId);
        if (balance < amountCents) {
            throw new InsufficientBalanceError(`Insufficient balance: have ${balance}, need ${amountCents}`);
        }
        db.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE telegram_id = ?").run(amountCents, telegramId);
        const newBalance = getBalanceCents(telegramId);
        db.prepare(`INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run((0, crypto_1.randomUUID)(), telegramId, type, amountCents, newBalance, reference || null, Date.now() / 1000);
        return newBalance;
    });
}
function recordGame(g) {
    withTransaction(() => {
        const gameId = (0, crypto_1.randomUUID)();
        db.prepare(`INSERT INTO game_history
       (id, room_id, tier_key, entry_fee_cents, player_count, pot_cents, rake_cents,
        payout_cents, winner_id, winning_pattern, drawn_numbers, status, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(gameId, g.roomId, g.tierKey, g.entryFeeCents, g.playerIds.length, g.potCents, g.rakeCents, g.payoutCents, g.winnerId || null, g.winningPattern || null, JSON.stringify(g.drawnNumbers), g.status, Date.now() / 1000);
        for (const playerId of g.playerIds) {
            db.prepare("INSERT INTO game_participants (id, game_id, telegram_id) VALUES (?, ?, ?)").run((0, crypto_1.randomUUID)(), gameId, playerId);
        }
    });
}
function getHistory(telegramId, limit = 10) {
    return db
        .prepare(`SELECT gh.* FROM game_history gh
       JOIN game_participants gp ON gp.game_id = gh.id
       WHERE gp.telegram_id = ?
       ORDER BY gh.completed_at DESC LIMIT ?`)
        .all(telegramId, limit);
}
exports.default = db;
