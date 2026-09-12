/**
 * useGameSocket.js
 *
 * Connects the Mini App to the real Cartela backend — numbered-cartela
 * board version (pick a number 1..poolSize instead of a random/refresh
 * card), enriched live-game header (Game ID, players, bet, take-home,
 * called count), and multi-winner payout splitting.
 *
 * `game` exposes:
 *   connected, connectError, balanceCents, tiers, history, spectate,
 *   roomId, gameId, phase, secondsLeft, entryFeeCents,
 *   board ({ poolSize, taken: Set<number> }), selectedCartela, card,
 *   playerCount, potCents, drawn, calledCount, winners (array | null),
 *   joinTier(tierKey), selectCartela(number, onError), lockIn(onError),
 *   mockDeposit(amountBirr), mockWithdraw(amountBirr, onError),
 *   transfer(toTelegramId, amountBirr, onError, onSuccess), fetchHistory()
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

export function useGameSocket(backendUrl) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [balanceCents, setBalanceCents] = useState(0);
  const [tiers, setTiers] = useState({});
  const [roomId, setRoomId] = useState(null);
  const [gameId, setGameId] = useState(null);
  const [entryFeeCents, setEntryFeeCents] = useState(0);
  const [board, setBoard] = useState({ poolSize: 600, taken: new Set() });
  const [selectedCartela, setSelectedCartela] = useState(null);
  const [card, setCard] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | WAITING | COUNTDOWN | IN_PROGRESS | CLOSED
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [drawn, setDrawn] = useState([]);
  const [calledCount, setCalledCount] = useState(0);
  const [playerCount, setPlayerCount] = useState(0);
  const [potCents, setPotCents] = useState(0);
  const [winners, setWinners] = useState(null); // array of {telegramId, pattern, cartelaCard, payoutCents, newBalanceCents} | null
  const [history, setHistory] = useState([]);
  const [spectate, setSpectate] = useState(null); // { roomId, gameId, phase, drawnNumbers, playerCount, potCents } | null

  // Refs mirror state so socket handlers (registered once, in the effect's
  // closure) always compare against the CURRENT roomId/spectate roomId.
  const roomIdRef = useRef(null);
  const spectateRoomIdRef = useRef(null);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { spectateRoomIdRef.current = spectate?.roomId || null; }, [spectate]);

  function getMyTelegramId() {
    return window?.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  }

  useEffect(() => {
    const initData = window?.Telegram?.WebApp?.initData;
    if (!initData) {
      console.warn("No Telegram initData found — open this page via the bot's Menu Button to authenticate.");
    }

    const socket = io(backendUrl, {
      auth: { initData: initData || "" },
      // ngrok's free tier can inject a browser-warning interstitial that
      // silently breaks Socket.io's polling handshake. This header skips it.
      extraHeaders: { "ngrok-skip-browser-warning": "true" },
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => {
      console.error("Socket auth/connection failed:", err.message);
      setConnectError(err.message);
    });

    socket.on("wallet:balance", ({ balanceCents }) => setBalanceCents(balanceCents));

    socket.on("player_count", ({ roomId: evRoomId, playerCount, potCents, gameId, entryFeeCents }) => {
      if (evRoomId !== roomIdRef.current) return;
      setPlayerCount(playerCount);
      setPotCents(potCents);
      if (gameId) setGameId(gameId);
      if (entryFeeCents !== undefined) setEntryFeeCents(entryFeeCents);
    });

    socket.on("phase_changed", ({ roomId: evRoomId, phase: newPhase, secondsLeft: sl }) => {
      if (evRoomId === roomIdRef.current) {
        setPhase(newPhase);
        if (sl !== undefined) setSecondsLeft(sl);
      } else if (evRoomId === spectateRoomIdRef.current) {
        setSpectate((prev) => (prev ? { ...prev, phase: newPhase } : prev));
      }
    });

    socket.on("countdown_tick", ({ roomId: evRoomId, secondsLeft: sl }) => {
      if (evRoomId === roomIdRef.current) setSecondsLeft(sl);
    });

    socket.on("number_drawn", ({ roomId: evRoomId, drawnSoFar, calledCount: cc }) => {
      if (evRoomId === roomIdRef.current) {
        setDrawn(drawnSoFar);
        setCalledCount(cc);
      } else if (evRoomId === spectateRoomIdRef.current) {
        setSpectate((prev) => (prev ? { ...prev, drawnNumbers: drawnSoFar } : prev));
      }
    });

    // Someone (possibly us, from another tab/device) booked or released a
    // numbered cartela in our own room — keep the board's taken-set live.
    socket.on("cartela_taken", ({ roomId: evRoomId, cartelaNumber }) => {
      if (evRoomId !== roomIdRef.current) return;
      setBoard((prev) => ({ ...prev, taken: new Set(prev.taken).add(cartelaNumber) }));
    });
    socket.on("cartela_released", ({ roomId: evRoomId, cartelaNumber }) => {
      if (evRoomId !== roomIdRef.current) return;
      setBoard((prev) => {
        const next = new Set(prev.taken);
        next.delete(cartelaNumber);
        return { ...prev, taken: next };
      });
    });

    socket.on("winner_confirmed", (payload) => {
      if (payload.roomId === roomIdRef.current) {
        setWinners(payload.winners);
        setPhase("CLOSED");
        const mine = payload.winners.find((w) => w.telegramId === getMyTelegramId());
        if (mine) setBalanceCents(mine.newBalanceCents);
      } else if (payload.roomId === spectateRoomIdRef.current) {
        // The round we were only watching just ended — our own room (next
        // round) is unaffected, just stop showing the spectate panel.
        setSpectate(null);
      }
    });

    socket.on("room_cancelled", ({ roomId: evRoomId }) => {
      if (evRoomId === roomIdRef.current) {
        setPhase("idle");
        setRoomId(null);
      } else if (evRoomId === spectateRoomIdRef.current) {
        setSpectate(null);
      }
    });

    socket.emit("tiers:list", {}, ({ tiers }) => setTiers(tiers));

    return () => socket.disconnect();
  }, [backendUrl]);

  const joinTier = useCallback((tierKey) => {
    socketRef.current?.emit("tier:join", { tierKey }, (res) => {
      if (res.error) return console.error(res.error);
      setRoomId(res.roomId);
      setGameId(res.gameId);
      setBoard({ poolSize: res.poolSize, taken: new Set(res.taken) });
      setSelectedCartela(null);
      setCard(null);
      setDrawn([]);
      setCalledCount(0);
      setWinners(null);
      setPhase("WAITING");
      // If a round is already live for this tier, watch it read-only —
      // no card, no bet — while this new room (for the NEXT round) is
      // what the player can actually pick a cartela and bet in.
      setSpectate(res.spectate || null);
    });
  }, []);

  const selectCartela = useCallback(
    (cartelaNumber, onError) => {
      if (!roomId) return;
      socketRef.current?.emit("cartela:select", { roomId, cartelaNumber }, (res) => {
        if (!res.ok) return onError?.(res.error);
        setSelectedCartela(cartelaNumber);
        setCard(res.card);
      });
    },
    [roomId]
  );

  const lockIn = useCallback(
    (onError) => {
      if (!roomId) return;
      socketRef.current?.emit("cartela:lock", { roomId }, (res) => {
        if (!res.ok) return onError?.(res.error);
        setBalanceCents(res.balance);
      });
    },
    [roomId]
  );

  const mockDeposit = useCallback((amountBirr) => {
    socketRef.current?.emit("wallet:mock_deposit", { amountBirr }, (res) => {
      if (res.balanceCents !== undefined) setBalanceCents(res.balanceCents);
    });
  }, []);

  const mockWithdraw = useCallback((amountBirr, onError) => {
    socketRef.current?.emit("wallet:mock_withdraw", { amountBirr }, (res) => {
      if (res.error) return onError?.(res.error);
      setBalanceCents(res.balanceCents);
    });
  }, []);

  const transfer = useCallback((toTelegramId, amountBirr, onError, onSuccess) => {
    socketRef.current?.emit("wallet:transfer", { toTelegramId, amountBirr }, (res) => {
      if (res.error) return onError?.(res.error);
      setBalanceCents(res.balanceCents);
      onSuccess?.();
    });
  }, []);

  const fetchHistory = useCallback(() => {
    socketRef.current?.emit("history:get", {}, (res) => setHistory(res.games || []));
  }, []);

  return {
    connected,
    connectError,
    balanceCents,
    tiers,
    roomId,
    gameId,
    entryFeeCents,
    board,
    selectedCartela,
    card,
    phase,
    secondsLeft,
    drawn,
    calledCount,
    playerCount,
    potCents,
    winners,
    history,
    spectate,
    joinTier,
    selectCartela,
    lockIn,
    mockDeposit,
    mockWithdraw,
    transfer,
    fetchHistory,
  };
}
