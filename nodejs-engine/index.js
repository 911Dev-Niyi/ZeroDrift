require('dotenv').config();
const express = require('express');
const RSSParser = require('rss-parser');
const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL;
const RUST_BINARY = process.env.RUST_BINARY_PATH
const POLL_INTERVAL_MS = 300000; // 5 minutes
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours post-trade
const MAX_ALERTS_PER_HOUR = 3;
const RUST_TIMEOUT_MS = 10000; // 10s
const RSS_TIMEOUT_MS = 15000; // 15s

const RSS_FEEDS = [
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
  'https://cryptonews.com/news/feed/',
  'https://bitcoinmagazine.com/.rss/full/',
];

const KEYWORDS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'Bitcoin', 'Ethereum', 'Solana',
  'SEC', 'Fed', 'ETF', 'Trump', 'Binance', 'Coinbase',
  'hack', 'crash', 'rally', 'liquidat', 'pump', 'dump',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeMarkdown(text) {
  return (text || '').replace(/[_*[\]()~`>#+\-=|{}.!$]/g, '\\$&');
}

function extractKeyword(headline) {
  for (const kw of KEYWORDS) {
    if (headline.toLowerCase().includes(kw.toLowerCase())) return kw;
  }
  return headline.split(' ').slice(0, 3).join(' ');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms)),
  ]);
}

// ── State ─────────────────────────────────────────────────────────────────────

// chatId -> { subscribedAt, lastTradeAt, alertsThisHour, hourWindowStart }
const userState = new Map();
const seenHeadlines = new Set();
let latestNews = [];
let latestMarkets = [];
let serverStartTime = Date.now();
let totalAlertsDispatched = 0;
let totalTradesProposed = 0;

// ── User State Helpers ────────────────────────────────────────────────────────

function getUser(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      subscribedAt: Date.now(),
      lastTradeAt: null,
      alertsThisHour: 0,
      hourWindowStart: Date.now(),
    });
  }
  return userState.get(chatId);
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

// ── Telegram Bot ──────────────────────────────────────────────────────────────

const bot = TELEGRAM_TOKEN
  ? new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: true, params: { timeout: 10 } } })
  : null;

if (bot) {
  bot.on('polling_error', (err) => {
    if (err.code !== 'EFATAL') {
      console.log(`[ZeroDrift] Polling hiccup (${err.code})`);
    }
  });
}

// ── Rust Bridge ───────────────────────────────────────────────────────────────

function runRust(args) {
  return withTimeout(new Promise((resolve, reject) => {
    const proc = spawn(RUST_BINARY, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout.trim())); }
      catch (e) { reject(new Error(`Rust parse error: ${stderr || stdout}`)); }
    });
    proc.on('error', err => reject(new Error(`Spawn failed: ${err.message}`)));
  }), RUST_TIMEOUT_MS);
}

// ── RSS Monitor ───────────────────────────────────────────────────────────────

const rssParser = new RSSParser({ timeout: RSS_TIMEOUT_MS });

async function pollRSS() {
  try {
    const isFirstLoad = latestNews.length === 0;

    const feedResults = await Promise.allSettled(
      RSS_FEEDS.map(url => withTimeout(rssParser.parseURL(url), RSS_TIMEOUT_MS))
    );

    const successCount = feedResults.filter(r => r.status === 'fulfilled').length;
    const allItems = feedResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value.items);

    const newItems = allItems.filter(item => {
      const key = item.title?.trim();
      if (!key || seenHeadlines.has(key)) return false;
      seenHeadlines.add(key);
      return true;
    });

    for (const item of newItems) {
      const newsTimestamp = new Date(item.pubDate || Date.now()).getTime();
      latestNews.unshift({ title: item.title, link: item.link, pubDate: item.pubDate, timestamp: newsTimestamp });
      if (isFirstLoad) continue;
      // Only alert on news published after server start
      if (newsTimestamp < serverStartTime) continue;

      console.log(`[ZeroDrift] 📰 ${item.title.slice(0, 60)}...`);

      const keyword = extractKeyword(item.title);
      try {
        const markets = await runRust(['search', '--keyword', keyword]);
        if (markets.count > 0) {
          const topMarket = markets.markets[0];
          const alert = `🚨 *Breaking Alpha*\n\n📰 ${escapeMarkdown(item.title)}\n\n🎯 *Related Market:* ${escapeMarkdown(topMarket.title || topMarket.slug)}\n\n_ZeroDrift detected this opportunity automatically_`;
          broadcastAlert(alert, newsTimestamp, topMarket.slug);
          latestMarkets = markets.markets;
        }
      } catch (e) {
        console.error('[ZeroDrift] Market search error:', e.message);
      }
    }

    latestNews = [...new Map(latestNews.map(n => [n.title, n])).values()].slice(0, 50);

    if (newItems.length > 0) {
      console.log(`[ZeroDrift] +${newItems.length} headlines | ${successCount}/${RSS_FEEDS.length} feeds OK | total seen: ${seenHeadlines.size}`);
    } else {
      console.log(`[ZeroDrift] ✓ Watching ${seenHeadlines.size} headlines across ${successCount}/${RSS_FEEDS.length} feeds`);
    }
  } catch (e) {
    console.error('[ZeroDrift] RSS poll error:', e.message);
  }
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

function broadcastAlert(message, newsTimestamp, slug) {
  if (!bot) return;
  userState.forEach((state, chatId) => {
    if (state.subscribedAt > newsTimestamp) return; // subscribed after news
    if (isUserOnCooldown(chatId)) return;           // recently traded
    if (isUserRateLimited(chatId)) return;          // too many alerts

    recordAlertSent(chatId);
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⚡ Execute on ZeroDrift', web_app: { url: `${FRONTEND_URL}/trade?slug=${slug}` } },
          { text: '📊 View on Limitless', url: `https://limitless.exchange/markets/${slug}` },
        ]],
      },
    }).catch(() => {});
  });
}

