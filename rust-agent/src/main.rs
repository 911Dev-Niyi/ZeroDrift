use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "zero-drift-agent")]
#[command(about = "ZeroDrift: Autonomous Limitless Alpha Catalyst")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Search for a prediction market by keyword (semantic search)
    Search {
        #[arg(short, long)]
        keyword: String,
        #[arg(short, long, default_value = "5")]
        limit: u32,
    },
    /// Get price/odds for a specific market slug
    Orderbook {
        #[arg(short, long)]
        slug: String,
    },
    /// Build a trade proposal for a market
    Trade {
        #[arg(long)]
        slug: String,
        /// YES or NO
        #[arg(long)]
        side: String,
        /// Amount in USDC (e.g. 10.0)
        #[arg(short, long)]
        amount: f64,
    },
}

// ── API Types ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
struct MarketResult {
    slug: String,
    title: Option<String>,
    description: Option<String>,
    ticker: Option<String>,
    #[serde(rename = "strikePrice")]
    strike_price: Option<String>,
    deadline: Option<String>,
    #[serde(rename = "yesPrice")]
    yes_price: Option<serde_json::Value>,
    #[serde(rename = "noPrice")]
    no_price: Option<serde_json::Value>,
    #[serde(rename = "volumeFormatted")]
    volume_formatted: Option<String>,
}

// ── Output Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct SearchOutput {
    success: bool,
    keyword: String,
    count: usize,
    markets: Vec<MarketSummary>,
}

#[derive(Debug, Serialize)]
struct MarketSummary {
    slug: String,
    title: Option<String>,
    ticker: Option<String>,
    strike_price: Option<String>,
    deadline: Option<String>,
    yes_price: Option<f64>,
    no_price: Option<f64>,
}

#[derive(Debug, Serialize)]
struct OrderbookOutput {
    success: bool,
    slug: String,
    yes_price: Option<f64>,
    no_price: Option<f64>,
    volume: Option<String>,
}

#[derive(Debug, Serialize)]
struct TradeOutput {
    success: bool,
    slug: String,
    side: String,
    amount_usdc: f64,
    estimated_price: Option<f64>,
    estimated_shares: Option<f64>,
    message: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn extract_price(val: &Option<serde_json::Value>) -> Option<f64> {
    val.as_ref().and_then(|v| {
        if let Some(f) = v.as_f64() {
            Some(f)
        } else if let Some(s) = v.as_str() {
            s.parse::<f64>().ok()
        } else {
            None
        }
    })
}

fn to_summary(m: MarketResult) -> MarketSummary {
    let yes_price = extract_price(&m.yes_price);
    let no_price = extract_price(&m.no_price);
    MarketSummary {
        slug: m.slug,
        title: m.title,
        ticker: m.ticker,
        strike_price: m.strike_price,
        deadline: m.deadline,
        yes_price,
        no_price,
    }
}

const API_BASE: &str = "https://api.limitless.exchange";

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn cmd_search(client: &reqwest::Client, keyword: &str, limit: u32) {
    let url = format!(
        "{}/markets/search?query={}&limit={}&similarityThreshold=0.3",
        API_BASE,
        urlencoding::encode(keyword),
        limit
    );

    let resp = client.get(&url).send().await;

    match resp {
        Ok(r) => {
            let status = r.status();
            let body: serde_json::Value = r.json().await.unwrap_or_default();

            if !status.is_success() {
                let out = serde_json::json!({
                    "success": false,
                    "error": format!("API returned {}", status),
                    "body": body
                });
                println!("{}", serde_json::to_string(&out).unwrap());
                return;
            }

            // Response can be an array or { data: [...] }
            let items: Vec<serde_json::Value> = if body.is_array() {
                body.as_array().cloned().unwrap_or_default()
            } else if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
                arr.clone()
            } else if let Some(arr) = body.get("markets").and_then(|d| d.as_array()) {
                arr.clone()
            } else {
                vec![]
            };

            let markets: Vec<MarketSummary> = items
                .into_iter()
                .filter_map(|v| serde_json::from_value::<MarketResult>(v).ok())
                .map(to_summary)
                .collect();

            let out = SearchOutput {
                success: true,
                keyword: keyword.to_string(),
                count: markets.len(),
                markets,
            };
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        Err(e) => {
            let out = serde_json::json!({ "success": false, "error": e.to_string() });
            println!("{}", serde_json::to_string(&out).unwrap());
        }
    }
}

async fn cmd_orderbook(client: &reqwest::Client, slug: &str) {
    // Fetch both endpoints concurrently
    let ob_url = format!("{}/markets/{}/orderbook", API_BASE, slug);
    let market_url = format!("{}/markets/{}", API_BASE, slug);

    let ob_body = match client.get(&ob_url).send().await {
        Ok(r) => r.json::<serde_json::Value>().await.unwrap_or_default(),
        Err(_) => serde_json::Value::Null,
    };

    let market_body = match client.get(&market_url).send().await {
        Ok(r) => r.json::<serde_json::Value>().await.unwrap_or_default(),
        Err(_) => serde_json::Value::Null,
    };

    let best_ask = ob_body.get("asks")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.first())
        .and_then(|o| o.get("price"))
        .and_then(|p| p.as_f64());
    let best_bid = ob_body.get("bids")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.first())
        .and_then(|o| o.get("price"))
        .and_then(|p| p.as_f64());
    let last_trade = ob_body.get("lastTradePrice").and_then(|p| p.as_f64());
    let midpoint = ob_body.get("adjustedMidpoint").and_then(|p| p.as_f64());

    let prices_yes = market_body.get("prices")
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_f64())
        .filter(|&p| p > 0.0 && p < 1.0);

    let status = market_body.get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();

    let yes_price = best_ask.or(midpoint).or(last_trade).or(prices_yes);
    let no_price = yes_price.map(|p| 1.0 - p);

    let out = serde_json::json!({
        "success": true,
        "slug": slug,
        "status": status,
        "yes_price": yes_price,
        "no_price": no_price,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "last_trade_price": last_trade,
        "midpoint": midpoint
    });
    println!("{}", serde_json::to_string(&out).unwrap());
}

