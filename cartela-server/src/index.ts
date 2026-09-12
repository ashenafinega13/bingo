/**
 * index.ts — server entry point.
 *
 * Run with: npm run dev   (local, auto-reload)
 *           npm run build && npm start   (production)
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
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

// Serve the built frontend (cartela-frontend/dist) from this same server,
// so the whole app — Mini App UI + API + WebSocket — lives behind ONE URL.
// This avoids needing two separate ngrok tunnels (or two separate hosted
// URLs in production) and sidesteps CORS entirely, since everything is
// now same-origin. (No catch-all route here on purpose — a wildcard route
// would intercept Socket.io's own /socket.io/ handshake requests and break
// the connection. express.static already serves index.html at "/" by
// default, which is all this single-page app needs.)
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.join(__dirname, "../../cartela-frontend/dist");
app.use(express.static(FRONTEND_DIST));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: CORS_ORIGIN } });
const roomManager = new RoomManager(io);

// Attach the verified Telegram user to each socket at connection time.
// Every subsequent event on this socket trusts `socket.data.telegramId`
// instead of anything the client sends in the event payload.
io.use((socket: Socket, next) => {
  const initData = socket.handshake.auth?.initData as string | undefined;
  console.log(`[connection attempt] socket ${socket.id}, initData present: ${!!initData}, length: ${initData?.length || 0}`);

  if (!initData) {
    console.log(`[connection rejected] socket ${socket.id}: no initData provided`);
    return next(new Error("Missing initData"));
  }

  const verified = verifyInitData(initData);
  if (!verified) {
    console.log(`[connection rejected] socket ${socket.id}: initData failed verification`);
    return next(new Error("Invalid or expired initData"));
  }

  console.log(`[connection accepted] socket ${socket.id}: telegram user ${verified.user.id} (${verified.user.username || "no username"})`);
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
    const spectate = roomManager.getSpectateSnapshot(payload.tierKey);
    if (spectate) roomManager.joinAsSpectator(spectate.roomId, socket);
    ack?.({ roomId, card, balanceCents: db.getBalanceCents(telegramId), spectate });
  });

  socket.on("spectate:get", (payload: { tierKey: string }, ack) => {
    const snapshot = roomManager.getSpectateSnapshot(payload.tierKey);
    if (snapshot) roomManager.joinAsSpectator(snapshot.roomId, socket);
    ack?.({ snapshot });
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

  socket.on("wallet:transfer", (payload: { toTelegramId: number; amountBirr: number }, ack) => {
    const cents = Math.round(payload.amountBirr * 100);
    try {
      const { senderNew } = db.transfer(telegramId, Number(payload.toTelegramId), cents);
      ack?.({ balanceCents: senderNew });
    } catch (e) {
      ack?.({ error: e instanceof Error ? e.message : "Transfer failed." });
    }
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