// ── Bot Commands ──────────────────────────────────────────────────────────────

if (bot) {
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    getUser(chatId).subscribedAt = Date.now();
    userState.get(chatId).subscribedAt = Date.now();
    bot.sendMessage(chatId,
      `⚡ *ZeroDrift Online*\n\nAutonomous Limitless alpha catalyst\\.

I monitor breaking crypto news across 4 sources and instantly surface related prediction markets before the crowd reacts\\.

*Commands:*
/markets \\- Live opportunities
/news \\- Latest headlines  
/trade \\<slug\\> \\<YES\\|NO\\> \\<amount\\> \\- Trade proposal
/status \\- Your account status
/stop \\- Unsubscribe

_Alerts: max ${MAX_ALERTS_PER_HOUR}/hour\\. Auto\\-quiet for 2h after executing a trade\\._`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.onText(/\/stop/, (msg) => {
    userState.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, '👋 Unsubscribed from ZeroDrift. Send /start to resubscribe.');
  });

  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);
    const onCooldown = isUserOnCooldown(chatId);
    const remaining = cooldownRemaining(chatId);
    const lines = [
      `⚡ *ZeroDrift Status*`,
      ``,
      `📡 Subscribed: ✅`,
      `🔔 Alerts sent this hour: ${user.alertsThisHour}/${MAX_ALERTS_PER_HOUR}`,
      `🧊 Cooldown: ${onCooldown ? `Active \\(${remaining} min remaining\\)` : 'None'}`,
      `📰 Headlines watched: ${seenHeadlines.size}`,
      `🎯 Markets tracked: ${latestMarkets.length}`,
    ];
    bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' }).catch(() => {
      bot.sendMessage(chatId, `Status: ${user.alertsThisHour}/${MAX_ALERTS_PER_HOUR} alerts | Cooldown: ${onCooldown ? remaining + 'min' : 'none'}`);
    });
  });

  bot.onText(/\/markets/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '⏳ Scanning Limitless...');
    try {
      const results = await Promise.all([
        runRust(['search', '--keyword', 'BTC']),
        runRust(['search', '--keyword', 'ETH']),
      ]);
      const seen = new Set();
      const markets = results.flatMap(r => r.markets || []).filter(m => {
        if (seen.has(m.slug)) return false;
        seen.add(m.slug);
        return true;
      }).slice(0, 5);

      if (markets.length === 0) {
        bot.sendMessage(chatId, '📭 No markets found right now.');
        return;
      }
      const lines = markets.map((m, i) =>
        `${i + 1}\\. *${escapeMarkdown(m.title || m.slug)}*\n   \`${m.slug}\``
      ).join('\n\n');
      bot.sendMessage(chatId, `🎯 *Active Opportunities*\n\n${lines}\n\nUse: /trade \\<slug\\> YES 10`, { parse_mode: 'MarkdownV2' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
  });

  bot.onText(/\/news/, (msg) => {
    if (latestNews.length === 0) {
      bot.sendMessage(msg.chat.id, '📭 No news cached yet. Check back in a few minutes.');
      return;
    }
    const lines = latestNews.slice(0, 5).map((n, i) =>
      `${i + 1}. ${n.title}\n   🔗 ${n.link}`
    ).join('\n\n');
    bot.sendMessage(msg.chat.id, `📰 *Latest Crypto News*\n\n${lines}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/trade (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].trim().split(/\s+/);

    if (parts.length < 3) {
      bot.sendMessage(chatId, '⚠️ Usage: /trade <slug> <YES|NO> <amount>\n\nExample:\n/trade btc-up-or-down-daily YES 10');
      return;
    }

    const [slug, side, amount] = parts;
    if (!['YES', 'NO', 'yes', 'no'].includes(side)) {
      bot.sendMessage(chatId, '⚠️ Side must be YES or NO');
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      bot.sendMessage(chatId, '⚠️ Amount must be a positive number');
      return;
    }

    console.log(`[ZeroDrift] Trade request: ${slug} ${side} $${amount}`);
    bot.sendMessage(chatId, '⏳ Generating trade proposal...');

    try {
      const result = await runRust(['trade', '--slug', slug, '--side', side.toUpperCase(), '--amount', amount]);
      const hasPrice = result.estimated_price && result.estimated_shares;
      const reply = `📊 *Trade Proposal*\n\n*Market:* ${escapeMarkdown(slug)}\n*Side:* ${result.side}\n*Amount:* $${result.amount_usdc} USDC\n*Est\\. Price:* ${hasPrice ? '$' + result.estimated_price.toFixed(3) : 'N/A'}\n*Est\\. Shares:* ${hasPrice ? result.estimated_shares.toFixed(2) : 'N/A'}\n\n_Review and execute on ZeroDrift_`;
      bot.sendMessage(chatId, reply, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[
            { text: '⚡ Execute on ZeroDrift', web_app: { url: `${FRONTEND_URL}/trade?slug=${slug}` } },
            { text: '📊 View on Limitless', url: `https://limitless.exchange/markets/${slug}` },
          ]],
        },
      }).catch(() => {
        // Fallback without markdown
        bot.sendMessage(chatId, `Trade Proposal: ${slug} | ${result.side} | $${result.amount_usdc}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: '⚡ Execute on ZeroDrift', web_app: { url: `${FRONTEND_URL}/trade?slug=${slug}` } },
            ]],
          },
        });
      });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Failed to generate proposal: ${e.message}`);
    }
  });

  console.log('[ZeroDrift] Telegram bot active');
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/news', (req, res) => {
  res.json({ success: true, news: latestNews });
});

