require("dotenv").config();
const express = require("express");
const RSSParser = require("rss-parser");
const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const db = require("./db");
const security = require("./sec.middleware");
const helmet = require("helmet");
const app = express();
app.use(cors());
app.use(express.json());

// Security Middleware

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }),
);

app.use(security.logRequest);
app.use(security.requestTimeout(30000));
app.use(cors(security.corsOptions));
app.use(express.json({ limit: "1mb" })); // Limit payload size
app.use(security.rateLimitMiddleware("default"));

// Config

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL;
const RUST_BINARY = process.env.RUST_BINARY_PATH;
const POLL_INTERVAL_MS = 300000; // 5 minutes
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours post-trade
const MAX_ALERTS_PER_HOUR = 3;
const RUST_TIMEOUT_MS = 10000; // 10s
const RSS_TIMEOUT_MS = 15000; // 15s

const RSS_FEEDS = [
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://cryptonews.com/news/feed/",
  "https://bitcoinmagazine.com/.rss/full/",
];

const KEYWORDS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "Bitcoin",
  "Ethereum",
  "Solana",
  "SEC",
  "Fed",
  "ETF",
  "Trump",
  "Binance",
  "Coinbase",
  "hack",
  "crash",
  "rally",
  "liquidat",
  "pump",
  "dump",
];

