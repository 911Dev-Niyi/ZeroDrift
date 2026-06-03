# How to Use ZeroDrift

ZeroDrift is an autonomous prediction market alpha catalyst built on Limitless Exchange (Base). It monitors breaking crypto news, finds related prediction markets, and delivers trade proposals directly to your Telegram — before the crowd reacts.

There are two ways to interact with ZeroDrift: the **Telegram Bot** and the **Web App**.

---

## Getting Started

### 1. Open the Telegram Bot

Search for **@ZeroDriftBot** on Telegram or use the direct link.

Send `/start` to subscribe to automatic alpha alerts.

You'll see:

```
⚡ ZeroDrift Online

I'm your autonomous Limitless alpha catalyst.

I monitor breaking crypto news and instantly find related
prediction markets before the crowd reacts.

Commands:
/markets - Live opportunities
/news - Latest headlines
/alphas - On-demand alpha opportunities
/trade <slug> <YES|NO> <amount> - Trade proposal
/status - Your account status
/stop - Unsubscribe
```

---

## Telegram Commands

### `/markets`
Shows currently active and funded prediction markets on Limitless, with live YES probability for each.

```
🎯 Active Funded Markets

1. BTC Up or Down - 15 Min
   btc-up-or-down-15-min-xxx — YES: 85%

2. ETH Up or Down - Hourly
   eth-up-or-down-hourly-xxx — YES: 45%
```

### `/alphas`
Scans across BTC, ETH, SOL, XRP, ETF, Trump, and SEC markets simultaneously. Returns up to 5 live opportunities sorted by **edge potential** — markets closest to 50/50 have the most room to move and represent the highest alpha opportunity.

Each card shows:
- Market title
- Visual YES/NO probability bar
- Live percentage odds
- Direct Execute button

### `/trade <slug> <YES|NO> <amount>`
Generates a detailed trade proposal for any market. Use slugs from `/markets` or `/alphas`.

Example:
```
/trade btc-up-or-down-daily-xxx YES 10
```

Returns:
```
📊 Trade Proposal

🎯 BTC UP OR DOWN DAILY

💰 Side: YES
💵 Amount: $10 USDC
📈 Price: $0.852
🎰 Shares: 11.72

Review and execute on ZeroDrift
```

Tap **Execute on ZeroDrift** to open the web app with this market pre-loaded.

### `/news`
Shows the latest 5 headlines from across 4 monitored crypto news sources: CoinTelegraph, Decrypt, CryptoNews, and Bitcoin Magazine.

### `/status`
Shows your personal ZeroDrift stats:
- Alerts sent this hour (max 3/hour)
- Cooldown status — after executing a trade, alerts pause for 2 hours automatically
- Total headlines watched

### `/stop`
Unsubscribes you from automatic alerts. You can still use all commands manually. Send `/start` to resubscribe.

---

## Automatic Alpha Alerts

Once subscribed via `/start`, ZeroDrift monitors 4 RSS feeds every 5 minutes. When a new headline drops and a related funded market is found, you receive an alert automatically:

```
🚨 Breaking Alpha

📰 BlackRock Bitcoin ETF sees record inflows as BTC hits $95K
🔗 [full article link]

🎯 Related Market: BTC Up or Down - Daily

ZeroDrift detected this opportunity automatically
```

Each alert includes:
- **Execute on ZeroDrift** — opens the web app with the market and correct side pre-loaded
- **View on Limitless** — goes directly to the Limitless market page
- **Read Full Story** — opens the original news article

**Rate limits:** Max 3 alerts per hour per user.
**Post-trade cooldown:** After executing a trade, alerts pause for 2 hours so you can focus.

---

## The Web App

Open **https://zero-drift-eight.vercel.app** directly or tap any **Execute on ZeroDrift** button from Telegram.

### Market Scanner
- Search any keyword (BTC, ETH, SOL, SEC, ETF...)
- Results auto-refresh every 30 seconds
- Click any market to generate a trade proposal instantly
- Each card shows an expiry badge (5 min, 15 min, 1 hour, 24 hours) and a YES/NO confidence bar

### Trade Proposal Panel
- Select YES or NO side
- Choose amount: $5, $10, $25, $50 or custom
- Click any market to calculate: estimated price, estimated shares, confidence bar
- Hit **↻ RECALCULATE** any time to update with fresh pricing

### Executing a Trade
1. Click **Connect Wallet** (top right)
2. Select your wallet — MetaMask, Coinbase Wallet, Rainbow, or WalletConnect
3. Make sure you're on the **Base network**
4. Review the trade proposal
5. Click **⚡ EXECUTE TRADE**
6. Sign the transaction in your wallet

### News Tab
Switch to the **NEWS** tab to see the latest headlines from all 4 monitored sources, with relative timestamps (e.g. "12m ago"). Auto-refreshes every 30 seconds.

---

## Tips

- **Best alpha:** Use `/alphas` for the highest edge opportunities — markets near 50/50 have the most room to move when news breaks.
- **Fast execution:** When an automatic alert fires, tap Execute immediately — the window before the market reprices is typically a few minutes.
- **Custom amounts:** Type any amount in the USDC field — not limited to the preset buttons.
- **Check expiry:** Short-duration markets (5 min, 15 min) expire fast — always check the ⏱ badge before executing.
- **After trading:** Your alerts pause for 2 hours automatically. Use `/status` to check your cooldown.

---

## Architecture (for developers)

ZeroDrift is built across three layers:

| Layer | Tech | Role |
|---|---|---|
| Rust Agent | Rust + reqwest | Limitless API — market search, orderbook, trade payloads |
| Node.js Engine | Express + node-telegram-bot-api | RSS monitor, Telegram bot, REST API bridge |
| Next.js Frontend | Next.js + RainbowKit + Wagmi | Wallet UI, market dashboard, trade execution |

GitHub: **https://github.com/911Dev-Niyi/ZeroDrift.git**

---

*Built for the Aomi Early Forge Hackathon — Limitless track.*