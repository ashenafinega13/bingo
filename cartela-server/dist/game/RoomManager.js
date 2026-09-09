"use strict";
/**
 * RoomManager.ts
 *
 * In-memory room orchestration for a single Node process. This mirrors the
 * same phase machine as the earlier GameLoopManager.ts design (WAITING ->
 * COUNTDOWN -> IN_PROGRESS -> VALIDATING -> CLOSED), but state lives in a
 * plain Map instead of Redis. That's the deliberate scaling trade-off:
 * fine for one server instance; if you outgrow a single process, move
 * `rooms`/`activeRooms` into Redis and use the Socket.io Redis adapter so
 * multiple Node instances can share room state and broadcast consistently.
 *
 * All money movement goes through db.ts — this file never touches
 * balances except via credit()/debit().
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomManager = exports.TIERS = void 0;
const CardGenerator_1 = require("./CardGenerator");
const WinValidator_1 = require("./WinValidator");
const db = __importStar(require("../db"));
exports.TIERS = {
    t20: { label: "20 Birr", entryFeeCents: 2000 },
    t50: { label: "50 Birr", entryFeeCents: 5000 },
    t100: { label: "100 Birr", entryFeeCents: 10000 },
};
const RAKE_PERCENT = 10;
const MIN_PLAYERS_TO_START = 2;
const SELECTION_SECONDS = 59;
const DRAW_INTERVAL_MS = 1000; // spec calls for 1-number-per-second
function potFor(room) {
    const pot = room.entryFeeCents * room.players.size;
    const rake = Math.floor((pot * RAKE_PERCENT) / 100);
    return { pot, rake, payout: pot - rake };
}
class RoomManager {
    constructor(io) {
        this.openRooms = new Map(); // tierKey -> currently-joinable room
        this.activeRooms = new Map(); // roomId -> any non-closed room
        this.io = io;
    }
    getOrCreateOpenRoom(tierKey) {
        let room = this.openRooms.get(tierKey);
        if (!room || room.phase !== "WAITING") {
            room = {
                id: `room_${tierKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                tierKey,
                entryFeeCents: exports.TIERS[tierKey].entryFeeCents,
                phase: "WAITING",
                players: new Map(),
                drawnNumbers: [],
            };
            this.openRooms.set(tierKey, room);
            this.activeRooms.set(room.id, room);
        }
        return room;
    }
    /** Player opens the tier and gets a fresh card to preview/refresh. */
    joinTier(tierKey, telegramId, socket) {
        const room = this.getOrCreateOpenRoom(tierKey);
        const card = CardGenerator_1.CardGenerator.generate();
        room.players.set(telegramId, { telegramId, socketId: socket.id, card, lockedIn: false });
        socket.join(room.id);
        return { roomId: room.id, card };
    }
    refreshCard(roomId, telegramId) {
        const room = this.activeRooms.get(roomId);
        if (!room || room.phase !== "WAITING")
            return null;
        const player = room.players.get(telegramId);
        if (!player || player.lockedIn)
            return null;
        player.card = CardGenerator_1.CardGenerator.generate();
        return player.card;
    }
    /** Locks in the ticket: debits the entry fee and starts the countdown once enough players are in. */
    lockIn(roomId, telegramId) {
        const room = this.activeRooms.get(roomId);
        if (!room || room.phase !== "WAITING")
            return { ok: false, error: "This room already started." };
        const player = room.players.get(telegramId);
        if (!player)
            return { ok: false, error: "You're not in this room." };
        if (player.lockedIn)
            return { ok: false, error: "Already locked in." };
        let newBalance;
        try {
            newBalance = db.debit(telegramId, room.entryFeeCents, "TICKET_PURCHASE", roomId);
        }
        catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "Payment failed." };
        }
        player.lockedIn = true;
        this.broadcastRoomState(room);
        const lockedCount = [...room.players.values()].filter((p) => p.lockedIn).length;
        if (lockedCount >= MIN_PLAYERS_TO_START && room.phase === "WAITING") {
            room.phase = "COUNTDOWN";
            this.openRooms.set(room.tierKey, this.getOrCreateOpenRoom(room.tierKey)); // open a fresh room for late joiners
            this.startCountdown(room);
        }
        return { ok: true, balance: newBalance };
    }
    startCountdown(room) {
        let secondsLeft = SELECTION_SECONDS;
        this.io.to(room.id).emit("phase_changed", { phase: "COUNTDOWN", secondsLeft });
        room.countdownTimer = setInterval(() => {
            secondsLeft -= 1;
            this.io.to(room.id).emit("countdown_tick", { secondsLeft });
            if (secondsLeft <= 0) {
                clearInterval(room.countdownTimer);
                this.startGame(room);
            }
        }, 1000);
    }
    startGame(room) {
        const lockedPlayers = [...room.players.values()].filter((p) => p.lockedIn);
        if (lockedPlayers.length < MIN_PLAYERS_TO_START) {
            this.cancelAndRefund(room, "Not enough players locked in.");
            return;
        }
        // Drop anyone who previewed but never locked in — they were never charged.
        for (const [id, p] of room.players)
            if (!p.lockedIn)
                room.players.delete(id);
        room.phase = "IN_PROGRESS";
        this.io.to(room.id).emit("phase_changed", { phase: "IN_PROGRESS" });
        this.scheduleNextDraw(room);
    }
    scheduleNextDraw(room) {
        room.drawTimer = setTimeout(() => this.drawNumber(room), DRAW_INTERVAL_MS);
    }
    drawNumber(room) {
        if (room.phase !== "IN_PROGRESS")
            return; // paused for a claim, or already closed
        const remaining = [];
        for (let n = 1; n <= 75; n++)
            if (!room.drawnNumbers.includes(n))
                remaining.push(n);
        if (remaining.length === 0) {
            this.cancelAndRefund(room, "All 75 numbers drawn with no winner.");
            return;
        }
        const next = remaining[Math.floor(Math.random() * remaining.length)];
        room.drawnNumbers.push(next);
        this.io.to(room.id).emit("number_drawn", { number: next, drawnSoFar: room.drawnNumbers });
        // Server-side auto-win sweep: check every player's card after every
        // draw, exactly as the spec requires — no manual claim button needed.
        for (const player of room.players.values()) {
            const result = WinValidator_1.WinValidator.validate(player.card, room.drawnNumbers);
            if (result.won) {
                this.settleRoom(room, player.telegramId, result.pattern);
                return; // stop the loop the instant a winner is found
            }
        }
        this.scheduleNextDraw(room);
    }
    /** Kept for a Mini App variant that still shows a manual claim button; unused by the auto-win flow above but validated the same way. */
    claimBingo(roomId, telegramId) {
        const room = this.activeRooms.get(roomId);
        if (!room || room.phase !== "IN_PROGRESS")
            return { valid: false, message: "Game is not active." };
        const player = room.players.get(telegramId);
        if (!player)
            return { valid: false, message: "You're not in this room." };
        room.phase = "VALIDATING";
        if (room.drawTimer)
            clearTimeout(room.drawTimer);
        const result = WinValidator_1.WinValidator.validate(player.card, room.drawnNumbers);
        if (!result.won) {
            room.phase = "IN_PROGRESS";
            this.scheduleNextDraw(room);
            return { valid: false, message: "Not a valid BINGO yet." };
        }
        this.settleRoom(room, telegramId, result.pattern);
        return { valid: true, pattern: result.pattern, message: `BINGO confirmed: ${result.pattern}` };
    }
    settleRoom(room, winnerId, pattern) {
        if (room.drawTimer)
            clearTimeout(room.drawTimer);
        const { pot, rake, payout } = potFor(room);
        const newBalance = db.credit(winnerId, payout, "GAME_WIN", room.id);
        db.recordGame({
            roomId: room.id,
            tierKey: room.tierKey,
            entryFeeCents: room.entryFeeCents,
            playerIds: [...room.players.keys()],
            potCents: pot,
            rakeCents: rake,
            payoutCents: payout,
            winnerId,
            winningPattern: pattern,
            drawnNumbers: room.drawnNumbers,
            status: "COMPLETED",
        });
        this.io.to(room.id).emit("winner_confirmed", {
            winnerId,
            pattern,
            payoutCents: payout,
            winnerNewBalanceCents: newBalance,
        });
        room.phase = "CLOSED";
        this.activeRooms.delete(room.id);
    }
    cancelAndRefund(room, reason) {
        if (room.drawTimer)
            clearTimeout(room.drawTimer);
        for (const player of room.players.values()) {
            db.credit(player.telegramId, room.entryFeeCents, "REFUND", room.id);
        }
        db.recordGame({
            roomId: room.id,
            tierKey: room.tierKey,
            entryFeeCents: room.entryFeeCents,
            playerIds: [...room.players.keys()],
            potCents: 0,
            rakeCents: 0,
            payoutCents: 0,
            drawnNumbers: room.drawnNumbers,
            status: "CANCELLED",
        });
        this.io.to(room.id).emit("room_cancelled", { reason });
        room.phase = "CLOSED";
        this.activeRooms.delete(room.id);
    }
    broadcastRoomState(room) {
        const { payout } = potFor(room);
        this.io.to(room.id).emit("player_count", {
            playerCount: room.players.size,
            lockedCount: [...room.players.values()].filter((p) => p.lockedIn).length,
            potCents: payout,
        });
    }
    /** Called when a socket disconnects — cleans up a player who never locked in. */
    handleDisconnect(socketId) {
        for (const room of this.activeRooms.values()) {
            if (room.phase !== "WAITING")
                continue;
            for (const [id, p] of room.players) {
                if (p.socketId === socketId && !p.lockedIn)
                    room.players.delete(id);
            }
        }
    }
}
exports.RoomManager = RoomManager;