// Helpers
function escapeMarkdown(text) {
  return (text || "").replace(/[_*[\]()~`>#+\-=|{}.!$]/g, "\\$&");
}

function extractKeyword(headline) {
  // Priority: specific crypto assets first
  const cryptoAssets = [
    "Bitcoin",
    "Ethereum",
    "Solana",
    "BTC",
    "ETH",
    "SOL",
    "XRP",
    "TON",
    "DOGE",
    "BNB",
    "AVAX",
    "MATIC",
  ];
  const macroKeywords = [
    "SEC",
    "Fed",
    "ETF",
    "Trump",
    "Binance",
    "Coinbase",
    "BlackRock",
    "Fidelity",
    "CLARITY",
    "MiCA",
  ];
  const actionKeywords = [
    "hack",
    "exploit",
    "crash",
    "rally",
    "liquidat",
    "pump",
    "dump",
    "surge",
    "plunge",
    "ban",
    "approve",
  ];

  for (const kw of cryptoAssets) {
    if (headline.toLowerCase().includes(kw.toLowerCase())) return kw;
  }
  for (const kw of macroKeywords) {
    if (headline.toLowerCase().includes(kw.toLowerCase())) return kw;
  }
  for (const kw of actionKeywords) {
    if (headline.toLowerCase().includes(kw.toLowerCase())) return kw;
  }

  // Fallback: extract capitalized words (likely proper nouns/tickers)
  const caps = headline.match(/\b[A-Z]{2,}\b/g);
  if (caps && caps.length > 0) return caps[0];

  return headline.split(" ").slice(0, 3).join(" ");
}

// Rate Limiting
const rateLimitMap = new Map(); //ChatId -> {count, resetTime}
const RATE_LIMIT = { requests: 30, windowMs: 60000 }; //30 requests per minute

function checkRateLimit(identifier) {
  const now = Date.now();
  const record = rateLimitMap.get(identifier);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(identifier, {
      coun: 1,
      resetTime: now + RATE_LIMIT.windowMs,
    });
    return true;
  }

  if ((record.count >= RATE_LIMIT, RATE_LIMIT.requests)) {
    return false;
  }

  record.count++;
  return true;
}

// CORS

app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "https://zero-drift-eight.vercel.app",
    ],
    credentials: true,
  }),
);

// Input Validation

function isValidPageNumber(page) {
  const num = parseInt(page, 10);
  return !isNaN(num) && num > 0 && num <= 100;
}
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    ),
  ]);
}

// State
let latestNews = [];
let latestMarkets = [];
let serverStartTime = Date.now();
let totalAlertsDispatched = 0;
let totalTradesProposed = 0;

// User State Helpers

async function getUser(chatId) {
  const numericChatId =
    typeof chatId === "string" ? parseInt(chatId, 10) : chatId;

  const result = await pool.query("SELECT * FROM users WHERE chat_id = $1", [
    numericChatId,
  ]);
  return result.rows[0] || null;
}

function isUserOnCooldown(chatId, user) {
  if (!user?.last_trade_at) return false;
  return Date.now() - new Date(user.last_trade_at).getTime() < COOLDOWN_MS;
}

function isUserRateLimited(user) {
  const now = Date.now();
  const windowStart = new Date(user.hour_window_start).getTime();
  // Reset window if an hour has passed
  if (now - windowStart > 3600000) {
    return false;
  }
  return user.alerts_this_hour >= MAX_ALERTS_PER_HOUR;
}

async function recordAlertSent(chatId) {
  const user = await db.getUser(chatId);
  const now = Date.now();
  const windowStart = new Date(user.hour_window_start).getTime();

  let newAlertCount = user.alerts_this_hour + 1;
  let newWindowStart = user.hour_window_start;

  // Reset window if an hour has passed
  if (now - windowStart > 3600000) {
    newAlertCount = 1;
    newWindowStart = new Date();
  }

  await db.updateUserAlerts(chatId, newAlertCount, newWindowStart);
  totalAlertsDispatched++;
}

async function recordTradeExecuted(chatId) {
  await db.recordTradeExecuted(chatId);
  totalTradesProposed++;
}

function cooldownRemaining(user) {
  if (!user?.last_trade_at) return 0;
  const remaining =
    COOLDOWN_MS - (Date.now() - new Date(user.last_trade_at).getTime());
  return Math.max(0, Math.ceil(remaining / 60000)); // in minutes
}

function isUserOnCooldown(chatId) {
  const user = getUser(chatId);
  if (!user.lastTradeAt) return false;
  return Date.now() - user.lastTradeAt < COOLDOWN_MS;
}

function isUserRateLimited(chatId) {
  const user = getUser(chatId);
  const now = Date.now();
  // Reset window if an hour has passed
  if (now - user.hourWindowStart > 3600000) {
    user.alertsThisHour = 0;
    user.hourWindowStart = now;
  }
  return user.alertsThisHour >= MAX_ALERTS_PER_HOUR;
}

function recordAlertSent(chatId) {
  const user = getUser(chatId);
  user.alertsThisHour++;
  totalAlertsDispatched++;
}

function recordTradeExecuted(chatId) {
  const user = getUser(chatId);
  user.lastTradeAt = Date.now();
  totalTradesProposed++;
}

function cooldownRemaining(chatId) {
  const user = getUser(chatId);
  if (!user.lastTradeAt) return 0;
  const remaining = COOLDOWN_MS - (Date.now() - user.lastTradeAt);
  return Math.max(0, Math.ceil(remaining / 60000)); // in minutes
}

function sendSafeError(chatId, context = "operation") {
  bot.sendMessage(
    chatId,
    `❌ Error during ${context}. Please try again later.`,
  );
}

// Telegram Bot

const bot = TELEGRAM_TOKEN
  ? new TelegramBot(TELEGRAM_TOKEN, {
      polling: { autoStart: false }, // Don't auto-start
    })
  : null;

if (bot) {
  // Stop any existing polling before starting new one
  bot
    .stopPolling()
    .then(() => {
      bot.startPolling();
      console.log("[ZeroDrift] Telegram bot polling started");
    })
    .catch((err) => {
      console.warn(
        "[ZeroDrift] Polling stop warning (expected on cold start):",
        err.message,
      );
      bot.startPolling();
    });

  bot.on("polling_error", (err) => {
    if (err.code === "ETELEGRAM") {
      console.error("[ZeroDrift] Telegram conflict — another instance running");
    } else {
      console.error("[ZeroDrift] Telegram polling error:", err.code);
    }
  });
} else {
  console.warn("[ZeroDrift] TELEGRAM_TOKEN not set — bot disabled");
}

// Rust bridge

function runRust(args) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const proc = spawn(RUST_BINARY, args);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", () => {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(`Rust parse error: ${stderr || stdout}`));
        }
      });
      proc.on("error", (err) =>
        reject(new Error(`Spawn failed: ${err.message}`)),
      );
    }),
    RUST_TIMEOUT_MS,
  );
}

// RSS MONITOR

const rssParser = new RSSParser({ timeout: RSS_TIMEOUT_MS });

async function pollRSS() {
  try {
    const isFirstLoad = latestNews.length === 0;

    const feedResults = await Promise.allSettled(
      RSS_FEEDS.map((url) =>
        withTimeout(rssParser.parseURL(url), RSS_TIMEOUT_MS),
      ),
    );

    const successCount = feedResults.filter(
      (r) => r.status === "fulfilled",
    ).length;
    const allItems = feedResults
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value.items);

    const newItems = [];
    for (const item of allItems) {
      const key = item.title?.trim();
      if (!key) continue;
      const exists = await db.hasHeadline(key);
      if (exists) continue;
      await db.addHeadline(key, item.link, item.pubDate);
      newItems.push(item);
    }

    for (const item of newItems) {
      const newsTimestamp = new Date(item.pubDate || Date.now()).getTime();
      latestNews.unshift({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        timestamp: newsTimestamp,
      });
      if (isFirstLoad) continue;
      // Only alert on news published after server start
      if (newsTimestamp < serverStartTime) continue;

      console.log(`[ZeroDrift] 📰 ${item.title.slice(0, 60)}...`);

      const keyword = extractKeyword(item.title);
      try {
        const markets = await runRust(["search", "--keyword", keyword]);
        // Filter out non-crypto markets (sports, politics unrelated to crypto)
        const cryptoMarkets = markets.markets.filter((m) => {
          const t = (m.title || m.slug).toLowerCase();
          return (
            t.includes("btc") ||
            t.includes("eth") ||
            t.includes("sol") ||
            t.includes("bitcoin") ||
            t.includes("ethereum") ||
            t.includes("solana") ||
            t.includes("crypto") ||
            t.includes("up or down") ||
            t.includes("price") ||
            t.includes("ton") ||
            t.includes("xrp") ||
            t.includes("bnb")
          );
        });
        if (cryptoMarkets.length > 0) {
          const topMarket = cryptoMarkets[0];
          const alert = `🚨 *Breaking Alpha*\n\n📰 ${escapeMarkdown(item.title)}\n🔗 ${item.link || ""}\n\n🎯 *Related Market:* ${escapeMarkdown(topMarket.title || topMarket.slug)}\n\n_ZeroDrift detected this opportunity — tap to trade before the market moves_`;
          broadcastAlert(alert, newsTimestamp, topMarket.slug, item.link);
          latestMarkets = markets.markets;
        }
      } catch (e) {
        console.error("[ZeroDrift] Market search error:", e.message);
      }
    }

    latestNews = [
      ...new Map(latestNews.map((n) => [n.title, n])).values(),
    ].slice(0, 50);

    if (newItems.length > 0) {
      const headlineCount = await db.getHeadlineCount();
      console.log(
        `[ZeroDrift] +${newItems.length} headlines | ${successCount}/${RSS_FEEDS.length} feeds OK | total seen: ${headlineCount}`,
      );
    } else {
      const headlineCount = await db.getHeadlineCount();
      console.log(
        `[ZeroDrift] ✓ Watching ${headlineCount} headlines across ${successCount}/${RSS_FEEDS.length} feeds`,
      );
    }
  } catch (e) {
    console.error("[ZeroDrift] RSS poll error:", e.message);
  }
}

// Broadcast alert to all subscribers

async function broadcastAlert(alert, newsTimestamp, slug, newsLink) {
  if (!bot) return;

  const subscribers = await db.getAllSubscribers();
  const ob = await runRust(["orderbook", "--slug", slug]).catch(() => null);

  for (const chatId of subscribers) {
    const user = await db.getUser(chatId);
    if (new Date(user.subscribed_at).getTime() > newsTimestamp) continue;
    if (isUserOnCooldown(chatId, user)) continue;
    if (isUserRateLimited(user)) continue;

    await recordAlertSent(chatId);

    const yesPrice = ob?.yes_price;
    const noPrice = ob?.no_price;
    const betterSide =
      yesPrice && noPrice ? (yesPrice >= noPrice ? "YES" : "NO") : "YES";
    const betterPct =
      betterSide === "YES"
        ? (yesPrice * 100).toFixed(0)
        : (noPrice * 100).toFixed(0);
    const buttonLabel = `⚡ Trade ${betterSide} @ ${betterPct}%`;

    bot
      .sendMessage(chatId, alert, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: buttonLabel,
                web_app: {
                  url: `${FRONTEND_URL}/?slug=${slug}&side=${betterSide}`,
                },
              },
              {
                text: "📊 View on Limitless",
                url: `https://limitless.exchange/markets/${slug}`,
              },
            ],
            ...(newsLink
              ? [[{ text: "📰 Read Full Story", url: newsLink }]]
              : []),
          ],
        },
      })
      .catch(() => {});
  }
}

