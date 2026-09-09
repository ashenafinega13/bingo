import React, { useState, useEffect, useRef, useCallback } from "react";
import { Wallet, History, Gamepad2, Users, Coins, RefreshCw, Plus, X, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";

/**
 * CartelaMiniApp.jsx
 *
 * Standalone interactive demo of the Telegram Mini App frontend for the
 * Cartela bingo game. Runs entirely client-side with a simulated room so
 * it's playable without a backend — swap the simulation block (marked
 * below) for real socket.io events when wiring to the live server.
 *
 * ---- WIRING TO YOUR REAL BACKEND ----
 * Replace the "SIMULATION" section's setInterval-based number caller with:
 *
 *   import { io } from "socket.io-client";
 *   const socket = io(BACKEND_URL, { auth: { initData: window.Telegram.WebApp.initData } });
 *   socket.on("number_drawn", ({ number, drawnSoFar }) => { setDrawn(drawnSoFar); });
 *   socket.on("winner_confirmed", (payload) => { setWinner(payload); });
 *   socket.on("phase_changed", ({ phase, secondsLeft }) => { ... });
 *
 * The server (see GameLoopManager.ts from earlier in this build) remains
 * the sole source of truth for drawn numbers and win validation — this
 * component only ever *renders* server state, it never decides a win
 * locally in production. The local win-check below exists purely so the
 * demo is playable standalone.
 */

const COLUMN_LETTERS = ["B", "I", "N", "G", "O"];
const LETTER_RANGES = { B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75] };
const ENTRY_FEE_ETB = 50;
const RAKE_PERCENT = 10;
const SELECTION_SECONDS = 59;

function numberLetter(n) {
  for (const letter of COLUMN_LETTERS) {
    const [low, high] = LETTER_RANGES[letter];
    if (n >= low && n <= high) return letter;
  }
  return "?";
}

function generateCard() {
  const card = [[], [], [], [], []]; // card[row][col]
  COLUMN_LETTERS.forEach((letter, col) => {
    const [low, high] = LETTER_RANGES[letter];
    const pool = [];
    for (let n = low; n <= high; n++) pool.push(n);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let row = 0; row < 5; row++) card[row][col] = pool[row];
  });
  card[2][2] = "FREE";
  return card;
}

function checkWin(card, drawnSet) {
  const isMarked = (r, c) => card[r][c] === "FREE" || drawnSet.has(card[r][c]);

  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every((c) => isMarked(r, c))) return `Row ${r + 1}`;
  }
  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => isMarked(r, c))) return `Column ${COLUMN_LETTERS[c]}`;
  }
  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i))) return "Diagonal";
  if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i))) return "Diagonal";
  if (isMarked(0, 0) && isMarked(0, 4) && isMarked(4, 0) && isMarked(4, 4)) return "Four Corners";
  return null;
}

function BallChip({ number, size = "lg" }) {
  const dims = size === "lg" ? "w-20 h-20 text-3xl" : "w-11 h-11 text-sm";
  return (
    <div
      className={`${dims} rounded-full bg-amber-400 text-emerald-950 flex flex-col items-center justify-center font-bold shrink-0 shadow-lg`}
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <span className={size === "lg" ? "text-xs font-semibold opacity-70 -mb-1" : "text-[9px] opacity-70 -mb-0.5"}>
        {numberLetter(number)}
      </span>
      <span>{number}</span>
    </div>
  );
}

function LiveTicker({ drawn }) {
  const current = drawn[drawn.length - 1];
  const previous = drawn.slice(-5, -1).reverse();

  return (
    <div className="bg-emerald-900 rounded-2xl p-4 flex flex-col items-center gap-3">
      <div className="flex items-center gap-2 self-start">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500" />
        </span>
        <span className="text-emerald-200 text-sm">Live</span>
      </div>

      {current ? (
        <BallChip number={current} size="lg" />
      ) : (
        <div className="w-20 h-20 rounded-full border-2 border-dashed border-emerald-700 flex items-center justify-center text-emerald-500 text-xs text-center px-2">
          waiting for first call
        </div>
      )}

      <div className="flex gap-2 h-11 items-center">
        {previous.length === 0 && <span className="text-emerald-600 text-xs">no previous calls yet</span>}
        {previous.map((n, i) => (
          <BallChip key={i} number={n} size="sm" />
        ))}
      </div>
    </div>
  );
}

