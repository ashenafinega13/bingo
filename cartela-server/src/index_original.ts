/**
 * index.ts — server entry point.
 *
 * Run with: npm run dev   (local, auto-reload)
 *           npm run build && npm start   (production)
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { Server, Socket } from "socket.io";
import { verifyInitData } from "./auth";
import * as db from "./db";
import { RoomManager, TIERS } from "./game/RoomManager";
import { InsufficientBalanceError } from "./db";

const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // lock this to your real frontend URL in production

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: CORS_ORIGIN } });
const roomManager = new RoomManager(io);

// Attach the verified Telegram user to each socket at connection time.
// Every subsequent event on this socket trusts `socket.data.telegramId`
// instead of anything the client sends in the event payload.
io.use((socket: Socket, next) => {
  const initData = socket.handshake.auth?.initData as string | undefined;
  if (!initData) return next(new Error("Missing initData"));

  const verified = verifyInitData(initData);
  if (!verified) return next(new Error("Invalid or expired initData"));

  db.ensureUser(verified.user.id, verified.user.username, verified.user.first_name);
  socket.data.telegramId = verified.user.id;
  next();
});

io.on("connection", (socket: Socket) => {
  const telegramId: number = socket.data.telegramId;

  socket.emit("wallet:balance", { balanceCents: db.getBalanceCents(telegramId) });

  socket.on("tiers:list", (_payload, ack) => {
    ack?.({ tiers: TIERS });
  });

  socket.on("tier:join", (payload: { tierKey: string }, ack) => {
    if (!TIERS[payload.tierKey]) return ack?.({ error: "Unknown tier." });
    const { roomId, card } = roomManager.joinTier(payload.tierKey, telegramId, socket);
    ack?.({ roomId, card, balanceCents: db.getBalanceCents(telegramId) });
  });

  socket.on("cartela:refresh", (payload: { roomId: string }, ack) => {
    const card = roomManager.refreshCard(payload.roomId, telegramId);
    if (!card) return ack?.({ error: "Can't refresh right now." });
    ack?.({ card });
  });

  socket.on("cartela:lock", (payload: { roomId: string }, ack) => {
    const result = roomManager.lockIn(payload.roomId, telegramId);
    ack?.(result);
  });

  // Kept for a UI variant with a manual claim button — the RoomManager's
  // automatic sweep after every draw is what the spec's auto-win flow uses.
  socket.on("bingo:claim", (payload: { roomId: string }, ack) => {
    const result = roomManager.claimBingo(payload.roomId, telegramId);
    ack?.(result);
  });

  socket.on("wallet:mock_deposit", (payload: { amountBirr: number }, ack) => {
    // MOCK ONLY — see payments notes from earlier in this build. Replace
    // with a webhook-confirmed credit once you have a real merchant
    // integration; never credit directly from a client-triggered event
    // in production.
    const cents = Math.round(payload.amountBirr * 100);
    const newBalance = db.credit(telegramId, cents, "DEPOSIT", "mock");
    ack?.({ balanceCents: newBalance });
  });

  socket.on("wallet:mock_withdraw", (payload: { amountBirr: number }, ack) => {
    const cents = Math.round(payload.amountBirr * 100);
    try {
      const newBalance = db.debit(telegramId, cents, "WITHDRAW", "mock");
      ack?.({ balanceCents: newBalance });
    } catch (e) {
      ack?.({ error: e instanceof InsufficientBalanceError ? "Insufficient balance." : "Withdrawal failed." });
    }
  });

  socket.on("history:get", (_payload, ack) => {
    ack?.({ games: db.getHistory(telegramId) });
  });

  socket.on("disconnect", () => {
    roomManager.handleDisconnect(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Cartela server listening on port ${PORT}`);
});