// Bot Commands

if (bot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      let user = await db.getUser(chatId);
      if (!user) {
        user = await db.createUser(chatId);
      }

      bot.sendMessage(
        chatId,
        `⚡ *ZeroDrift Online*\n\nAutonomous Limitless alpha catalyst\\.

I monitor breaking crypto news across 4 sources and instantly surface related prediction markets before the crowd reacts\\.

*Commands:*
/markets \\- Live opportunities
/news \\- Latest headlines  
/alphas \\- On\\-demand alpha opportunities
/positions \\- Your trade history
/trade \\<slug\\> \\<YES\\|NO\\> \\<amount\\> \\- Trade proposal
/status \\- Your account status
/stop \\- Unsubscribe

_Alerts: max ${MAX_ALERTS_PER_HOUR}/hour\\. Auto\\-quiet for 2h after executing a trade\\._`,
        { parse_mode: "MarkdownV2" },
      );
    } catch (e) {
      console.error("[ZeroDrift] Start command error:", e.message);
      sendSafeError(chatId, "Initialization");
    }
  });

  bot.onText(/\/stop/, async (msg) => {
    await db.deleteUser(msg.chat.id);
    bot.sendMessage(
      msg.chat.id,
      "👋 Unsubscribed from ZeroDrift alerts.\n\nYou can still use /markets, /trade, /alphas and /news manually.\n\nSend /start to resubscribe to automatic alerts.",
    );
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      let user = await db.getUser(chatId);
      if (!user) {
        user = await db.createUser(chatId);
      }
      function isUserOnCooldown(chatId, user) {
        if (!user?.last_trade_at) return false;
        return (
          Date.now() - new Date(user.last_trade_at).getTime() < COOLDOWN_MS
        );
      }

      function cooldownRemaining(user) {
        if (!user?.last_trade_at) return 0;
        const remaining =
          COOLDOWN_MS - (Date.now() - new Date(user.last_trade_at).getTime());
        return Math.max(0, Math.ceil(remaining / 60000));
      }
      const remaining = cooldownRemaining(user);
      const headlineCount = await db.getHeadlineCount();

      const lines = [
        `⚡ *ZeroDrift Status*`,
        ``,
        `📡 Subscribed: ✅`,
        `🔔 Alerts sent this hour: ${user.alerts_this_hour || 0}/${MAX_ALERTS_PER_HOUR}`,
        `🧊 Cooldown: ${isUserOnCooldown(chatId, user) ? `Active \\(${remaining} min remaining\\)` : "None"}`,
        `📰 Headlines watched: ${headlineCount}`,
        `🎯 Markets tracked: ${latestMarkets.length}`,
      ];

      bot
        .sendMessage(chatId, lines.join("\n"), { parse_mode: "MarkdownV2" })
        .catch(() => {
          bot.sendMessage(
            chatId,
            `Status: ${user.alerts_this_hour || 0}/${MAX_ALERTS_PER_HOUR} alerts | Cooldown: ${isUserOnCooldown(chatId, user) ? remaining + "min" : "none"}`,
          );
        });
    } catch (e) {
      console.error("[ZeroDrift] Status command error:", e.message);
      sendSafeError(chatId, "Status check");
    }
  });

  bot.onText(/\/markets/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Scanning Limitless...");
    try {
      const results = await Promise.all([
        runRust(["search", "--keyword", "BTC"]),
        runRust(["search", "--keyword", "ETH"]),
        runRust(["search", "--keyword", "SOL"]),
      ]);
      const seen = new Set();
      const allMarkets = results
        .flatMap((r) => r.markets || [])
        .filter((m) => {
          if (seen.has(m.slug)) return false;
          seen.add(m.slug);
          return true;
        });

      // Fetch orderbook to check status
      const withStatus = await Promise.allSettled(
        allMarkets.map(async (m) => {
          const ob = await runRust(["orderbook", "--slug", m.slug]);
          return { ...m, status: ob.status, yes_price: ob.yes_price };
        }),
      );

      const funded = withStatus
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((m) => m.status === "FUNDED")
        .slice(0, 5);

      if (funded.length === 0) {
        bot.sendMessage(chatId, "📭 No active funded markets right now.");
        return;
      }

      const lines = funded
        .map(
          (m, i) =>
            `${i + 1}. *${m.title || m.slug}*\n   \`${m.slug}\`${m.yes_price ? ` — YES: ${(m.yes_price * 100).toFixed(0)}%` : ""}`,
        )
        .join("\n\n");

      bot.sendMessage(
        chatId,
        `🎯 *Active Funded Markets*\n\n${lines}\n\nUse: /trade <slug> YES 10`,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      sendSafeError(chatId, "Funded markets lookup");
    }
  });

  bot.onText(/\/news/, async (msg) => {
    if (latestNews.length === 0) {
      bot.sendMessage(
        msg.chat.id,
        "📭 No news cached yet. Check back in a few minutes.",
      );
      return;
    }
    const lines = latestNews
      .slice(0, 5)
      .map((n, i) => `${i + 1}. ${n.title}\n   🔗 ${n.link}`)
      .join("\n\n");
    bot.sendMessage(msg.chat.id, `📰 *Latest Crypto News*\n\n${lines}`, {
      parse_mode: "Markdown",
    });
  });

  bot.onText(/\/alphas(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const pageStr = match[1] || "1";

    // Rate limit check
    const rateLimit = security.checkRateLimit(chatId, "default");
    if (!rateLimit.allowed) {
      bot
        .sendMessage(
          chatId,
          `⏳ Too many requests. Wait ${rateLimit.retryAfter}s.`,
        )
        .catch(() => {});
      return;
    }

    if (!security.isValidPageNumber(pageStr)) {
      bot
        .sendMessage(chatId, "❌ Invalid page. Use: /alphas or /alphas 2")
        .catch(() => {});
      return;
    }

    const page = parseInt(pageStr, 10);
    const pageSize = 5;

    try {
      const keywords = ["BTC", "ETH", "SOL", "XRP", "Trump", "ETF", "SEC"];
      const results = await Promise.allSettled(
        keywords.map((kw) => runRust(["search", "--keyword", kw])),
      );

      const seen = new Set();
      const allMarkets = results
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => r.value.markets || [])
        .filter((m) => {
          const t = (m.title || m.slug).toLowerCase();
          if (seen.has(m.slug)) return false;
          seen.add(m.slug);
          return (
            t.includes("up or down") ||
            t.includes("price") ||
            t.includes("btc") ||
            t.includes("eth") ||
            t.includes("sol") ||
            t.includes("xrp") ||
            t.includes("trump") ||
            t.includes("etf") ||
            t.includes("bitcoin") ||
            t.includes("ethereum") ||
            t.includes("crypto")
          );
        });

      if (allMarkets.length === 0) {
        bot.sendMessage(chatId, "📭 No markets found.").catch(() => {});
        return;
      }

      const withPrices = await Promise.allSettled(
        allMarkets.map(async (m) => {
          const ob = await runRust(["orderbook", "--slug", m.slug]);
          return {
            ...m,
            yes_price: ob.yes_price,
            no_price: ob.no_price,
            status: ob.status,
          };
        }),
      );

      const live = withPrices
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((m) => m.yes_price && m.no_price && m.status === "FUNDED")
        .sort(
          (a, b) => Math.abs(0.5 - a.yes_price) - Math.abs(0.5 - b.yes_price),
        )
        .slice(0, 100);

      if (live.length === 0) {
        bot.sendMessage(chatId, "📭 No funded markets.").catch(() => {});
        return;
      }

      const totalPages = Math.ceil(live.length / pageSize);
      if (page > totalPages) {
        bot
          .sendMessage(
            chatId,
            `❌ Page ${page} doesn't exist. Max: ${totalPages}`,
          )
          .catch(() => {});
        return;
      }

      const start = (page - 1) * pageSize;
      const pageMarkets = live.slice(start, start + pageSize);

      // Helper to escape MarkdownV2 special characters
      function escapeMarkdownV2(text) {
        return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
      }

      // Build full message with all markets on page
      let messageText = `🎯 *Alpha Opportunities* \\- Page ${page}/${totalPages}\n\n`;

      for (let i = 0; i < pageMarkets.length; i++) {
        const m = pageMarkets[i];
        const yesBar = Math.round(m.yes_price * 10);
        const noBar = 10 - yesBar;
        const bar = "🟢".repeat(yesBar) + "🔴".repeat(noBar);

        messageText += `${i + 1}\\. *${escapeMarkdownV2(m.title || m.slug)}*\n`;
        messageText += `${bar}\n`;
        messageText += `📈 YES: *${(m.yes_price * 100).toFixed(1)}%* \\| 📉 NO: *${(m.no_price * 100).toFixed(1)}%*\n\n`;
      }

      // Build navigation buttons
      const navButtons = [];
      if (page > 1)
        navButtons.push({
          text: "⬅️ Previous",
          callback_data: `alphas_${page - 1}`,
        });
      navButtons.push({ text: `${page}/${totalPages}`, callback_data: "noop" });
      if (page < totalPages)
        navButtons.push({
          text: "➡️ Next",
          callback_data: `alphas_${page + 1}`,
        });

      const replyMarkup = {
        inline_keyboard: [
          navButtons,
          pageMarkets.map((m, i) => ({
            text: `Trade #${i + 1}`,
            web_app: {
              url: `${FRONTEND_URL}/?slug=${m.slug}&side=${m.yes_price >= m.no_price ? "YES" : "NO"}`,
            },
          })),
        ],
      };

      bot
        .sendMessage(chatId, messageText, {
          parse_mode: "HTML", // Use HTML instead of MarkdownV2
          reply_markup: replyMarkup,
        })
        .catch((err) => {
          console.error("[ZeroDrift] Alphas message error:", err.message);
          sendSafeError(chatId, "Alpha scan");
        });
    } catch (e) {
      console.error("[ZeroDrift] Alphas command error:", e.message);
      sendSafeError(chatId, "Alpha scan");
    }
  });

  bot.onText(/\/positions/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Fetching your position history...");

    try {
      const trades = await db.getTradesByChatId(chatId, 20);

      if (trades.length === 0) {
        bot.sendMessage(
          chatId,
          "📭 No executed trades yet.\n\nExecute a trade to see your positions here.",
        );
        return;
      }

      // Calculate P&L for each trade (simple: amount * (current_price - entry_price))
      // For now, show basic info
      let message = `📊 *Your Positions*\n\n`;

      trades.forEach((trade, i) => {
        const pnl = (
          trade.estimated_shares * trade.estimated_price -
          trade.amount_usdc
        ).toFixed(2);
        const pnlColor = pnl >= 0 ? "📈" : "📉";

        message += `${i + 1}. *${trade.market_title || trade.market_slug}*\n`;
        message += `   Side: ${trade.side}\n`;
        message += `   Amount: $${parseFloat(trade.amount_usdc).toFixed(2)} USDC\n`;
        message += `   Shares: ${parseFloat(trade.estimated_shares).toFixed(4)}\n`;
        message += `   Entry: $${parseFloat(trade.estimated_price).toFixed(4)}\n`;
        message += `   Status: ${trade.status}\n`;
        message += `   ${pnlColor} P&L: $${pnl}\n`;
        message += `   Executed: ${new Date(trade.executed_at).toLocaleString()}\n`;

        if (trade.tx_hash) {
          message += `   🔗 TX: \`${trade.tx_hash.slice(0, 10)}...\`\n`;
        }
        message += `\n`;
      });

      message += `_Showing last ${trades.length} trades_`;

      bot.sendMessage(chatId, message, { parse_mode: "Markdown" }).catch(() => {
        // Fallback if markdown fails
        const simple = trades
          .map(
            (t, i) =>
              `${i + 1}. ${t.market_title} | ${t.side} | $${t.amount_usdc} | ${t.status}`,
          )
          .join("\n");
        bot.sendMessage(chatId, `Your Positions:\n\n${simple}`);
      });
    } catch (e) {
      sendSafeError(chatId, "Position history fetch");
    }
  });

  bot.onText(/\/trade (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].trim().split(/\s+/);

    if (parts.length < 3) {
      bot.sendMessage(
        chatId,
        "⚠️ Usage: /trade <slug> <YES|NO> <amount>\n\nExample:\n/trade btc-up-or-down-daily YES 10",
      );
      return;
    }

    const [slug, side, amount] = parts;
    if (!["YES", "NO", "yes", "no"].includes(side)) {
      bot.sendMessage(chatId, "⚠️ Side must be YES or NO");
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      bot.sendMessage(chatId, "⚠️ Amount must be a positive number");
      return;
    }

    console.log(`[ZeroDrift] Trade request: ${slug} ${side} $${amount}`);
    bot.sendMessage(chatId, "⏳ Generating trade proposal...");

    try {
      const result = await runRust([
        "trade",
        "--slug",
        slug,
        "--side",
        side.toUpperCase(),
        "--amount",
        amount,
      ]);
      const hasPrice = result.estimated_price && result.estimated_shares;
      const marketLabel = result.slug
        .split("-")
        .slice(0, 5)
        .join(" ")
        .toUpperCase();
      const reply = `📊 *Trade Proposal*\n\n🎯 *${marketLabel}*\n\n💰 Side: ${result.side}\n💵 Amount: $${result.amount_usdc} USDC\n📈 Price: ${hasPrice ? "$" + result.estimated_price.toFixed(3) : "N/A"}\n🎰 Shares: ${hasPrice ? result.estimated_shares.toFixed(2) : "N/A"}\n\n_Review and execute on ZeroDrift_`;
      bot
        .sendMessage(chatId, reply, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⚡ Execute on ZeroDrift",
                  web_app: {
                    url: `${FRONTEND_URL}/?slug=${slug}&side=${side.toUpperCase()}`,
                  },
                },
                {
                  text: "📊 View on Limitless",
                  url: `https://limitless.exchange/markets/${slug}`,
                },
              ],
            ],
          },
        })
        .catch((err) => {
          console.error("[ZeroDrift] Trade message error:", err.message);
          bot.sendMessage(chatId, `❌ Failed to send proposal: ${err.message}`);
        });
    } catch (e) {
      sendSafeError(chatId, "Trade proposal generation");
    }
  });

  console.log("[ZeroDrift] Telegram bot active");
}

