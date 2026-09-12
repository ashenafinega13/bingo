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

import { Server, Socket } from "socket.io";
import { CardGenerator, Card } from "./CardGenerator";
import { WinValidator } from "./WinValidator";
import * as db from "../db";

export const TIERS: Record<string, { label: string; entryFeeCents: number }> = {
  t20: { label: "20 Birr", entryFeeCents: 2000 },
  t50: { label: "50 Birr", entryFeeCents: 5000 },
  t100: { label: "100 Birr", entryFeeCents: 10000 },
};

const RAKE_PERCENT = 10;
const MIN_PLAYERS_TO_START = 2;
const SELECTION_SECONDS = 30;
const DRAW_INTERVAL_MS = 1000; // spec calls for 1-number-per-second

type Phase = "WAITING" | "COUNTDOWN" | "IN_PROGRESS" | "VALIDATING" | "CLOSED";

interface Player {
  telegramId: number;
  socketId: string;
  card: Card;
  lockedIn: boolean;
}

interface RoomState {
  id: string;
  tierKey: string;
  entryFeeCents: number;
  phase: Phase;
  players: Map<number, Player>;
  drawnNumbers: number[];
  countdownTimer?: NodeJS.Timeout;
  drawTimer?: NodeJS.Timeout;
}

function potFor(room: RoomState) {
  const pot = room.entryFeeCents * room.players.size;
  const rake = Math.floor((pot * RAKE_PERCENT) / 100);
  return { pot, rake, payout: pot - rake };
}

export class RoomManager {
  private io: Server;
  private openRooms = new Map<string, RoomState>(); // tierKey -> currently-joinable room
  private activeRooms = new Map<string, RoomState>(); // roomId -> any non-closed room
  private liveGameByTier = new Map<string, string>(); // tierKey -> roomId of the currently COUNTDOWN/IN_PROGRESS round, for spectating

  constructor(io: Server) {
    this.io = io;
  }