app.get('/api/markets/search', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  try {
    const result = await runRust(['search', '--keyword', keyword]);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/markets/orderbook', async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    const result = await runRust(['orderbook', '--slug', slug]);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/trade/propose', async (req, res) => {
  const { slug, side, amount } = req.body;
  if (!slug || !side || !amount)
    return res.status(400).json({ error: 'slug, side, amount required' });
  try {
    const result = await runRust(['trade', '--slug', slug, '--side', side.toString(), '--amount', amount.toString()]);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Called from frontend after wallet execution
app.post('/api/trade/executed', (req, res) => {
  const { chatId } = req.body;
  if (chatId) {
    recordTradeExecuted(chatId);
    const remaining = cooldownRemaining(chatId);
    console.log(`[ZeroDrift] Trade executed for ${chatId} — cooldown ${remaining}min`);
    if (bot) {
      bot.sendMessage(chatId,
        `✅ *Trade Executed*\n\nZeroDrift is now in cooldown mode for 2 hours\\.\n\nYour alerts are paused — go touch grass 🌿`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {});
    }
  }
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  res.json({
    success: true,
    status: 'online',
    uptime: `${Math.floor(uptime / 60)}m ${uptime % 60}s`,
    subscribers: userState.size,
    newsCount: latestNews.length,
    marketsCount: latestMarkets.length,
    headlinesSeen: seenHeadlines.size,
    feedCount: RSS_FEEDS.length,
    telegramActive: !!bot,
    totalAlertsDispatched,
    totalTradesProposed,
  });
});

app.post('/api/test-alpha', async (req, res) => {
  const testHeadline = req.body.headline || 'Bitcoin breaks $100K as ETF inflows surge';
  const keyword = extractKeyword(testHeadline);
  try {
    const markets = await runRust(['search', '--keyword', keyword]);
    if (markets.count > 0) {
      const topMarket = markets.markets[0];
      const alert = `🚨 *Breaking Alpha*\n\n📰 ${escapeMarkdown(testHeadline)}\n\n🎯 *Related Market:* ${escapeMarkdown(topMarket.title || topMarket.slug)}\n\n_ZeroDrift detected this opportunity automatically_`;
      broadcastAlert(alert, Date.now(), topMarket.slug);
      res.json({ success: true, market: topMarket.slug, subscribers: userState.size });
    } else {
      res.json({ success: false, message: 'No matching market found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  console.log('\n[ZeroDrift] Shutting down gracefully...');
  if (bot) {
    await bot.stopPolling();
    console.log('[ZeroDrift] Telegram bot stopped');
  }
  process.exit(0);
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[ZeroDrift] Engine running on port ${PORT}`);
  console.log(`[sZeroDrift] Monitoring ${RSS_FEEDS.length} RSS feeds`);
  console.log(`[ZeroDrift] Cooldown: ${COOLDOWN_MS / 3600000}h | Rate limit: ${MAX_ALERTS_PER_HOUR}/hour`);
  pollRSS();
  setInterval(pollRSS, POLL_INTERVAL_MS);
});