// Callback Query Handler for Inline Buttons

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    // Acknowledge the button click
    bot.answerCallbackQuery(query.id).catch(() => {});

    // Handle alphas pagination
    if (data.startsWith("alphas_")) {
      const pageStr = data.split("_")[1];

      if (!security.isValidPageNumber(pageStr)) {
        bot.sendMessage(chatId, "❌ Invalid page.").catch(() => {});
        return;
      }

      const page = parseInt(pageStr, 10);
      const pageSize = 5;

      const keywords = ["BTC", "ETH", "SOL", "XRP", "Trump", "ETF", "SEC"];
      const results = await Promise.allSettled(
        keywords.map((kw) => runRust(["search", "--keyword", kw])),
      );

      const seen = new Set();
      const allMarkets = results
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => r.value.markets || [])
        .filter((m) => {
          const t = (m.title || m.slug).toLowerCase();
          if (seen.has(m.slug)) return false;
          seen.add(m.slug);
          return (
            t.includes("up or down") ||
            t.includes("price") ||
            t.includes("btc") ||
            t.includes("eth") ||
            t.includes("sol") ||
            t.includes("xrp") ||
            t.includes("trump") ||
            t.includes("etf") ||
            t.includes("bitcoin") ||
            t.includes("ethereum") ||
            t.includes("crypto")
          );
        });

      if (allMarkets.length === 0) {
        bot.sendMessage(chatId, "📭 No markets found.").catch(() => {});
        return;
      }

      const withPrices = await Promise.allSettled(
        allMarkets.map(async (m) => {
          const ob = await runRust(["orderbook", "--slug", m.slug]);
          return {
            ...m,
            yes_price: ob.yes_price,
            no_price: ob.no_price,
            status: ob.status,
          };
        }),
      );

      const live = withPrices
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((m) => m.yes_price && m.no_price && m.status === "FUNDED")
        .sort(
          (a, b) => Math.abs(0.5 - a.yes_price) - Math.abs(0.5 - b.yes_price),
        )
        .slice(0, 100);

      if (live.length === 0) {
        bot.sendMessage(chatId, "📭 No funded markets.").catch(() => {});
        return;
      }

      const totalPages = Math.ceil(live.length / pageSize);
      if (page > totalPages) {
        bot
          .sendMessage(
            chatId,
            `❌ Page ${page} doesn't exist. Max: ${totalPages}`,
          )
          .catch(() => {});
        return;
      }

      const start = (page - 1) * pageSize;
      const pageMarkets = live.slice(start, start + pageSize);

      // Helper to escape MarkdownV2 special characters
      function escapeMarkdownV2(text) {
        return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
      }

      // Build full message with all markets on page
      let messageText = `🎯 *Alpha Opportunities* \\- Page ${page}/${totalPages}\n\n`;

      for (let i = 0; i < pageMarkets.length; i++) {
        const m = pageMarkets[i];
        const yesBar = Math.round(m.yes_price * 10);
        const noBar = 10 - yesBar;
        const bar = "🟢".repeat(yesBar) + "🔴".repeat(noBar);

        messageText += `${i + 1}\\. *${escapeMarkdownV2(m.title || m.slug)}*\n`;
        messageText += `${bar}\n`;
        messageText += `📈 YES: *${(m.yes_price * 100).toFixed(1)}%* \\| 📉 NO: *${(m.no_price * 100).toFixed(1)}%*\n\n`;
      }

      // Build navigation buttons
      const navButtons = [];
      if (page > 1)
        navButtons.push({
          text: "⬅️ Previous",
          callback_data: `alphas_${page - 1}`,
        });
      navButtons.push({ text: `${page}/${totalPages}`, callback_data: "noop" });
      if (page < totalPages)
        navButtons.push({
          text: "➡️ Next",
          callback_data: `alphas_${page + 1}`,
        });

      const replyMarkup = {
        inline_keyboard: [
          navButtons,
          pageMarkets.map((m, i) => ({
            text: `Trade #${i + 1}`,
            web_app: {
              url: `${FRONTEND_URL}/?slug=${m.slug}&side=${m.yes_price >= m.no_price ? "YES" : "NO"}`,
            },
          })),
        ],
      };

      bot
        .sendMessage(chatId, messageText, {
          parse_mode: "MarkdownV2",
          reply_markup: replyMarkup,
        })
        .catch((err) => {
          console.error("[ZeroDrift] Callback alphas error:", err.message);
          bot
            .answerCallbackQuery(query.id, {
              text: "❌ Error loading page",
              show_alert: false,
            })
            .catch(() => {});
        });
    }
  } catch (err) {
    console.error("[ZeroDrift] Callback query error:", err.message);
    bot
      .answerCallbackQuery(query.id, {
        text: "❌ Error processing request",
        show_alert: true,
      })
      .catch(() => {});
  }
});