async fn cmd_trade(client: &reqwest::Client, slug: &str, side: &str, amount: f64) {
    let url = format!("{}/markets/{}/orderbook", API_BASE, slug);
    let resp = client.get(&url).send().await;

    let (yes_price, no_price) = match resp {
        Ok(r) => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            let best_ask = body.get("asks")
                .and_then(|a| a.as_array())
                .and_then(|arr| arr.first())
                .and_then(|o| o.get("price"))
                .and_then(|p| p.as_f64());
            let midpoint = body.get("adjustedMidpoint")
                .and_then(|p| p.as_f64());
            let last_trade = body.get("lastTradePrice")
                .and_then(|p| p.as_f64());
            // AMM fallback: try yesPrice/noPrice directly on the body
           let yes_price_field = body.get("yesPrice")
                .and_then(|p| p.as_f64());
            // AMM/CLOB fallback: prices array [yes, no]
            let prices_yes = body.get("prices")
                .and_then(|p| p.as_array())
                .and_then(|arr| arr.first())
                .and_then(|v| v.as_f64())
                .filter(|&p| p > 0.0 && p < 1.0); // ignore resolved [1,0] or [0,1]
            let yes = best_ask.or(midpoint).or(last_trade).or(yes_price_field).or(prices_yes);
            let no = yes.map(|p| 1.0 - p);
            (yes, no)
        }
        Err(_) => (None, None),
    };

    let side_upper = side.to_uppercase();
    let estimated_price = match side_upper.as_str() {
        "YES" => yes_price,
        "NO" => no_price,
        _ => None,
    };

    let estimated_shares = estimated_price.map(|p| if p > 0.0 { amount / p } else { 0.0 });

    let out = TradeOutput {
        success: true,
        slug: slug.to_string(),
        side: side_upper.clone(),
        amount_usdc: amount,
        estimated_price,
        estimated_shares,
        message: format!(
            "Trade proposal: Buy {:.2} {} shares on '{}' for ${:.2} USDC at ~${:.3}/share",
            estimated_shares.unwrap_or(0.0),
            side_upper,
            slug,
            amount,
            estimated_price.unwrap_or(0.0)
        ),
    };
    println!("{}", serde_json::to_string(&out).unwrap());
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let client = reqwest::Client::new();

    match &cli.command {
        Commands::Search { keyword, limit } => {
            cmd_search(&client, keyword, *limit).await;
        }
        Commands::Orderbook { slug } => {
            cmd_orderbook(&client, slug).await;
        }
        Commands::Trade { slug, side, amount } => {
            cmd_trade(&client, slug, side, *amount).await;
        }
    }
}