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
import { CardGenerator, Card, CARTELA_POOL_SIZE } from "./CardGenerator";
import { WinValidator } from "./WinValidator";
import * as db from "../db";

export const TIERS: Record<string, { label: string; entryFeeCents: number }> = {
  t10: { label: "10 Birr", entryFeeCents: 1000 },
};

const RAKE_PERCENT = 10;
const MIN_PLAYERS_TO_START = 2;
const SELECTION_SECONDS = 30;
const DRAW_INTERVAL_MS = 1000; // 1 number per second, per spec

type Phase = "WAITING" | "COUNTDOWN" | "IN_PROGRESS" | "VALIDATING" | "CLOSED";

interface Player {
  telegramId: number;
  displayName: string;
  socketId: string;
  card: Card | null;
  cartelaNumber: number | null; // which numbered card (1..CARTELA_POOL_SIZE) they picked
  lockedIn: boolean;
}

interface RoomState {
  id: string;
  tierKey: string;
  entryFeeCents: number;
  phase: Phase;
  players: Map<number, Player>;
  takenCartelas: Map<number, number>; // cartelaNumber -> telegramId who holds it
  drawnNumbers: number[];
  countdownTimer?: NodeJS.Timeout;
  drawTimer?: NodeJS.Timeout;
}

function potFor(room: RoomState) {
  const lockedCount = [...room.players.values()].filter((p) => p.lockedIn).length;
  const pot = room.entryFeeCents * lockedCount;
  const rake = Math.floor((pot * RAKE_PERCENT) / 100);
  return { pot, rake, payout: pot - rake };
}