// REST API

app.get("/api/news", (req, res) => {
  res.json({ success: true, news: latestNews });
});

app.get(
  "/api/markets/search",
  security.rateLimitMiddleware("api"),
  async (req, res) => {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ error: "keyword required" });
    try {
      const sanitized = security.sanitizeInput(keyword);
      const result = await runRust(["search", "--keyword", sanitized]);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
);

app.get(
  "/api/markets/orderbook",
  security.rateLimitMiddleware("api"),
  async (req, res) => {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: "slug required" });
    if (!security.isValidSlug(slug)) {
      return res.status(400).json({ error: "Invalid market slug" });
    }

    try {
      const result = await runRust(["orderbook", "--slug", slug]);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  },
);

app.post(
  "/api/trade/propose",
  security.rateLimitMiddleware("api"),
  async (req, res) => {
    const { slug, side, amount } = req.body;

    if (!slug || !security.isValidSlug(slug)) {
      return res.status(400).json({ error: "Invalid market slug" });
    }
    if (!security.isValidSide(side)) {
      return res.status(400).json({ error: "Side must be YES or NO" });
    }
    if (!security.isValidAmount(amount)) {
      return res.status(400).json({ error: "Invalid amount (max $10,000)" });
    }

    try {
      const result = await runRust([
        "trade",
        "--slug",
        slug,
        "--side",
        side.toString(),
        "--amount",
        amount.toString(),
      ]);
      res.json(result);
    } catch (e) {
      res.status(500).json({
        success: false,
        error: "Trade Proposal failed",
        details: e.message,
      });
    }
  },
);

