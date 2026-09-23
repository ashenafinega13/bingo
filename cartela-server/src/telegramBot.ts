/**
 * telegramBot.ts
 *
 * The classic chat-based Telegram bot (persistent keyboard menu, slash
 * commands) — separate from the Mini App, but sharing the SAME database
 * (db.ts) and the SAME TIERS config as the live game server, so a
 * balance shown here is the exact same balance shown in the Mini App.
 *
 * Run with: npm run bot   (separate terminal from the main server)
 *
 * IMPORTANT: Only ONE process can long-poll a given BOT_TOKEN at a time.
 * If you have the earlier Python bot (bot.py) running against the same
 * token, stop it before starting this one — Telegram will reject a
 * second simultaneous getUpdates connection with a 409 conflict.
 *
 * Design note on /playbingo: this command shows the available tiers and
 * hands off to the Mini App to actually play — it does NOT deduct the
 * entry fee itself. The Mini App's own lock-in flow (RoomManager.lockIn)
 * is the single place that debits a ticket purchase; having two separate
 * code paths charge the same fee would risk double-charging or the two
 * balances drifting out of sync. This keeps one source of truth for money
 * movement, which matters more here than a chat-only bingo tally.
 */

import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import * as db from "./db";
import { InsufficientBalanceError } from "./db";
import { TIERS } from "./game/RoomManager";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set. Add it to your .env file.");

// The HTTPS URL your Mini App is reachable at (your ngrok URL for testing,
// or your real deployed URL in production) — used to build the "Play"
// button and the referral link.
const MINI_APP_URL = process.env.MINI_APP_URL || "https://example.com";

const bot = new Telegraf(BOT_TOKEN);

