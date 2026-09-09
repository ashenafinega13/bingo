/**
 * auth.ts
 *
 * Verifies the `initData` string that Telegram injects into every Mini App
 * session (available client-side as `window.Telegram.WebApp.initData`).
 *
 * This is the ONLY way to know a request genuinely came from Telegram and
 * not from someone hitting your API directly — never trust a `telegram_id`
 * sent as a plain field in a request body without this check, or anyone
 * could claim to be any user.
 *
 * Algorithm (as documented by Telegram):
 *   1. secret_key = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)
 *   2. data_check_string = all initData fields except `hash`, sorted
 *      alphabetically by key, joined as "key=value" with "\n"
 *   3. computed_hash = HMAC_SHA256(key=secret_key, data=data_check_string), hex-encoded
 *   4. Valid if computed_hash === the `hash` field from initData
 */

import crypto from "crypto";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set. Add it to your .env file.");
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: number;
}

/**
 * Returns the verified user if initData is authentic and not expired,
 * or null if verification fails.
 */
export function verifyInitData(initData: string, maxAgeSeconds = 86400): VerifiedInitData | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computedHash !== hash) return null;

    const authDate = Number(params.get("auth_date") || "0");
    const ageSeconds = Date.now() / 1000 - authDate;
    if (ageSeconds > maxAgeSeconds) return null; // stale session, e.g. an old cached page

    const userRaw = params.get("user");
    if (!userRaw) return null;
    const user = JSON.parse(userRaw) as TelegramUser;

    return { user, authDate };
  } catch {
    return null;
  }
}