// Called from frontend after wallet execution
app.post(
  "/api/trade/executed",
  security.rateLimitMiddleware("trade"),
  async (req, res) => {
    const {
      chatId,
      walletAddress,
      marketSlug,
      marketTitle,
      side,
      amount,
      estimatedPrice,
      estimatedShares,
      txHash,
    } = req.body;

    if (!chatId || !security.isValidChatId(chatId)) {
      return res.status(400).json({ error: "Invalid chatId" });
    }
    if (walletAddress && !security.isValidWalletAddress(walletAddress)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    if (marketSlug && !security.isValidSlug(marketSlug)) {
      return res.status(400).json({ error: "Invalid market slug" });
    }
    if (side && !security.isValidSide(side)) {
      return res.status(400).json({ error: "Invalid side" });
    }
    if (amount && !security.isValidAmount(amount)) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const numericChatId =
      typeof chatId === "string" ? parseInt(chatId, 10) : chatId;

    try {
      await recordTradeExecuted(numericChatId);

      if (walletAddress && marketSlug && amount) {
        await db.recordTrade(
          numericChatId,
          walletAddress,
          marketSlug,
          marketTitle || "",
          security.sanitizeInput(marketTitle || ""),
          side || "YES",
          parseFloat(amount),
          parseFloat(estimatedPrice) || 0,
          parseFloat(estimatedShares) || 0,
          txHash || null,
        );
        console.log(
          `[ZeroDrift] Trade recorded for ${numericChatId}: ${marketSlug} ${side} $${amount}`,
        );
      }

      const user = await db.getUser(numericChatId);
      const remaining = cooldownRemaining(user);
      console.log(
        `[ZeroDrift] Trade executed for ${numericChatId} — cooldown ${remaining}min`,
      );

      if (bot) {
        bot
          .sendMessage(
            numericChatId,
            `✅ *Trade Executed*\n\nZeroDrift is now in cooldown mode for 2 hours\\.\n\nYour alerts are paused — go touch grass 🌿`,
            { parse_mode: "MarkdownV2" },
          )
          .catch(() => {});
      }
    } catch (err) {
      console.error("[ZeroDrift] Trade execution error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }

    res.json({ success: true });
  },
);

app.post("/api/test-alpha", async (req, res) => {
  try {
    // Fetch real latest headline from CoinTelegraph
    let realHeadline = null;
    let realLink = null;

    // Always prefer explicitly provided headline
    if (req.body.headline) {
      realHeadline = req.body.headline;
    } else if (latestNews.length > 0) {
      const recent = latestNews[0];
      realHeadline = recent.title;
      realLink = recent.link;
    } else {
      // Fallback: fetch fresh from RSS right now
      try {
        const feed = await withTimeout(
          rssParser.parseURL("https://cointelegraph.com/rss"),
          RSS_TIMEOUT_MS,
        );
        if (feed.items.length > 0) {
          realHeadline = feed.items[0].title;
          realLink = feed.items[0].link;
        }
      } catch {}
    }

    // Final fallback
    if (!realHeadline) {
      realHeadline =
        req.body.headline ||
        "Bitcoin breaks $100K as ETF inflows surge to record highs";
    }

    console.log(`[ZeroDrift] Test alpha using: "${realHeadline}"`);

    const keyword = extractKeyword(realHeadline);
    console.log(`[ZeroDrift] Extracted keyword: ${keyword}`);

    const markets = await runRust(["search", "--keyword", keyword]);

    // Filter to crypto only funded markets
    const cryptoMarkets = (markets.markets || []).filter((m) => {
      const t = (m.title || m.slug).toLowerCase();
      return (
        t.includes("up or down") ||
        t.includes("price") ||
        t.includes("btc") ||
        t.includes("eth") ||
        t.includes("sol") ||
        t.includes("bitcoin") ||
        t.includes("ethereum") ||
        t.includes("crypto") ||
        t.includes("xrp") ||
        t.includes("ton")
      );
    });

    if (cryptoMarkets.length === 0) {
      // Fallback to BTC daily if no match
      const fallback = await runRust(["search", "--keyword", "BTC"]);
      const btcMarket = (fallback.markets || [])[0];
      if (!btcMarket) {
        return res.json({
          success: false,
          message: "No markets found",
          headline: realHeadline,
        });
      }
      cryptoMarkets.push(btcMarket);
    }

    // Find first FUNDED market with live pricing
    let topMarket = null;
    let ob = null;

    for (const m of cryptoMarkets) {
      const orderbook = await runRust(["orderbook", "--slug", m.slug]).catch(
        () => null,
      );
      if (orderbook && orderbook.status === "FUNDED" && orderbook.yes_price) {
        topMarket = m;
        ob = orderbook;
        break;
      }
    }

    // If none funded in keyword results, search BTC directly
    if (!topMarket) {
      const btcResults = await runRust(["search", "--keyword", "BTC"]);
      for (const m of btcResults.markets || []) {
        const orderbook = await runRust(["orderbook", "--slug", m.slug]).catch(
          () => null,
        );
        if (orderbook && orderbook.status === "FUNDED" && orderbook.yes_price) {
          topMarket = m;
          ob = orderbook;
          break;
        }
      }
    }

    if (!topMarket) {
      return res.json({
        success: false,
        message: "No funded markets found right now",
        headline: realHeadline,
      });
    }

    const yesPrice = ob?.yes_price;
    const noPrice = ob?.no_price;
    const betterSide =
      yesPrice && noPrice ? (yesPrice >= noPrice ? "YES" : "NO") : "YES";
    const betterPct =
      betterSide === "YES"
        ? (yesPrice * 100).toFixed(0)
        : (noPrice * 100).toFixed(0);

    const alert = `🚨 *Breaking Alpha*\n\n📰 ${escapeMarkdown(realHeadline)}${realLink ? "\n🔗 " + realLink : ""}\n\n🎯 *Related Market:* ${escapeMarkdown(topMarket.title || topMarket.slug)}\n📊 *Odds:* YES ${yesPrice ? (yesPrice * 100).toFixed(1) + "%" : "N/A"} | NO ${noPrice ? (noPrice * 100).toFixed(1) + "%" : "N/A"}\n\n_ZeroDrift detected this opportunity automatically_`;

    // Broadcast to all subscribed users
    userState.forEach((state, chatId) => {
      bot
        .sendMessage(chatId, alert, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `⚡ Trade ${betterSide} @ ${betterPct}%`,
                  web_app: {
                    url: `${FRONTEND_URL}/?slug=${topMarket.slug}&side=${betterSide}`,
                  },
                },
                {
                  text: "📊 View on Limitless",
                  url: `https://limitless.exchange/markets/${topMarket.slug}`,
                },
              ],
              ...(realLink
                ? [[{ text: "📰 Read Full Story", url: realLink }]]
                : []),
            ],
          },
        })
        .catch(() => {});
    });

    res.json({
      success: true,
      headline: realHeadline,
      keyword,
      market: topMarket.slug,
      marketTitle: topMarket.title,
      odds: { yes: yesPrice, no: noPrice },
      side: betterSide,
      subscribers: userState.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status", async (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  try {
    const headlineCount = await db.getHeadlineCount();

    res.json({
      success: true,
      status: "online",
      uptime: `${Math.floor(uptime / 60)}m ${uptime % 60}s`,
      newsCount: latestNews.length,
      marketsCount: latestMarkets.length,
      headlinesSeen: headlineCount,
      feedCount: RSS_FEEDS.length,
      telegramActive: !!bot,
      totalAlertsDispatched,
      totalTradesProposed,
    });
  } catch (error) {
    console.error("[ZeroDrift] Status API error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to retrieve status" });
  }
});