function birr(cents: number): string {
  return `${(cents / 100).toFixed(2)} Birr`;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

const MENU_KEYBOARD = Markup.keyboard([
  ["💰 Balance", "💵 Deposit"],
  ["💸 Withdraw", "🔁 Transfer"],
  ["🎁 Invite", "📖 Instructions"],
  ["❓ Help"],
]).resize();

// ----------------------------------------------------------------------
// /start
// ----------------------------------------------------------------------
async function handleStart(ctx: any) {
  const user = ctx.from;
  const banner =
    "┏━━━━━━━━━━━━━━━━━┓\n" +
    "   🎱  C A R T E L A  🎱\n" +
    "┗━━━━━━━━━━━━━━━━━┛\n\n" +
    `Welcome, ${user.first_name}! 🎉\n\n` +
    "Live multiplayer Bingo, right here in Telegram.\n" +
    "Use the menu below to manage your wallet and jump into a game.";

  await ctx.reply(banner, MENU_KEYBOARD);

  const startPayload = ctx.startPayload; // deep-link referral code, e.g. /start ref_12345
  if (startPayload && startPayload.startsWith("ref_") && !db.userExists(user.id)) {
    ctx.session = ctx.session || {};
    (global as any).__pendingReferrals = (global as any).__pendingReferrals || {};
    (global as any).__pendingReferrals[user.id] = startPayload.replace("ref_", "");
  }
}

// ----------------------------------------------------------------------
// /register
// ----------------------------------------------------------------------
async function handleRegister(ctx: any) {
  const user = ctx.from;
  const alreadyExists = db.userExists(user.id);

  if (!alreadyExists) {
    db.ensureUser(user.id, user.username, `${user.first_name} ${user.last_name || ""}`.trim());

    const referrerId = (global as any).__pendingReferrals?.[user.id];
    if (referrerId && db.userExists(Number(referrerId))) {
      try {
        db.credit(Number(referrerId), 1000, "REFERRAL_BONUS", `ref:${user.id}`); // 10 Birr bonus
      } catch {
        /* referrer lookup failed silently — non-critical bonus, don't block registration */
      }
    }
  }

  const hasPhone = db.getPhoneNumber(user.id);
  if (hasPhone) {
    await ctx.reply("You're already registered and verified! Use 💰 Balance to check your funds.");
    return;
  }

  // Ask for their phone number via Telegram's native contact-share prompt
  // (a button that fills in their own number automatically — nothing is
  // typed by hand, and Telegram only lets a user share their OWN contact
  // this way, never someone else's). Sent as two messages rather than one
  // combined call, since mixing parse_mode with a keyboard's reply_markup
  // in a single spread risks depending on Markup's internal shape.
  if (!alreadyExists) {
    await ctx.reply(
      `✅ Registered! Your Telegram ID is \`${user.id}\` — this is what others use to send you transfers.`,
      { parse_mode: "Markdown" }
    );
  }
  await ctx.reply(
    "One last step — please share your contact to verify your account:",
    Markup.keyboard([Markup.button.contactRequest("📱 Share my contact")]).resize().oneTime()
  );
}

// ----------------------------------------------------------------------
// Contact shared (in response to the 📱 Share my contact button above)
// ----------------------------------------------------------------------
async function handleContactShared(ctx: any) {
  const contact = ctx.message.contact;
  const user = ctx.from;

  // Telegram only allows sharing the account's OWN contact via this
  // button, but double-check the id matches before trusting it, in case
  // a client ever forwards someone else's shared contact into this chat.
  if (contact.user_id && contact.user_id !== user.id) {
    await ctx.reply("That contact doesn't match your account — please use the Share my contact button instead.");
    return;
  }

  db.setPhoneNumber(user.id, contact.phone_number);
  await ctx.reply("✅ Contact verified! You're all set.", MENU_KEYBOARD);
}

// ----------------------------------------------------------------------
// /balance
// ----------------------------------------------------------------------
async function handleBalance(ctx: any) {
  const userId = ctx.from.id;
  if (!db.userExists(userId)) {
    await ctx.reply("You need an account first. Use /register.");
    return;
  }
  await ctx.reply(`💰 Your balance: *${birr(db.getBalanceCents(userId))}*`, { parse_mode: "Markdown" });
}

// ----------------------------------------------------------------------
// /deposit <amount>
// ----------------------------------------------------------------------
async function handleDeposit(ctx: any) {
  const userId = ctx.from.id;
  if (!db.userExists(userId)) {
    await ctx.reply("You need an account first. Use /register.");
    return;
  }
  const parts = (ctx.message.text as string).trim().split(/\s+/);
  const amount = Number(parts[1]);

  if (!parts[1] || isNaN(amount) || amount <= 0) {
    await ctx.reply(
      "This is a MOCK deposit for testing — real Telebirr/CBE Birr integration comes later.\n\n" +
        "Usage: `/deposit 100` to add 100 Birr.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const newBalance = db.credit(userId, toCents(amount), "DEPOSIT", "bot_mock");
  await ctx.reply(`✅ Deposited ${birr(toCents(amount))}.\nNew balance: *${birr(newBalance)}*`, {
    parse_mode: "Markdown",
  });
}

// ----------------------------------------------------------------------
// /withdraw <amount>
// ----------------------------------------------------------------------
const MIN_WITHDRAW_BIRR = 50;

async function handleWithdraw(ctx: any) {
  const userId = ctx.from.id;
  if (!db.userExists(userId)) {
    await ctx.reply("You need an account first. Use /register.");
    return;
  }
  const parts = (ctx.message.text as string).trim().split(/\s+/);
  const amount = Number(parts[1]);

  if (!parts[1] || isNaN(amount) || amount <= 0) {
    await ctx.reply(`Usage: \`/withdraw 100\` to withdraw 100 Birr (minimum ${MIN_WITHDRAW_BIRR} Birr).`, {
      parse_mode: "Markdown",
    });
    return;
  }
  if (amount < MIN_WITHDRAW_BIRR) {
    await ctx.reply(`Minimum withdrawal is ${MIN_WITHDRAW_BIRR} Birr.`);
    return;
  }

  try {
    const requestId = db.createWithdrawalRequest(userId, toCents(amount));
    await ctx.reply(
      `⏳ Withdrawal request submitted (ID \`${requestId.slice(0, 8)}\`) for ${birr(toCents(amount))}.\n` +
        `An admin will review and process it shortly — your balance is unaffected until then.`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    if (e instanceof InsufficientBalanceError) {
      await ctx.reply(`❌ ${e.message}`);
    } else {
      await ctx.reply("❌ Withdrawal request failed. Please try again.");
    }
  }
}

// ----------------------------------------------------------------------
// /transfer [UserID] [Amount]
// ----------------------------------------------------------------------
async function handleTransfer(ctx: any) {
  const userId = ctx.from.id;
  if (!db.userExists(userId)) {
    await ctx.reply("You need an account first. Use /register.");
    return;
  }

  const parts = (ctx.message.text as string).trim().split(/\s+/);
  const recipientId = Number(parts[1]);
  const amount = Number(parts[2]);

  if (!parts[1] || !parts[2] || isNaN(recipientId) || isNaN(amount) || amount <= 0) {
    await ctx.reply("Usage: `/transfer 123456789 50` — sends 50 Birr to Telegram ID 123456789.", {
      parse_mode: "Markdown",
    });
    return;
  }

  if (!db.userExists(recipientId)) {
    await ctx.reply("That Telegram ID isn't registered with this bot yet.");
    return;
  }

  try {
    const { senderNew } = db.transfer(userId, recipientId, toCents(amount));
    await ctx.reply(`✅ Sent ${birr(toCents(amount))} to \`${recipientId}\`.\nYour new balance: *${birr(senderNew)}*`, {
      parse_mode: "Markdown",
    });
    try {
      await ctx.telegram.sendMessage(
        recipientId,
        `💸 You received ${birr(toCents(amount))} from ${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name}.`
      );
    } catch {
      /* recipient may have blocked the bot — non-fatal */
    }
  } catch (e) {
    if (e instanceof InsufficientBalanceError || e instanceof Error) {
      await ctx.reply(`❌ ${e.message}`);
    }
  }
}

// ----------------------------------------------------------------------
// /invite
// ----------------------------------------------------------------------
async function handleInvite(ctx: any) {
  const userId = ctx.from.id;
  if (!db.userExists(userId)) {
    await ctx.reply("You need an account first. Use /register.");
    return;
  }
  const botUsername = ctx.botInfo?.username;
  const link = `https://t.me/${botUsername}?start=ref_${userId}`;

  await ctx.reply(
    "🎉 *Invite friends, earn bonuses!*\n\n" +
      `Share your link:\n\`${link}\`\n\n` +
      "You earn 10 Birr every time someone registers using it. Bigger crowds, bigger prize pools! 🎱",
    { parse_mode: "Markdown" }
  );
}

// ----------------------------------------------------------------------
// /instructions
// ----------------------------------------------------------------------
async function handleInstructions(ctx: any) {
  await ctx.reply(
    "*How to play Cartela Bingo* 🎱\n\n" +
      "*The card:* Each Cartela is a 5×5 grid under the letters B-I-N-G-O. " +
      "The center square is always FREE and counts as already marked.\n\n" +
      "*How numbers are drawn:* Once a room starts, the server calls a random number from 1–75 " +
      "roughly once a second. Numbers on your card get marked automatically as they're called — " +
      "no need to tap anything.\n\n" +
      "*How to win:* The moment your card completes a full row, column, diagonal, or all four corners, " +
      "you're automatically declared the winner — first to complete a pattern takes the prize pool " +
      "(minus a small house fee).\n\n" +
      "Use /playbingo to pick a room and get started!",
    { parse_mode: "Markdown" }
  );
}

// ----------------------------------------------------------------------
// /help
// ----------------------------------------------------------------------
async function handleHelp(ctx: any) {
  await ctx.reply(
    "*Need help?* 🛟\n\n" +
      "Contact support: @YourSupportUsername\n\n" +
      "*Common issues:*\n" +
      "• Deposit not showing? This is a test/mock system — deposits credit instantly, so check /balance again.\n" +
      "• Withdrawal stuck? Withdrawals are reviewed by an admin before your balance is deducted — this may take a little time.\n" +
      "• Transfer failed? Double-check the recipient's Telegram ID is correct and that they've used /register.\n" +
      "• Game not starting? A room needs at least 2 players to lock in a ticket before it begins.",
    { parse_mode: "Markdown" }
  );
}

// ----------------------------------------------------------------------
// /playbingo
// ----------------------------------------------------------------------
async function handlePlayBingo(ctx: any) {
  const userId = ctx.from.id;
  if (!db.userExists(userId)) {
    await ctx.reply("You need an account first. Use /register.");
    return;
  }

  const balance = db.getBalanceCents(userId);
  const tierButtons = Object.entries(TIERS).map(([key, info]) =>
    Markup.button.webApp(`${info.label} — entry ${birr(info.entryFeeCents)}`, MINI_APP_URL)
  );

  await ctx.reply(
    `💰 Your balance: ${birr(balance)}\n\n` +
      "Pick a room below to open the live game — you'll choose your Cartela and lock in your ticket there:",
    Markup.inlineKeyboard(tierButtons.map((b) => [b]))
  );
}

// ----------------------------------------------------------------------
// Command + persistent-keyboard wiring (both call the same handlers)
// ----------------------------------------------------------------------
bot.start(handleStart);
bot.command("register", handleRegister);
bot.on("contact", handleContactShared);
bot.command("balance", handleBalance);
bot.command("deposit", handleDeposit);
bot.command("withdraw", handleWithdraw);
bot.command("transfer", handleTransfer);
bot.command("invite", handleInvite);
bot.command("instructions", handleInstructions);
bot.command("help", handleHelp);
bot.command("playbingo", handlePlayBingo);

bot.hears("💰 Balance", handleBalance);
bot.hears("💵 Deposit", handleDeposit);
bot.hears("💸 Withdraw", handleWithdraw);
bot.hears("🔁 Transfer", (ctx) =>
  ctx.reply("Usage: `/transfer 123456789 50` — sends 50 Birr to Telegram ID 123456789.", { parse_mode: "Markdown" })
);
bot.hears("🎁 Invite", handleInvite);
bot.hears("📖 Instructions", handleInstructions);
bot.hears("❓ Help", handleHelp);

bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
});

// Registers the "/" command picker's descriptions in Telegram's own UI —
// without this, the commands above still WORK if typed manually, but
// nothing shows up when a user taps the menu icon to browse them.
bot.telegram.setMyCommands([
  { command: "start", description: "Welcome & main menu" },
  { command: "register", description: "Register for an account" },
  { command: "balance", description: "Check your wallet balance" },
  { command: "deposit", description: "Deposit funds (mock)" },
  { command: "withdraw", description: "Request a withdrawal" },
  { command: "transfer", description: "Transfer funds to another user" },
  { command: "invite", description: "Invite your friends" },
  { command: "instructions", description: "How to play" },
  { command: "help", description: "Support & troubleshooting" },
  { command: "playbingo", description: "Start playing" },
]).then(() => console.log("Command menu registered with Telegram."))
  .catch((e) => console.error("Failed to register command menu:", e));

bot.launch();
console.log("Telegram bot started (long polling)...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
