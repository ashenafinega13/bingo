/**
 * useGameSocket.js
 *
 * Connects the Mini App to the real Cartela backend. Replaces the
 * setInterval-based simulation block in CartelaMiniApp.jsx.
 *
 * Usage inside CartelaMiniApp.jsx:
 *
 *   import { useGameSocket } from "./useGameSocket";
 *   const game = useGameSocket("https://your-backend-url.example.com");
 *
 * `game` exposes: connected, balanceCents, tiers, joinTier(tierKey),
 * refreshCard(), lockIn(), roomId, card, phase, secondsLeft, drawn,
 * playerCount, potCents, winner, mockDeposit(amountBirr), history, fetchHistory()
 *
 * See the integration notes at the bottom of this file for the exact
 * lines to change in CartelaMiniApp.jsx.
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
  const [card, setCard] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | WAITING | COUNTDOWN | IN_PROGRESS | CLOSED
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [drawn, setDrawn] = useState([]);
  const [playerCount, setPlayerCount] = useState(0);
  const [potCents, setPotCents] = useState(0);
  const [winner, setWinner] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    // window.Telegram.WebApp is injected automatically when this page is
    // opened as a Telegram Mini App. It will be undefined if you're
    // testing in a plain browser tab — see the deployment steps for how
    // to test for real inside Telegram.
    const initData = window?.Telegram?.WebApp?.initData;
    if (!initData) {
      console.warn("No Telegram initData found — open this page via the bot's Menu Button to authenticate.");
    }

    const socket = io(backendUrl, {
      auth: { initData: initData || "" },
      // ngrok's free tier shows an interstitial "you're about to visit"
      // page to browsers by default, which can intercept Socket.io's
      // polling handshake requests and make the connection hang forever
      // with no visible error. This header tells ngrok to skip it.
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
    socket.on("player_count", ({ playerCount, potCents }) => {
      setPlayerCount(playerCount);
      setPotCents(potCents);
    });
    socket.on("phase_changed", ({ phase, secondsLeft }) => {
      setPhase(phase);
      if (secondsLeft !== undefined) setSecondsLeft(secondsLeft);
    });
    socket.on("countdown_tick", ({ secondsLeft }) => setSecondsLeft(secondsLeft));
    socket.on("number_drawn", ({ drawnSoFar }) => setDrawn(drawnSoFar));
    socket.on("winner_confirmed", (payload) => {
      setWinner(payload);
      setPhase("CLOSED");
      if (payload.winnerId === getMyTelegramId()) {
        setBalanceCents(payload.winnerNewBalanceCents);
      }
    });
    socket.on("room_cancelled", () => {
      setPhase("idle");
      setRoomId(null);
    });

    socket.emit("tiers:list", {}, ({ tiers }) => setTiers(tiers));

    return () => socket.disconnect();
  }, [backendUrl]);

  function getMyTelegramId() {
    return window?.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  }

  const joinTier = useCallback((tierKey) => {
    socketRef.current?.emit("tier:join", { tierKey }, (res) => {
      if (res.error) return console.error(res.error);
      setRoomId(res.roomId);
      setCard(res.card);
      setBalanceCents(res.balanceCents);
      setDrawn([]);
      setWinner(null);
      setPhase("WAITING");
    });
  }, []);

  const refreshCard = useCallback(() => {
    if (!roomId) return;
    socketRef.current?.emit("cartela:refresh", { roomId }, (res) => {
      if (res.error) return console.error(res.error);
      setCard(res.card);
    });
  }, [roomId]);

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

  const fetchHistory = useCallback(() => {
    socketRef.current?.emit("history:get", {}, (res) => setHistory(res.games || []));
  }, []);

  return {
    connected,
    connectError,
    balanceCents,
    tiers,
    roomId,
    card,
    phase,
    secondsLeft,
    drawn,
    playerCount,
    potCents,
    winner,
    history,
    joinTier,
    refreshCard,
    lockIn,
    mockDeposit,
    mockWithdraw,
    fetchHistory,
  };
}

/**
 * ---- INTEGRATION NOTES for CartelaMiniApp.jsx ----
 *
 * 1. Add near the top:
 *      import { useGameSocket } from "./useGameSocket";
 *
 * 2. Inside the CartelaMiniApp component, replace the local useState/useEffect
 *    simulation block (phase, drawn, secondsLeft, playerCount, the "SIMULATION"
 *    useEffect, generateCard/checkWin calls) with:
 *      const game = useGameSocket("https://your-backend-url.example.com");
 *
 * 3. Replace references:
 *      card              -> game.card
 *      drawn             -> game.drawn
 *      phase             -> game.phase   (values now: "idle" | "WAITING" | "COUNTDOWN" | "IN_PROGRESS" | "CLOSED")
 *      secondsLeft        -> game.secondsLeft
 *      playerCount        -> game.playerCount
 *      potEtb             -> game.potCents / 100
 *      balance            -> game.balanceCents / 100
 *      winner             -> game.winner  (shape: { winnerId, pattern, payoutCents })
 *      handleRefresh()    -> game.refreshCard()
 *      "Lock in" button   -> game.lockIn(errorMsg => alert(errorMsg))
 *      handlePlayAgain()  -> game.joinTier(selectedTierKey) again, or reset to tier list
 *
 * 4. For the tier-selection screen, use game.tiers (an object keyed by tier
 *    key with { label, entryFeeCents }) instead of a hardcoded ENTRY_FEE_ETB,
 *    and call game.joinTier(tierKey) when the user picks one.
 */
