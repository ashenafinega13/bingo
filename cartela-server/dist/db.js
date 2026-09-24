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
exports.userExists = userExists;
exports.setPhoneNumber = setPhoneNumber;
exports.getPhoneNumber = getPhoneNumber;
exports.transfer = transfer;
exports.recordGame = recordGame;
exports.getHistory = getHistory;
exports.createWithdrawalRequest = createWithdrawalRequest;
exports.getPendingWithdrawals = getPendingWithdrawals;
exports.approveWithdrawal = approveWithdrawal;
exports.rejectWithdrawal = rejectWithdrawal;
exports.getAdminStats = getAdminStats;
exports.getAllUsers = getAllUsers;
exports.adminAdjustBalance = adminAdjustBalance;
exports.getReferralBonuses = getReferralBonuses;
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
}
catch {
    /* column already exists — nothing to do */
}
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
const SIGNUP_BONUS_CENTS = 5000; // 50 Birr, credited once on a brand-new account
function ensureUser(telegramId, username, fullName) {
    const existing = db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(telegramId);
    if (!existing) {
        db.prepare("INSERT INTO users (telegram_id, username, full_name, balance_cents, created_at) VALUES (?, ?, ?, 0, ?)").run(telegramId, username || null, fullName, Date.now() / 1000);
        // Bonus is credited as its own transaction, after the user row exists,
        // so it goes through the exact same ledger-writing path as every other
        // balance change — never a special-cased direct balance write.
        credit(telegramId, SIGNUP_BONUS_CENTS, "SIGNUP_BONUS");
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
function userExists(telegramId) {
    const row = db.prepare("SELECT 1 FROM users WHERE telegram_id = ?").get(telegramId);
    return !!row;
}
function setPhoneNumber(telegramId, phoneNumber) {
    db.prepare("UPDATE users SET phone_number = ? WHERE telegram_id = ?").run(phoneNumber, telegramId);
}
function getPhoneNumber(telegramId) {
    const row = db.prepare("SELECT phone_number FROM users WHERE telegram_id = ?").get(telegramId);
    return row?.phone_number ?? null;
}
function transferTxn(senderId, recipientId, amountCents) {
    return withTransaction(() => {
        const senderBalance = getBalanceCents(senderId);
        if (senderBalance < amountCents) {
            throw new InsufficientBalanceError(`Insufficient balance: have ${senderBalance}, need ${amountCents}`);
        }
        db.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE telegram_id = ?").run(amountCents, senderId);
        const senderNew = getBalanceCents(senderId);
        db.prepare(`INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, 'TRANSFER_OUT', ?, ?, ?, ?)`).run((0, crypto_1.randomUUID)(), senderId, amountCents, senderNew, String(recipientId), Date.now() / 1000);
        db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE telegram_id = ?").run(amountCents, recipientId);
        const recipientNew = getBalanceCents(recipientId);
        db.prepare(`INSERT INTO ledger (id, telegram_id, type, amount_cents, balance_after, reference, created_at)
       VALUES (?, ?, 'TRANSFER_IN', ?, ?, ?, ?)`).run((0, crypto_1.randomUUID)(), recipientId, amountCents, recipientNew, String(senderId), Date.now() / 1000);
        return { senderNew, recipientNew };
    });
}
/** Atomic peer-to-peer transfer, identified by Telegram user ID. Both users
 * must already exist (i.e. have opened the bot/Mini App at least once). */
function transfer(senderId, recipientId, amountCents) {
    if (senderId === recipientId)
        throw new Error("Cannot transfer to yourself.");
    if (amountCents <= 0)
        throw new Error("Transfer amount must be positive.");
    if (!userExists(recipientId))
        throw new Error("That user hasn't started the bot yet.");
    return transferTxn(senderId, recipientId, amountCents);
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
// ------------------------------------------------------------------
// Withdrawal requests — the admin panel is where these get resolved.
// Requesting does NOT touch the balance; the deduction happens only
// when an admin approves it (and is re-validated against the CURRENT
// balance at that moment, since it may have changed since the request
// was filed).
// ------------------------------------------------------------------
function createWithdrawalRequest(telegramId, amountCents) {
    if (amountCents <= 0)
        throw new Error("Withdrawal amount must be positive.");
    const balance = getBalanceCents(telegramId);
    if (balance < amountCents) {
        throw new InsufficientBalanceError(`Insufficient balance: have ${balance}, need ${amountCents}`);
    }
    const id = (0, crypto_1.randomUUID)();
    db.prepare(`INSERT INTO withdrawal_requests (id, telegram_id, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'PENDING', ?)`).run(id, telegramId, amountCents, Date.now() / 1000);
    return id;
}
function getPendingWithdrawals() {
    return db
        .prepare(`SELECT wr.*, u.username, u.full_name FROM withdrawal_requests wr
       JOIN users u ON u.telegram_id = wr.telegram_id
       WHERE wr.status = 'PENDING'
       ORDER BY wr.created_at ASC`)
        .all();
}
function approveWithdrawal(requestId) {
    const req = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(requestId);
    if (!req)
        throw new Error("Withdrawal request not found.");
    if (req.status !== "PENDING")
        throw new Error(`Request already ${req.status.toLowerCase()}.`);
    // debit() runs its own transaction — do NOT wrap this call in another
    // withTransaction(), node:sqlite has no nested-transaction/savepoint
    // support the way better-sqlite3 did, and a nested BEGIN throws.
    const newBalance = debit(req.telegram_id, req.amount_cents, "WITHDRAW", requestId);
    db.prepare("UPDATE withdrawal_requests SET status = 'APPROVED', resolved_at = ? WHERE id = ?").run(Date.now() / 1000, requestId);
    return newBalance;
}
function rejectWithdrawal(requestId) {
    const req = db.prepare("SELECT status FROM withdrawal_requests WHERE id = ?").get(requestId);
    if (!req)
        throw new Error("Withdrawal request not found.");
    if (req.status !== "PENDING")
        throw new Error(`Request already ${req.status.toLowerCase()}.`);
    db.prepare("UPDATE withdrawal_requests SET status = 'REJECTED', resolved_at = ? WHERE id = ?").run(Date.now() / 1000, requestId);
}
// ------------------------------------------------------------------
// Admin dashboard queries
// ------------------------------------------------------------------
function getAdminStats() {
    const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
    const dayAgo = Date.now() / 1000 - 86400;
    const newToday = db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= ?").get(dayAgo).c;
    const totalBalance = db.prepare("SELECT COALESCE(SUM(balance_cents), 0) as s FROM users").get().s;
    const totalGames = db.prepare("SELECT COUNT(*) as c FROM game_history WHERE status = 'COMPLETED'").get().c;
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) as c FROM withdrawal_requests WHERE status = 'PENDING'").get().c;
    return { totalUsers, newToday, totalBalanceCents: totalBalance, totalGames, pendingWithdrawals };
}
function getAllUsers(limit = 50, offset = 0, search = "") {
    if (search) {
        const like = `%${search}%`;
        return db
            .prepare(`SELECT telegram_id, username, full_name, phone_number, balance_cents, created_at FROM users
         WHERE CAST(telegram_id AS TEXT) LIKE ? OR username LIKE ? OR full_name LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`)
            .all(like, like, like, limit, offset);
    }
    return db
        .prepare(`SELECT telegram_id, username, full_name, phone_number, balance_cents, created_at FROM users
       ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(limit, offset);
}
/** Manual balance adjustment by an admin. Positive amountCents credits,
 * negative debits (validated against current balance, same as any debit). */
function adminAdjustBalance(telegramId, amountCents, reason) {
    if (amountCents === 0)
        throw new Error("Adjustment amount cannot be zero.");
    if (amountCents > 0) {
        return credit(telegramId, amountCents, "ADMIN_CREDIT", reason);
    }
    return debit(telegramId, Math.abs(amountCents), "ADMIN_DEBIT", reason);
}
function getReferralBonuses(limit = 50) {
    return db
        .prepare(`SELECT l.*, u.username, u.full_name FROM ledger l
       JOIN users u ON u.telegram_id = l.telegram_id
       WHERE l.type = 'REFERRAL_BONUS'
       ORDER BY l.created_at DESC LIMIT ?`)
        .all(limit);
}
exports.default = db;