  private getOrCreateOpenRoom(tierKey: string): RoomState {
    let room = this.openRooms.get(tierKey);
    if (!room || room.phase !== "WAITING") {
      room = {
        id: `room_${tierKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        tierKey,
        entryFeeCents: TIERS[tierKey].entryFeeCents,
        phase: "WAITING",
        players: new Map(),
        drawnNumbers: [],
      };
      this.openRooms.set(tierKey, room);
      this.activeRooms.set(room.id, room);
    }
    return room;
  }

  /** Snapshot of whatever round is currently live for this tier, for a
   * late joiner to watch without betting. Returns null if no round is
   * currently running (e.g. still in the WAITING lobby, or nothing yet
   * started today for this tier). */
  getSpectateSnapshot(tierKey: string): {
    roomId: string; phase: Phase; drawnNumbers: number[]; playerCount: number; potCents: number;
  } | null {
    const roomId = this.liveGameByTier.get(tierKey);
    if (!roomId) return null;
    const room = this.activeRooms.get(roomId);
    if (!room || (room.phase !== "COUNTDOWN" && room.phase !== "IN_PROGRESS")) return null;
    const { payout } = potFor(room);
    return { roomId: room.id, phase: room.phase, drawnNumbers: room.drawnNumbers, playerCount: room.players.size, potCents: payout };
  }

  /** Joins a socket to a room's broadcast channel WITHOUT registering them
   * as a player — they receive number_drawn/phase_changed/winner_confirmed
   * events for awareness, but have no card and cannot win or be charged. */
  joinAsSpectator(roomId: string, socket: Socket): boolean {
    const room = this.activeRooms.get(roomId);
    if (!room) return false;
    socket.join(room.id);
    return true;
  }

  /** Player opens the tier and gets a fresh card to preview/refresh. */
  joinTier(tierKey: string, telegramId: number, socket: Socket): { roomId: string; card: Card } {
    const room = this.getOrCreateOpenRoom(tierKey);
    const card = CardGenerator.generate();
    room.players.set(telegramId, { telegramId, socketId: socket.id, card, lockedIn: false });
    socket.join(room.id);
    return { roomId: room.id, card };
  }

  refreshCard(roomId: string, telegramId: number): Card | null {
    const room = this.activeRooms.get(roomId);
    if (!room || room.phase !== "WAITING") return null;
    const player = room.players.get(telegramId);
    if (!player || player.lockedIn) return null;
    player.card = CardGenerator.generate();
    return player.card;
  }

  /** Locks in the ticket: debits the entry fee and starts the countdown once enough players are in. */
  lockIn(roomId: string, telegramId: number): { ok: boolean; error?: string; balance?: number } {
    const room = this.activeRooms.get(roomId);
    if (!room || room.phase !== "WAITING") return { ok: false, error: "This room already started." };
    const player = room.players.get(telegramId);
    if (!player) return { ok: false, error: "You're not in this room." };
    if (player.lockedIn) return { ok: false, error: "Already locked in." };

    let newBalance: number;
    try {
      newBalance = db.debit(telegramId, room.entryFeeCents, "TICKET_PURCHASE", roomId);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Payment failed." };
    }

    player.lockedIn = true;
    this.broadcastRoomState(room);

    const lockedCount = [...room.players.values()].filter((p) => p.lockedIn).length;
    if (lockedCount >= MIN_PLAYERS_TO_START && room.phase === "WAITING") {
      room.phase = "COUNTDOWN";
      this.liveGameByTier.set(room.tierKey, room.id); // this round becomes watchable by late joiners
      this.openRooms.set(room.tierKey, this.getOrCreateOpenRoom(room.tierKey)); // open a fresh room for late joiners' own bets
      this.startCountdown(room);
    }

    return { ok: true, balance: newBalance };
  }

  private startCountdown(room: RoomState) {
    let secondsLeft = SELECTION_SECONDS;
    this.io.to(room.id).emit("phase_changed", { roomId: room.id, phase: "COUNTDOWN", secondsLeft });

    room.countdownTimer = setInterval(() => {
      secondsLeft -= 1;
      this.io.to(room.id).emit("countdown_tick", { roomId: room.id, secondsLeft });
      if (secondsLeft <= 0) {
        clearInterval(room.countdownTimer);
        this.startGame(room);
      }
    }, 1000);
  }

  private startGame(room: RoomState) {
    const lockedPlayers = [...room.players.values()].filter((p) => p.lockedIn);
    if (lockedPlayers.length < MIN_PLAYERS_TO_START) {
      this.cancelAndRefund(room, "Not enough players locked in.");
      return;
    }
    // Drop anyone who previewed but never locked in — they were never charged.
    for (const [id, p] of room.players) if (!p.lockedIn) room.players.delete(id);

    room.phase = "IN_PROGRESS";
    this.io.to(room.id).emit("phase_changed", { roomId: room.id, phase: "IN_PROGRESS" });
    this.scheduleNextDraw(room);
  }

  private scheduleNextDraw(room: RoomState) {
    room.drawTimer = setTimeout(() => this.drawNumber(room), DRAW_INTERVAL_MS);
  }

  private drawNumber(room: RoomState) {
    if (room.phase !== "IN_PROGRESS") return; // paused for a claim, or already closed

    const remaining: number[] = [];
    for (let n = 1; n <= 75; n++) if (!room.drawnNumbers.includes(n)) remaining.push(n);
    if (remaining.length === 0) {
      this.cancelAndRefund(room, "All 75 numbers drawn with no winner.");
      return;
    }

    const next = remaining[Math.floor(Math.random() * remaining.length)];
    room.drawnNumbers.push(next);
    this.io.to(room.id).emit("number_drawn", { roomId: room.id, number: next, drawnSoFar: room.drawnNumbers });

    // Server-side auto-win sweep: check every player's card after every
    // draw, exactly as the spec requires — no manual claim button needed.
    for (const player of room.players.values()) {
      const result = WinValidator.validate(player.card, room.drawnNumbers);
      if (result.won) {
        this.settleRoom(room, player.telegramId, result.pattern!);
        return; // stop the loop the instant a winner is found
      }
    }

    this.scheduleNextDraw(room);
  }

  /** Kept for a Mini App variant that still shows a manual claim button; unused by the auto-win flow above but validated the same way. */
  claimBingo(roomId: string, telegramId: number): { valid: boolean; pattern?: string; message: string } {
    const room = this.activeRooms.get(roomId);
    if (!room || room.phase !== "IN_PROGRESS") return { valid: false, message: "Game is not active." };
    const player = room.players.get(telegramId);
    if (!player) return { valid: false, message: "You're not in this room." };

    room.phase = "VALIDATING";
    if (room.drawTimer) clearTimeout(room.drawTimer);

    const result = WinValidator.validate(player.card, room.drawnNumbers);
    if (!result.won) {
      room.phase = "IN_PROGRESS";
      this.scheduleNextDraw(room);
      return { valid: false, message: "Not a valid BINGO yet." };
    }

    this.settleRoom(room, telegramId, result.pattern!);
    return { valid: true, pattern: result.pattern, message: `BINGO confirmed: ${result.pattern}` };
  }

  private settleRoom(room: RoomState, winnerId: number, pattern: string) {
    if (room.drawTimer) clearTimeout(room.drawTimer);
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
      roomId: room.id,
      winnerId,
      pattern,
      payoutCents: payout,
      winnerNewBalanceCents: newBalance,
    });

    room.phase = "CLOSED";
    this.activeRooms.delete(room.id);
    if (this.liveGameByTier.get(room.tierKey) === room.id) this.liveGameByTier.delete(room.tierKey);
  }

  private cancelAndRefund(room: RoomState, reason: string) {
    if (room.drawTimer) clearTimeout(room.drawTimer);
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
    this.io.to(room.id).emit("room_cancelled", { roomId: room.id, reason });
    room.phase = "CLOSED";
    this.activeRooms.delete(room.id);
    if (this.liveGameByTier.get(room.tierKey) === room.id) this.liveGameByTier.delete(room.tierKey);
  }

  private broadcastRoomState(room: RoomState) {
    const { payout } = potFor(room);
    this.io.to(room.id).emit("player_count", {
      roomId: room.id,
      playerCount: room.players.size,
      lockedCount: [...room.players.values()].filter((p) => p.lockedIn).length,
      potCents: payout,
    });
  }

  /** Called when a socket disconnects — cleans up a player who never locked in. */
  handleDisconnect(socketId: string) {
    for (const room of this.activeRooms.values()) {
      if (room.phase !== "WAITING") continue;
      for (const [id, p] of room.players) {
        if (p.socketId === socketId && !p.lockedIn) room.players.delete(id);
      }
    }
  }
}
