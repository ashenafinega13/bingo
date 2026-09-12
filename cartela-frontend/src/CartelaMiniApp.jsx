import React, { useState, useEffect } from "react";
import { Wallet, History, Gamepad2, Users, Coins, RefreshCw, ArrowDownToLine, ArrowUpFromLine, X, User, Send, Share2, LifeBuoy, ChevronLeft, Menu } from "lucide-react";
import { useGameSocket } from "./useGameSocket";

// Since the backend now serves this frontend directly (see index.ts),
// they're on the same origin — connect the socket to wherever this page
// itself was loaded from, rather than a separate hardcoded URL.
const BACKEND_URL = window.location.origin;

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

function GameHeader({ drawn, playerCount, potCents }) {
  const current = drawn[drawn.length - 1];
  const previous = drawn.slice(-4, -1).reverse(); // 3 most recent calls before the current one

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

      <div className="w-full grid grid-cols-2 gap-3 pt-2 border-t border-emerald-800">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-emerald-300" />
          <div>
            <div className="text-emerald-400 text-xs">Players</div>
            <div className="text-stone-50 font-semibold text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {playerCount}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Coins size={16} className="text-amber-400" />
          <div>
            <div className="text-emerald-400 text-xs">Take-home</div>
            <div className="text-stone-50 font-semibold text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {(potCents / 100).toFixed(0)} ETB
            </div>
          </div>
        </div>
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

// Set this to your bot's real @username (no @) so the invite link and
// share button actually point at your bot instead of a placeholder.
const BOT_USERNAME = "realbingobot";

function MoreMenu({ onSelect, myId }) {
  const items = [
    { key: "profile", label: "My Account", icon: User, blurb: `Telegram ID: ${myId || "unknown"}` },
    { key: "transfer", label: "Transfer Funds", icon: Send, blurb: "Send balance to another player" },
    { key: "invite", label: "Invite Friends", icon: Share2, blurb: "Share your invite link" },
    { key: "help", label: "Help & Support", icon: LifeBuoy, blurb: "How to play, troubleshooting" },
  ];
  return (
    <div className="p-4 space-y-3">
      {items.map(({ key, label, icon: Icon, blurb }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className="w-full bg-emerald-900/60 hover:bg-emerald-900 rounded-xl p-4 flex items-center gap-3 text-left transition-colors"
        >
          <div className="bg-emerald-800 rounded-lg p-2">
            <Icon size={20} className="text-amber-400" />
          </div>
          <div>
            <div className="text-stone-50 font-semibold">{label}</div>
            <div className="text-emerald-400 text-xs">{blurb}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function BackHeader({ title, onBack }) {
  return (
    <div className="flex items-center gap-2 p-4 pb-2">
      <button onClick={onBack} className="text-emerald-300 p-1 -ml-1">
        <ChevronLeft size={22} />
      </button>
      <h2 className="text-stone-50 font-bold text-lg">{title}</h2>
    </div>
  );
}

function ProfileView({ myId, onBack }) {
  return (
    <div>
      <BackHeader title="My Account" onBack={onBack} />
      <div className="p-4 space-y-3">
        <div className="bg-emerald-900/60 rounded-xl p-4">
          <div className="text-emerald-400 text-xs mb-1">Telegram ID</div>
          <div className="text-stone-50 font-semibold" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {myId || "Not available outside Telegram"}
          </div>
        </div>
        <div className="bg-emerald-900/60 rounded-xl p-4 text-sm text-emerald-200">
          Your account was created automatically the moment you opened this Mini App through
          Telegram — no separate registration step is needed. Share your Telegram ID above with
          a friend if they want to send you a transfer.
        </div>
      </div>
    </div>
  );
}

function TransferView({ onBack, onTransfer }) {
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSend = () => {
    setError(null);
    setSuccess(false);
    const idNum = Number(toId);
    const amountNum = Number(amount);
    if (!idNum || idNum <= 0) return setError("Enter a valid Telegram ID.");
    if (!amountNum || amountNum <= 0) return setError("Enter a valid amount.");
    onTransfer(idNum, amountNum, setError, () => {
      setSuccess(true);
      setToId("");
      setAmount("");
    });
  };

  return (
    <div>
      <BackHeader title="Transfer Funds" onBack={onBack} />
      <div className="p-4 space-y-3">
        <input
          type="number"
          value={toId}
          onChange={(e) => setToId(e.target.value)}
          placeholder="Recipient's Telegram ID"
          className="w-full bg-emerald-900/60 text-stone-50 rounded-xl p-3 outline-none placeholder:text-emerald-600"
        />
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount in ETB"
          className="w-full bg-emerald-900/60 text-stone-50 rounded-xl p-3 outline-none placeholder:text-emerald-600"
        />
        {error && <div className="text-orange-400 text-sm">{error}</div>}
        {success && <div className="text-amber-400 text-sm">Transfer sent successfully!</div>}
        <button onClick={handleSend} className="w-full bg-amber-400 text-emerald-950 rounded-xl py-3 font-semibold">
          Send
        </button>
        <div className="bg-emerald-900/60 rounded-xl p-4 text-sm text-emerald-200">
          The recipient must have opened this bot at least once before you can send them funds.
        </div>
      </div>
    </div>
  );
}

function InviteView({ onBack, myId }) {
  const link = `https://t.me/${BOT_USERNAME}?start=${myId || ""}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = () => {
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Come play Cartela Bingo with me!")}`;
    if (window?.Telegram?.WebApp?.openTelegramLink) {
      window.Telegram.WebApp.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, "_blank");
    }
  };

  return (
    <div>
      <BackHeader title="Invite Friends" onBack={onBack} />
      <div className="p-4 space-y-3">
        <div className="bg-emerald-900/60 rounded-xl p-4 break-all text-emerald-200 text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {link}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={handleCopy} className="bg-emerald-900 text-stone-50 rounded-xl py-3 font-semibold">
            {copied ? "Copied!" : "Copy link"}
          </button>
          <button onClick={handleShare} className="bg-amber-400 text-emerald-950 rounded-xl py-3 font-semibold">
            Share
          </button>
        </div>
      </div>
    </div>
  );
}

function HelpView({ onBack }) {
  return (
    <div>
      <BackHeader title="Help & Support" onBack={onBack} />
      <div className="p-4 space-y-3 text-sm">
        <div className="bg-emerald-900/60 rounded-xl p-4">
          <div className="text-amber-400 font-semibold mb-1">How to play</div>
          <p className="text-emerald-200">
            Pick a room, get a Cartela, and lock in your ticket. Once at least 2 players have
            locked in, a countdown starts. Numbers are called automatically once it starts —
            complete a row, column, diagonal, or all four corners to win instantly.
          </p>
        </div>
        <div className="bg-emerald-900/60 rounded-xl p-4">
          <div className="text-amber-400 font-semibold mb-1">How cards are drawn</div>
          <p className="text-emerald-200">
            Numbers 1–75 are drawn one at a time by the server, roughly once per second, with no
            repeats until the round ends.
          </p>
        </div>
        <div className="bg-emerald-900/60 rounded-xl p-4">
          <div className="text-amber-400 font-semibold mb-1">How you win</div>
          <p className="text-emerald-200">
            The prize pool is every player's entry fee combined, minus a 10% house fee. It's paid
            out automatically the instant a winning pattern is detected.
          </p>
        </div>
        <div className="bg-emerald-900/60 rounded-xl p-4">
          <div className="text-amber-400 font-semibold mb-1">Need more help?</div>
          <p className="text-emerald-200">Contact support through this bot's chat directly.</p>
        </div>
      </div>
    </div>
  );
}

export default function CartelaMiniApp() {
  const game = useGameSocket(BACKEND_URL);
  const [tab, setTab] = useState("play");
  const [moreView, setMoreView] = useState("menu"); // menu | profile | transfer | invite | help
  const [lockedIn, setLockedIn] = useState(false);
  const [lockError, setLockError] = useState(null);
  const myId = myTelegramId();

  useEffect(() => {
    if (tab === "history") game.fetchHistory();
    if (tab === "more") setMoreView("menu"); // reset to the menu list each time More is opened
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
        <div className="bg-orange-500 text-emerald-950 text-center text-sm py-1 font-medium px-2">
          {game.connectError ? `Connection failed: ${game.connectError}` : "Connecting to server..."}
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-20">
        {tab === "play" && (
          <div className="p-4 space-y-4">
            {game.phase === "idle" && <TierSelect tiers={game.tiers} onSelect={game.joinTier} />}

            {game.phase === "WAITING" && (
              <>
                {game.spectate && (
                  <div className="space-y-2">
                    <div className="text-emerald-300 text-xs font-medium px-1">
                      Watching the current round — betting opens for the next one
                    </div>
                    <GameHeader
                      drawn={game.spectate.drawnNumbers}
                      playerCount={game.spectate.playerCount}
                      potCents={game.spectate.potCents}
                    />
                  </div>
                )}

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
                <GameHeader drawn={game.drawn} playerCount={game.playerCount} potCents={game.potCents} />
                <CartelaGrid card={game.card} drawnSet={drawnSet} />
              </>
            )}

            {game.phase === "CLOSED" && (
              <>
                <GameHeader drawn={game.drawn} playerCount={game.playerCount} potCents={game.potCents} />
                <CartelaGrid card={game.card} drawnSet={drawnSet} dimmed />
              </>
            )}
          </div>
        )}


        {tab === "wallet" && (
          <WalletView balanceCents={game.balanceCents} onDeposit={game.mockDeposit} onWithdraw={game.mockWithdraw} />
        )}

        {tab === "history" && <HistoryView games={game.history} />}

        {tab === "more" && (
          <>
            {moreView === "menu" && <MoreMenu onSelect={setMoreView} myId={myId} />}
            {moreView === "profile" && <ProfileView myId={myId} onBack={() => setMoreView("menu")} />}
            {moreView === "transfer" && <TransferView onBack={() => setMoreView("menu")} onTransfer={game.transfer} />}
            {moreView === "invite" && <InviteView myId={myId} onBack={() => setMoreView("menu")} />}
            {moreView === "help" && <HelpView onBack={() => setMoreView("menu")} />}
          </>
        )}
      </div>

      <WinnerPopup winner={game.phase === "CLOSED" ? game.winner : null} myId={myId} onClose={handlePlayAgain} />

      <div className="fixed bottom-0 inset-x-0 max-w-md mx-auto bg-emerald-900 border-t border-emerald-800 flex">
        {[
          { key: "play", label: "Play", icon: Gamepad2 },
          { key: "wallet", label: "Wallet", icon: Wallet },
          { key: "history", label: "History", icon: History },
          { key: "more", label: "More", icon: Menu },
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
