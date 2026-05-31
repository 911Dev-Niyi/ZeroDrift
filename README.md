# ⚡ ZeroDrift

> Autonomous Limitless Alpha Catalyst — Early Forge Hackathon

**Track:** Limitless Exchange (Base) — Aomi Early Forge Hackathon

---

## What It Does

ZeroDrift encodes the edge of a prediction market trader into an autonomous agent that monitors breaking crypto news 24/7, detects high-conviction market opportunities, and delivers trade proposals to Telegram before the crowd has time to react.

A sharp prediction market trader profits from information asymmetry. Sleep, distraction, and the sheer volume of crypto news erode that edge. ZeroDrift fixes that.

---

## The Core Insight

In crypto prediction markets, **information asymmetry is everything.**

When a major headline breaks — _"SEC Approves Bitcoin ETF"_ or _"Protocol Hacked for $200M"_ — market odds take several minutes to adjust as human traders manually read and react. That delay is **the drift.** ZeroDrift's goal is to reduce it to zero: the moment a real-world event happens, a high-conviction trade is proposed and ready to execute before the rest of the market has read the headline.

---

## How It Works

**1. Breaking news drops**

ZeroDrift monitors 4 live crypto RSS feeds simultaneously — CoinTelegraph, Decrypt, CryptoNews, Bitcoin Magazine — polling every 5 minutes and deduplicating across sources.

**2. Rust brain finds the market**

The Rust agent performs a semantic search against the Limitless API, matches the headline to the most relevant active prediction market, and fetches live CLOB orderbook pricing.

**3. Telegram alert fires**

A structured alpha card is delivered to the user's Telegram with rate limiting (max 3/hour) and a direct **Execute on ZeroDrift** button.

```
🚨 Breaking Alpha

📰 BlackRock Bitcoin ETF sees record inflows as BTC hits $95K

🎯 Related Market: BTC Up or Down - Daily

⚡ Execute on ZeroDrift    📊 View on Limitless
```

**4. User taps Execute — trade proposal loads**

The Telegram button opens ZeroDrift's web app as a Mini App directly inside Telegram, with the market pre-selected. The user connects their wallet via RainbowKit, reviews the proposal, and signs — private keys never leave the device.

---

## Architecture

```
┌─────────────────────────────────────────┐
│         Telegram Bot (nodejs-engine/)    │
│  RSS monitoring, alpha alerts,           │
│  trade proposals, rate limiting,         │
│  cooldown system, /status /markets       │
└──────────────┬──────────────────────────┘
               │ child_process bridge
┌──────────────▼──────────────────────────┐
│      Rust Agent (rust-agent/)            │
│  3 commands: search / orderbook / trade  │
│  Limitless REST API + CLOB orderbook     │
│  Semantic keyword → market matching      │
│  Live YES/NO pricing + share estimation  │
└──────────────┬──────────────────────────┘
               │ REST API (port 3001)
┌──────────────▼──────────────────────────┐
│      Next.js Frontend (frontend/)        │
│  Dark trading terminal UI                │
│  RainbowKit + Wagmi wallet connection    │
│  Live market list (auto-refresh 30s)     │
│  YES/NO confidence bars + expiry badges  │
│  Deep link: ?slug= auto-loads proposal   │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   Limitless Exchange — Base Mainnet      │
│   User wallet signs — no custody         │
└─────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| News monitoring | Node.js + `rss-parser` (4 feeds) |
| Telegram bot | `node-telegram-bot-api` |
| Market intelligence | Rust + `reqwest` + `clap` + `serde` |
| Frontend | Next.js 16 + TypeScript + Tailwind |
| Wallet | RainbowKit + Wagmi + Viem |
| Network | Base (Ethereum L2) |
| Protocol | Limitless Exchange |

---

## Monorepo Structure

```
ZeroDrift/
├── rust-agent/              # Rust binary — Limitless API + trade payloads
│   ├── src/
│   │   └── main.rs          # search / orderbook / trade commands
│   └── Cargo.toml
│
├── nodejs-engine/           # Express server — RSS monitor + Telegram + REST API
│   ├── index.js             # Main engine
│   └── package.json
│
└── frontend/                # Next.js app — wallet UI + trade execution
    ├── app/
    │   ├── page.tsx         # Main dashboard
    │   ├── layout.tsx       # Providers wrapper
    │   └── globals.css      # Design tokens
    └── lib/
        ├── wagmi.ts         # Chain + transport config
        └── providers.tsx    # RainbowKit + Wagmi providers
```

---

## Running Locally

**Requirements:** Node.js 18+, Rust + Cargo

### 1. Build the Rust Agent

```bash
cd rust-agent
cargo build
```

### 2. Configure & Start the Node.js Engine

```bash
cd nodejs-engine
npm install
```

Create `.env`:
```
PORT=3001
TELEGRAM_TOKEN=your_bot_token_here
```

```bash
node index.js
```

### 3. Configure & Start the Frontend

```bash
cd frontend
npm install
```

Create `.env.local`:
```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id_here
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Telegram Bot Commands

| Command | Description |
|---|---|
| `/start` | Subscribe to alpha alerts |
| `/markets` | Live BTC + ETH prediction market opportunities |
| `/news` | Latest headlines across all 4 monitored sources |
| `/trade <slug> <YES\|NO> <amount>` | Generate a trade proposal |
| `/status` | Alert count, cooldown state, headlines watched |
| `/stop` | Unsubscribe from alerts |

---

## Key Design Decisions

**No custody.** ZeroDrift never holds or signs with user funds. Every trade proposal is reviewed and signed by the user's own wallet.

**News-first, not chart-first.** Most agentic trading tools watch price charts. ZeroDrift watches the world — the event that moves the chart is detected before the chart moves.

**Rust for the brain.** The market search and trade payload layer is a native Rust binary. No JavaScript runtime overhead on the critical path between a breaking headline and a signed transaction.

**Rate limiting + cooldown by design.** Alerts are capped at 3/hour per user. After executing a trade, alerts pause for 2 hours automatically. The agent respects your attention.

**Deep link flow.** Telegram alerts carry a `?slug=` parameter that pre-loads the exact market in the web app. One tap from alert to execution — no manual search.

**Multi-source deduplication.** Headlines are deduplicated by title across all 4 RSS feeds before any downstream processing, so the same story never triggers two alerts.

---

## Production Features

- 4 RSS feeds monitored simultaneously with per-feed timeout handling
- Graceful shutdown — SIGTERM/SIGINT handling, clean bot teardown
- Request timeouts — 10s Rust calls, 15s RSS fetches
- Mobile-responsive UI — works as a Telegram Mini App on mobile
- `/api/status` endpoint for uptime, alert counts, and feed health
- Test endpoint (`/api/test-alpha`) for demo and development

---

## References

- [Aomi SDK](https://github.com/aomi-labs/aomi-sdk)
- [Limitless Exchange](https://limitless.exchange)
- [Limitless API Docs](https://docs.limitless.exchange)
- [Base](https://base.org)

---