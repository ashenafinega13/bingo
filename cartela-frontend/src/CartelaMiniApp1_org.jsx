import React, { useState, useEffect } from "react";
import { Wallet, History, Gamepad2, Users, Coins, RefreshCw, ArrowDownToLine, ArrowUpFromLine, X } from "lucide-react";
import { useGameSocket } from "./useGameSocket";

// Point this at your backend. Use http://localhost:3001 for local testing,
// and your real deployed backend URL once you go live.
const BACKEND_URL = "http://localhost:3001";

const COLUMN_LETTERS = ["B", "I", "N", "G", "O"];

function numberLetter(n) {
  const ranges = { B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75] };
  for (const letter of COLUMN_LETTERS) {
    const [low, high] = ranges[letter];
    if (n >= low && n <= high) return letter;
  }
  return "?";
}

function myTelegramId() {
  return window?.Telegram?.WebApp?.initDataUnsafe?.user?.id;
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
  if (!card) return null;
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

function RoomMetrics({ playerCount, potCents }) {
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
            {(potCents / 100).toFixed(0)} ETB
          </div>
        </div>
      </div>
    </div>
  );
}

function TierSelect({ tiers, onSelect }) {
  const entries = Object.entries(tiers);
  return (
    <div className="space-y-3">
      <h1 className="text-stone-50 text-xl font-bold">Choose a room</h1>
      {entries.length === 0 && <div className="text-emerald-400 text-sm">Connecting to server...</div>}
      {entries.map(([key, info]) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className="w-full bg-emerald-900 hover:bg-emerald-800 text-stone-50 rounded-xl p-4 flex items-center justify-between transition-colors"
        >
          <span className="font-semibold">{info.label} room</span>
          <span className="text-amber-400 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            Entry: {(info.entryFeeCents / 100).toFixed(0)} ETB
          </span>
        </button>
      ))}
    </div>
  );
}

function WinnerPopup({ winner, myId, onClose }) {
  if (!winner) return null;
  const isMe = winner.winnerId === myId;
  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-stone-50 rounded-2xl max-w-sm w-full p-6 text-center relative">
        <button onClick={onClose} className="absolute top-3 right-3 text-emerald-900/40 hover:text-emerald-900">
          <X size={20} />
        </button>
        <div className="text-5xl mb-2">🏆</div>
        <h2 className="text-emerald-950 text-xl font-bold mb-1" style={{ fontFamily: "'Sora', sans-serif" }}>
          {isMe ? "You won!" : `Player ${winner.winnerId} won!`}
        </h2>
        <p className="text-emerald-700 text-sm mb-4">{winner.pattern}</p>
        <div
          className="bg-amber-400 text-emerald-950 rounded-xl py-3 text-2xl font-bold mb-4"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          {isMe ? "+" : ""}
          {(winner.payoutCents / 100).toFixed(0)} ETB
        </div>
        <button onClick={onClose} className="w-full bg-emerald-900 text-stone-50 rounded-xl py-3 font-semibold">
          Play again
        </button>
      </div>
    </div>
  );
}

function WalletView({ balanceCents, onDeposit, onWithdraw }) {
  const [amount, setAmount] = useState(100);
  return (
    <div className="p-4 space-y-4">
      <div className="bg-gradient-to-br from-emerald-800 to-emerald-950 rounded-2xl p-6">
        <div className="text-emerald-300 text-sm mb-1">Your balance</div>
        <div className="text-stone-50 text-4xl font-bold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {(balanceCents / 100).toFixed(2)} <span className="text-lg font-normal text-emerald-300">ETB</span>
        </div>
      </div>

      <input
        type="number"
        value={amount}
        onChange={(e) => setAmount(Number(e.target.value))}
        className="w-full bg-emerald-900/60 text-stone-50 rounded-xl p-3 outline-none"
        placeholder="Amount in ETB"
      />

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => onDeposit(amount)}
          className="bg-amber-400 text-emerald-950 rounded-xl py-4 flex flex-col items-center gap-1 font-semibold"
        >
          <ArrowDownToLine size={20} />
          Deposit
        </button>
        <button
          onClick={() => onWithdraw(amount)}
          className="bg-emerald-900 text-stone-50 rounded-xl py-4 flex flex-col items-center gap-1 font-semibold"
        >
          <ArrowUpFromLine size={20} />
          Withdraw
        </button>
      </div>
      <div className="bg-emerald-900/60 rounded-xl p-4 text-sm text-emerald-200">
        This deposit/withdraw is still MOCK — it credits/debits instantly on the backend for testing.
        Real Telebirr/CBE Birr integration replaces this once you have a merchant account.
      </div>
    </div>
  );
}