function CartelaGrid({ card, drawnSet, dimmed }) {
  return (
    <div className={`bg-stone-50 rounded-t-2xl overflow-hidden shadow-xl ${dimmed ? "opacity-40" : ""}`}>
      <div className="grid grid-cols-5 bg-emerald-950">
        {COLUMN_LETTERS.map((l) => (
          <div key={l} className="text-center py-2 text-amber-400 font-bold text-lg" style={{ fontFamily: "'Sora', sans-serif" }}>
            {l}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1 p-2">
        {card.map((row, r) =>
          row.map((val, c) => {
            const marked = val === "FREE" || drawnSet.has(val);
            return (
              <div
                key={`${r}-${c}`}
                className={`aspect-square rounded-lg flex items-center justify-center font-semibold text-sm transition-colors duration-300 ${
                  marked ? "bg-amber-400 text-emerald-950" : "bg-emerald-50 text-emerald-900"
                }`}
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {val === "FREE" ? "★" : val}
              </div>
            );
          })
        )}
      </div>
      {/* Ticket-stub perforation edge */}
      <div className="relative h-4 bg-stone-50">
        <div
          className="absolute inset-x-0 top-0 h-4 bg-emerald-950"
          style={{
            maskImage: "radial-gradient(circle 6px at 12px 0, transparent 6px, black 6.5px)",
            maskSize: "24px 100%",
            maskRepeat: "repeat-x",
            WebkitMaskImage: "radial-gradient(circle 6px at 12px 0, transparent 6px, black 6.5px)",
            WebkitMaskSize: "24px 100%",
            WebkitMaskRepeat: "repeat-x",
          }}
        />
      </div>
    </div>
  );
}

function RoomMetrics({ playerCount, potEtb }) {
  return (
    <div className="flex gap-3">
      <div className="flex-1 bg-emerald-900/60 rounded-xl px-4 py-3 flex items-center gap-3">
        <Users size={18} className="text-emerald-300" />
        <div>
          <div className="text-emerald-400 text-xs">Players</div>
          <div className="text-stone-50 font-semibold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {playerCount}
          </div>
        </div>
      </div>
      <div className="flex-1 bg-emerald-900/60 rounded-xl px-4 py-3 flex items-center gap-3">
        <Coins size={18} className="text-amber-400" />
        <div>
          <div className="text-emerald-400 text-xs">Prize pool</div>
          <div className="text-stone-50 font-semibold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {potEtb.toFixed(0)} ETB
          </div>
        </div>
      </div>
    </div>
  );
}

function WinnerPopup({ winner, onClose }) {
  if (!winner) return null;
  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-stone-50 rounded-2xl max-w-sm w-full p-6 text-center relative">
        <button onClick={onClose} className="absolute top-3 right-3 text-emerald-900/40 hover:text-emerald-900">
          <X size={20} />
        </button>
        <div className="text-5xl mb-2">🏆</div>
        <h2 className="text-emerald-950 text-xl font-bold mb-1" style={{ fontFamily: "'Sora', sans-serif" }}>
          {winner.name} won!
        </h2>
        <p className="text-emerald-700 text-sm mb-4">{winner.pattern}</p>
        <div
          className="bg-amber-400 text-emerald-950 rounded-xl py-3 text-2xl font-bold mb-4"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          +{winner.prize.toFixed(0)} ETB
        </div>
        <button
          onClick={onClose}
          className="w-full bg-emerald-900 text-stone-50 rounded-xl py-3 font-semibold"
        >
          Play again
        </button>
      </div>
    </div>
  );
}

function WalletView({ balance, onDeposit, onWithdraw }) {
  return (
    <div className="p-4 space-y-4">
      <div className="bg-gradient-to-br from-emerald-800 to-emerald-950 rounded-2xl p-6">
        <div className="text-emerald-300 text-sm mb-1">Your balance</div>
        <div className="text-stone-50 text-4xl font-bold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {balance.toFixed(2)} <span className="text-lg font-normal text-emerald-300">ETB</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onDeposit}
          className="bg-amber-400 text-emerald-950 rounded-xl py-4 flex flex-col items-center gap-1 font-semibold"
        >
          <ArrowDownToLine size={20} />
          Deposit
        </button>
        <button
          onClick={onWithdraw}
          className="bg-emerald-900 text-stone-50 rounded-xl py-4 flex flex-col items-center gap-1 font-semibold"
        >
          <ArrowUpFromLine size={20} />
          Withdraw
        </button>
      </div>
      <div className="bg-emerald-900/60 rounded-xl p-4 text-sm text-emerald-200">
        Deposits and withdrawals connect to your real Telebirr/CBE Birr merchant integration on the
        backend — this demo shows the interface only.
      </div>
    </div>
  );
}

function HistoryView({ games }) {
  return (
    <div className="p-4 space-y-2">
      {games.length === 0 && <div className="text-emerald-400 text-sm text-center py-8">No games played yet.</div>}
      {games.map((g, i) => (
        <div key={i} className="bg-emerald-900/60 rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-stone-50 font-medium">{g.tier} room</div>
            <div className="text-emerald-400 text-xs">{g.pattern}</div>
          </div>
          <div
            className={`font-bold ${g.won ? "text-amber-400" : "text-emerald-600"}`}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {g.won ? `+${g.amount} ETB` : "Lost"}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CartelaMiniApp() {
  const [tab, setTab] = useState("play");
  const [phase, setPhase] = useState("selecting"); // selecting | countdown_end | playing | won
  const [card, setCard] = useState(generateCard);
  const [drawn, setDrawn] = useState([]);
  const [secondsLeft, setSecondsLeft] = useState(SELECTION_SECONDS);
  const [playerCount, setPlayerCount] = useState(4);
  const [balance, setBalance] = useState(320);
  const [winner, setWinner] = useState(null);
  const [history, setHistory] = useState([]);
  const intervalRef = useRef(null);

  const potEtb = playerCount * ENTRY_FEE_ETB * (1 - RAKE_PERCENT / 100);

  // ---- Selection countdown ----
  useEffect(() => {
    if (phase !== "selecting") return;
    if (secondsLeft <= 0) {
      setPhase("playing");
      return;
    }
    const t = setTimeout(() => {
      setSecondsLeft((s) => s - 1);
      if (Math.random() < 0.3) setPlayerCount((p) => p + 1);
    }, 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft]);

  // ---- SIMULATION: server-driven number calling ----
  // Replace this block with the socket.io listener described in the
  // file header when connecting to the real backend.
  useEffect(() => {
    if (phase !== "playing") return;

    intervalRef.current = setInterval(() => {
      setDrawn((prevDrawn) => {
        const remaining = [];
        for (let n = 1; n <= 75; n++) if (!prevDrawn.includes(n)) remaining.push(n);
        if (remaining.length === 0) return prevDrawn;

        const next = remaining[Math.floor(Math.random() * remaining.length)];
        const newDrawn = [...prevDrawn, next];

        const pattern = checkWin(card, new Set(newDrawn));
        if (pattern) {
          clearInterval(intervalRef.current);
          const prize = playerCount * ENTRY_FEE_ETB * (1 - RAKE_PERCENT / 100);
          setWinner({ name: "You", pattern, prize });
          setBalance((b) => b + prize);
          setHistory((h) => [{ tier: "50 ETB", pattern, won: true, amount: prize.toFixed(0) }, ...h]);
          setPhase("won");
        }
        return newDrawn;
      });
    }, 1000);

    return () => clearInterval(intervalRef.current);
  }, [phase, card, playerCount]);

  const handleRefresh = useCallback(() => setCard(generateCard()), []);

  const handlePlayAgain = () => {
    setWinner(null);
    setDrawn([]);
    setCard(generateCard());
    setPlayerCount(4);
    setSecondsLeft(SELECTION_SECONDS);
    setPhase("selecting");
  };

  const drawnSet = new Set(drawn);

  return (
    <div
      className="min-h-screen bg-emerald-950 flex flex-col max-w-md mx-auto"
      style={{ fontFamily: "'Sora', sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
      `}</style>

      <div className="flex-1 overflow-y-auto pb-20">
        {tab === "play" && (
          <div className="p-4 space-y-4">
            {phase === "selecting" && (
              <>
                <div className="flex items-center justify-between">
                  <h1 className="text-stone-50 text-xl font-bold">Choose your Cartela</h1>
                  <div
                    className="w-14 h-14 rounded-full border-4 border-amber-400 flex items-center justify-center text-amber-400 font-bold"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {secondsLeft}
                  </div>
                </div>
                <RoomMetrics playerCount={playerCount} potEtb={potEtb} />
                <CartelaGrid card={card} drawnSet={new Set()} />
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handleRefresh}
                    className="bg-emerald-900 text-stone-50 rounded-xl py-3 flex items-center justify-center gap-2 font-semibold"
                  >
                    <RefreshCw size={18} />
                    Refresh
                  </button>
                  <button
                    onClick={() => {
                      setSecondsLeft(0);
                    }}
                    className="bg-amber-400 text-emerald-950 rounded-xl py-3 flex items-center justify-center gap-2 font-semibold"
                  >
                    Lock in — {ENTRY_FEE_ETB} ETB
                  </button>
                </div>
              </>
            )}

            {(phase === "playing" || phase === "won") && (
              <>
                <LiveTicker drawn={drawn} />
                <RoomMetrics playerCount={playerCount} potEtb={potEtb} />
                <CartelaGrid card={card} drawnSet={drawnSet} dimmed={phase === "won"} />
              </>
            )}
          </div>
        )}

        {tab === "wallet" && (
          <WalletView balance={balance} onDeposit={() => setBalance((b) => b + 100)} onWithdraw={() => {}} />
        )}

        {tab === "history" && <HistoryView games={history} />}
      </div>

      <WinnerPopup winner={phase === "won" ? winner : null} onClose={handlePlayAgain} />

      <div className="fixed bottom-0 inset-x-0 max-w-md mx-auto bg-emerald-900 border-t border-emerald-800 flex">
        {[
          { key: "play", label: "Play", icon: Gamepad2 },
          { key: "wallet", label: "Wallet", icon: Wallet },
          { key: "history", label: "History", icon: History },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 py-3 flex flex-col items-center gap-1 text-xs ${
              tab === key ? "text-amber-400" : "text-emerald-500"
            }`}
          >
            <Icon size={20} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