function shortGameId(roomId: string): string {
  // Room ids are internally verbose (room_t20_172839...); show players a
  // short, stable, human-shareable code instead of the raw id.
  return roomId.slice(-8).toUpperCase();
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
        takenCartelas: new Map(),
        drawnNumbers: [],
      };
      this.openRooms.set(tierKey, room);
      this.activeRooms.set(room.id, room);
    }
    return room;
  }

  /** Snapshot of whatever round is currently live for this tier, for a
   * late joiner to watch without betting. Returns null if no round is
   * currently running. */
  getSpectateSnapshot(tierKey: string): {
    roomId: string; phase: Phase; drawnNumbers: number[]; playerCount: number; potCents: number; gameId: string;
  } | null {
    const roomId = this.liveGameByTier.get(tierKey);
    if (!roomId) return null;
    const room = this.activeRooms.get(roomId);
    if (!room || (room.phase !== "COUNTDOWN" && room.phase !== "IN_PROGRESS")) return null;
    const { payout } = potFor(room);
    return {
      roomId: room.id, phase: room.phase, drawnNumbers: room.drawnNumbers,
      playerCount: room.players.size, potCents: payout, gameId: shortGameId(room.id),
    };
  }

  /** Joins a socket to a room's broadcast channel WITHOUT registering them
   * as a player — they receive live events for awareness, but have no
   * card and cannot win or be charged. */
  joinAsSpectator(roomId: string, socket: Socket): boolean {
    const room = this.activeRooms.get(roomId);
    if (!room) return false;
    socket.join(room.id);
    return true;
  }

  /** Player opens the tier. No card is assigned yet — they must pick a
   * numbered cartela from the shared board via selectCartela(). */
  joinTier(tierKey: string, telegramId: number, socket: Socket, displayName: string): {
    roomId: string; poolSize: number; taken: number[]; gameId: string;
  } {
    const room = this.getOrCreateOpenRoom(tierKey);
    room.players.set(telegramId, {
      telegramId, displayName, socketId: socket.id, card: null, cartelaNumber: null, lockedIn: false,
    });
    socket.join(room.id);
    return { roomId: room.id, poolSize: CARTELA_POOL_SIZE, taken: [...room.takenCartelas.keys()], gameId: shortGameId(room.id) };
  }

  /** Books a specific numbered cartela for this player, releasing any
   * cartela they'd previously picked in this room. Fails if the number is
   * already held by someone else, or the room has moved past WAITING. */
  selectCartela(roomId: string, telegramId: number, cartelaNumber: number): { ok: boolean; error?: string; card?: Card } {
    const room = this.activeRooms.get(roomId);
    if (!room || room.phase !== "WAITING") return { ok: false, error: "This room already started." };
    if (cartelaNumber < 1 || cartelaNumber > CARTELA_POOL_SIZE) return { ok: false, error: "Invalid cartela number." };

    const player = room.players.get(telegramId);
    if (!player) return { ok: false, error: "You're not in this room." };
    if (player.lockedIn) return { ok: false, error: "Already locked in — can't change cartela now." };

    const holder = room.takenCartelas.get(cartelaNumber);
    if (holder !== undefined && holder !== telegramId) {
      return { ok: false, error: "That cartela is already taken. Pick another." };
    }

    // Release whatever this player had picked before, if anything.
    if (player.cartelaNumber !== null && player.cartelaNumber !== cartelaNumber) {
      room.takenCartelas.delete(player.cartelaNumber);
      this.io.to(room.id).emit("cartela_released", { roomId: room.id, cartelaNumber: player.cartelaNumber });
    }

    const card = CardGenerator.generateFixed(cartelaNumber);
    player.card = card;
    player.cartelaNumber = cartelaNumber;
    room.takenCartelas.set(cartelaNumber, telegramId);

    this.io.to(room.id).emit("cartela_taken", { roomId: room.id, cartelaNumber, telegramId });
    return { ok: true, card };
  }

  /** Locks in the ticket: debits the entry fee. Requires a cartela to
   * already be selected. Starts the countdown once enough players are in. */
  lockIn(roomId: string, telegramId: number): { ok: boolean; error?: string; balance?: number } {
    const room = this.activeRooms.get(roomId);
    if (!room || room.phase !== "WAITING") return { ok: false, error: "This room already started." };
    const player = room.players.get(telegramId);
    if (!player) return { ok: false, error: "You're not in this room." };
    if (player.lockedIn) return { ok: false, error: "Already locked in." };
    if (player.cartelaNumber === null || !player.card) return { ok: false, error: "Pick a cartela number first." };

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
      this.openRooms.set(room.tierKey, this.getOrCreateOpenRoom(room.tierKey)); // fresh room for late joiners' own bets
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
    // Drop anyone who picked a cartela / previewed but never actually paid
    // for a ticket — they were never charged, so nothing to refund, and
    // their cartela reservation (if any) is released back to the pool.
    for (const [id, p] of room.players) {
      if (!p.lockedIn) {
        if (p.cartelaNumber !== null) room.takenCartelas.delete(p.cartelaNumber);
        room.players.delete(id);
      }
    }

    room.phase = "IN_PROGRESS";
    this.io.to(room.id).emit("phase_changed", { roomId: room.id, phase: "IN_PROGRESS" });
    this.scheduleNextDraw(room);
  }

  private scheduleNextDraw(room: RoomState) {
    room.drawTimer = setTimeout(() => this.drawNumber(room), DRAW_INTERVAL_MS);
  }

  private drawNumber(room: RoomState) {
    if (room.phase !== "IN_PROGRESS") return; // paused for settlement, or already closed

    const remaining: number[] = [];
    for (let n = 1; n <= 75; n++) if (!room.drawnNumbers.includes(n)) remaining.push(n);
    if (remaining.length === 0) {
      this.cancelAndRefund(room, "All 75 numbers drawn with no winner.");
      return;
    }

    const next = remaining[Math.floor(Math.random() * remaining.length)];
    room.drawnNumbers.push(next);
    this.io.to(room.id).emit("number_drawn", {
      roomId: room.id, number: next, drawnSoFar: room.drawnNumbers, calledCount: room.drawnNumbers.length,
    });

    // Server-side auto-win sweep after every draw. Collects ALL matching
    // players from this same draw (more than one card can complete on the
    // same number) so a tie splits the pot rather than only paying
    // whichever player happened to be checked first.
    const winners: { telegramId: number; displayName: string; pattern: string; card: Card }[] = [];
    for (const player of room.players.values()) {
      if (!player.card) continue;
      const result = WinValidator.validate(player.card, room.drawnNumbers);
      if (result.won) {
        winners.push({ telegramId: player.telegramId, displayName: player.displayName, pattern: result.pattern!, card: player.card });
      }
    }

    if (winners.length > 0) {
      this.settleRoom(room, winners);
      return;
    }

    this.scheduleNextDraw(room);
  }

  private settleRoom(room: RoomState, winners: { telegramId: number; displayName: string; pattern: string; card: Card }[]) {
    if (room.drawTimer) clearTimeout(room.drawTimer);
    const { pot, rake, payout } = potFor(room);
    const perWinner = Math.floor(payout / winners.length); // remainder (if any) stays with the house rake

    const winnerResults = winners.map((w) => ({
      ...w,
      newBalance: db.credit(w.telegramId, perWinner, "GAME_WIN", room.id),
    }));

    db.recordGame({
      roomId: room.id,
      tierKey: room.tierKey,
      entryFeeCents: room.entryFeeCents,
      playerIds: [...room.players.keys()],
      potCents: pot,
      rakeCents: rake,
      payoutCents: payout,
      winnerId: winners[0].telegramId, // primary winner on record; full split is in the broadcast/ledger
      winningPattern: winners.map((w) => w.pattern).join(", "),
      drawnNumbers: room.drawnNumbers,
      status: "COMPLETED",
    });

    this.io.to(room.id).emit("winner_confirmed", {
      roomId: room.id,
      gameId: shortGameId(room.id),
      winners: winnerResults.map((w) => ({
        telegramId: w.telegramId,
        displayName: w.displayName,
        pattern: w.pattern,
        cartelaCard: w.card,
        payoutCents: perWinner,
        newBalanceCents: w.newBalance,
      })),
    });

    room.phase = "CLOSED";
    this.activeRooms.delete(room.id);
    if (this.liveGameByTier.get(room.tierKey) === room.id) this.liveGameByTier.delete(room.tierKey);
  }

  private cancelAndRefund(room: RoomState, reason: string) {
    if (room.drawTimer) clearTimeout(room.drawTimer);
    // IMPORTANT: only refund players who actually PAID (lockedIn) — anyone
    // who merely picked a cartela but never locked in was never charged,
    // so crediting them here would hand out money they never spent.
    for (const player of room.players.values()) {
      if (player.lockedIn) {
        db.credit(player.telegramId, room.entryFeeCents, "REFUND", room.id);
      }
    }
    db.recordGame({
      roomId: room.id,
      tierKey: room.tierKey,
      entryFeeCents: room.entryFeeCents,
      playerIds: [...room.players.keys()].filter((id) => room.players.get(id)!.lockedIn),
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
      gameId: shortGameId(room.id),
      playerCount: room.players.size,
      lockedCount: [...room.players.values()].filter((p) => p.lockedIn).length,
      potCents: payout,
      entryFeeCents: room.entryFeeCents,
    });
  }

  /** Called when a socket disconnects — cleans up a player who never
   * locked in, releasing any cartela they'd reserved. */
  handleDisconnect(socketId: string) {
    for (const room of this.activeRooms.values()) {
      if (room.phase !== "WAITING") continue;
      for (const [id, p] of room.players) {
        if (p.socketId === socketId && !p.lockedIn) {
          if (p.cartelaNumber !== null) {
            room.takenCartelas.delete(p.cartelaNumber);
            this.io.to(room.id).emit("cartela_released", { roomId: room.id, cartelaNumber: p.cartelaNumber });
          }
          room.players.delete(id);
        }
      }
    }
  }
}