app.get("/api/health", async (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  const rssMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const maxMemory = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);

  try {
    const headlineCount = await db.getHeadlineCount();

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime_seconds: uptime,
      uptime_formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory: {
        used_mb: rssMemory,
        total_mb: maxMemory,
        percent: Math.round((rssMemory / maxMemory) * 100),
      },
      services: {
        telegram_bot: !!bot,
        rss_feeds: RSS_FEEDS.length,
        seen_headlines: headlineCount,
      },
    });
  } catch (error) {
    console.error("[ZeroDrift] Health check error:", error);
    res.status(500).json({ status: "error", error: "Health check failed" });
  }
});

app.use((err, req, res, next) => {
  console.error(`[ZeroDrift] ERROR at ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ success: false, error: err.message });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[ZeroDrift] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[ZeroDrift] Uncaught Exception:", error);
  process.exit(1);
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function shutdown() {
  console.log("\n[ZeroDrift] Shutting down gracefully...");
  if (bot) {
    await bot.stopPolling();
    console.log("[ZeroDrift] Telegram bot stopped");
  }
  process.exit(0);
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[ZeroDrift] Engine running on port ${PORT}`);

  try {
    await db.initializeDatabase();
    console.log("[ZeroDrift] Database connected and initialized");
  } catch (err) {
    console.error("[ZeroDrift] Failed to initialize database:", err);
    process.exit(1);
  }

  console.log(`[ZeroDrift] Monitoring ${RSS_FEEDS.length} RSS feeds`);
  console.log(
    `[ZeroDrift] Cooldown: ${COOLDOWN_MS / 3600000}h | Rate limit: ${MAX_ALERTS_PER_HOUR}/hour`,
  );
  pollRSS();
  setInterval(pollRSS, POLL_INTERVAL_MS);
});