function HistoryView({ games }) {
  return (
    <div className="p-4 space-y-2">
      {games.length === 0 && <div className="text-emerald-400 text-sm text-center py-8">No games played yet.</div>}
      {games.map((g) => (
        <div key={g.id} className="bg-emerald-900/60 rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-stone-50 font-medium">{g.tier_key} room</div>
            <div className="text-emerald-400 text-xs">{g.winning_pattern || g.status}</div>
          </div>
          <div className="font-bold text-amber-400" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {(g.payout_cents / 100).toFixed(0)} ETB
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CartelaMiniApp() {
  const game = useGameSocket(BACKEND_URL);
  const [tab, setTab] = useState("play");
  const [lockedIn, setLockedIn] = useState(false);
  const [lockError, setLockError] = useState(null);
  const myId = myTelegramId();

  useEffect(() => {
    if (tab === "history") game.fetchHistory();
  }, [tab]);

  useEffect(() => {
    // Reset local "locked in" flag whenever we land back on the tier list
    // or start a fresh join.
    if (game.phase === "idle") setLockedIn(false);
  }, [game.phase]);

  const drawnSet = new Set(game.drawn);

  const handleLockIn = () => {
    setLockError(null);
    game.lockIn((err) => setLockError(err));
    setLockedIn(true);
  };

  const handlePlayAgain = () => {
    setLockedIn(false);
    setLockError(null);
    // useGameSocket resets phase to "idle" on room_cancelled, and to
    // "CLOSED" after a win — either way, going back to tier selection
    // just means not calling joinTier again until the user picks one.
  };

  return (
    <div className="min-h-screen bg-emerald-950 flex flex-col max-w-md mx-auto" style={{ fontFamily: "'Sora', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
      `}</style>

      {!game.connected && (
        <div className="bg-orange-500 text-emerald-950 text-center text-sm py-1 font-medium">
          Connecting to server...
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-20">
        {tab === "play" && (
          <div className="p-4 space-y-4">
            {game.phase === "idle" && <TierSelect tiers={game.tiers} onSelect={game.joinTier} />}

            {game.phase === "WAITING" && (
              <>
                <h1 className="text-stone-50 text-xl font-bold">Choose your Cartela</h1>
                <RoomMetrics playerCount={game.playerCount} potCents={game.potCents} />
                <CartelaGrid card={game.card} drawnSet={new Set()} />
                {lockError && <div className="text-orange-400 text-sm">{lockError}</div>}
                {!lockedIn ? (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={game.refreshCard}
                      className="bg-emerald-900 text-stone-50 rounded-xl py-3 flex items-center justify-center gap-2 font-semibold"
                    >
                      <RefreshCw size={18} />
                      Refresh
                    </button>
                    <button
                      onClick={handleLockIn}
                      className="bg-amber-400 text-emerald-950 rounded-xl py-3 flex items-center justify-center gap-2 font-semibold"
                    >
                      Lock in ticket
                    </button>
                  </div>
                ) : (
                  <div className="text-center text-emerald-300 text-sm py-2">
                    Ticket locked in — waiting for more players to join...
                  </div>
                )}
              </>
            )}

            {game.phase === "COUNTDOWN" && (
              <>
                <div className="flex items-center justify-between">
                  <h1 className="text-stone-50 text-xl font-bold">Get ready!</h1>
                  <div
                    className="w-14 h-14 rounded-full border-4 border-amber-400 flex items-center justify-center text-amber-400 font-bold"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {game.secondsLeft}
                  </div>
                </div>
                <RoomMetrics playerCount={game.playerCount} potCents={game.potCents} />
                <CartelaGrid card={game.card} drawnSet={new Set()} />
              </>
            )}

            {game.phase === "IN_PROGRESS" && (
              <>
                <LiveTicker drawn={game.drawn} />
                <RoomMetrics playerCount={game.playerCount} potCents={game.potCents} />
                <CartelaGrid card={game.card} drawnSet={drawnSet} />
              </>
            )}

            {game.phase === "CLOSED" && (
              <>
                <LiveTicker drawn={game.drawn} />
                <CartelaGrid card={game.card} drawnSet={drawnSet} dimmed />
              </>
            )}
          </div>
        )}

        {tab === "wallet" && (
          <WalletView balanceCents={game.balanceCents} onDeposit={game.mockDeposit} onWithdraw={game.mockWithdraw} />
        )}

        {tab === "history" && <HistoryView games={game.history} />}
      </div>

      <WinnerPopup winner={game.phase === "CLOSED" ? game.winner : null} myId={myId} onClose={handlePlayAgain} />

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
