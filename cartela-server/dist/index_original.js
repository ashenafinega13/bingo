"use strict";
/**
 * index.ts — server entry point.
 *
 * Run with: npm run dev   (local, auto-reload)
 *           npm run build && npm start   (production)
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const auth_1 = require("./auth");
const db = __importStar(require("./db"));
const RoomManager_1 = require("./game/RoomManager");
const db_1 = require("./db");
const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // lock this to your real frontend URL in production
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: CORS_ORIGIN }));
app.use(express_1.default.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
const httpServer = http_1.default.createServer(app);
const io = new socket_io_1.Server(httpServer, { cors: { origin: CORS_ORIGIN } });
const roomManager = new RoomManager_1.RoomManager(io);
// Attach the verified Telegram user to each socket at connection time.
// Every subsequent event on this socket trusts `socket.data.telegramId`
// instead of anything the client sends in the event payload.
io.use((socket, next) => {
    const initData = socket.handshake.auth?.initData;
    if (!initData)
        return next(new Error("Missing initData"));
    const verified = (0, auth_1.verifyInitData)(initData);
    if (!verified)
        return next(new Error("Invalid or expired initData"));
    db.ensureUser(verified.user.id, verified.user.username, verified.user.first_name);
    socket.data.telegramId = verified.user.id;
    next();
});
io.on("connection", (socket) => {
    const telegramId = socket.data.telegramId;
    socket.emit("wallet:balance", { balanceCents: db.getBalanceCents(telegramId) });
    socket.on("tiers:list", (_payload, ack) => {
        ack?.({ tiers: RoomManager_1.TIERS });
    });
    socket.on("tier:join", (payload, ack) => {
        if (!RoomManager_1.TIERS[payload.tierKey])
            return ack?.({ error: "Unknown tier." });
        const { roomId, card } = roomManager.joinTier(payload.tierKey, telegramId, socket);
        ack?.({ roomId, card, balanceCents: db.getBalanceCents(telegramId) });
    });
    socket.on("cartela:refresh", (payload, ack) => {
        const card = roomManager.refreshCard(payload.roomId, telegramId);
        if (!card)
            return ack?.({ error: "Can't refresh right now." });
        ack?.({ card });
    });
    socket.on("cartela:lock", (payload, ack) => {
        const result = roomManager.lockIn(payload.roomId, telegramId);
        ack?.(result);
    });
    // Kept for a UI variant with a manual claim button — the RoomManager's
    // automatic sweep after every draw is what the spec's auto-win flow uses.
    socket.on("bingo:claim", (payload, ack) => {
        const result = roomManager.claimBingo(payload.roomId, telegramId);
        ack?.(result);
    });
    socket.on("wallet:mock_deposit", (payload, ack) => {
        // MOCK ONLY — see payments notes from earlier in this build. Replace
        // with a webhook-confirmed credit once you have a real merchant
        // integration; never credit directly from a client-triggered event
        // in production.
        const cents = Math.round(payload.amountBirr * 100);
        const newBalance = db.credit(telegramId, cents, "DEPOSIT", "mock");
        ack?.({ balanceCents: newBalance });
    });
    socket.on("wallet:mock_withdraw", (payload, ack) => {
        const cents = Math.round(payload.amountBirr * 100);
        try {
            const newBalance = db.debit(telegramId, cents, "WITHDRAW", "mock");
            ack?.({ balanceCents: newBalance });
        }
        catch (e) {
            ack?.({ error: e instanceof db_1.InsufficientBalanceError ? "Insufficient balance." : "Withdrawal failed." });
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
