use aomi_sdk::{dyn_aomi_app, DynAomiTool, DynToolCallCtx};
use aomi_sdk::schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct ZeroDriftApp;

const LIMITLESS_API: &str = "https://api.limitless.exchange";

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchArgs {
    keyword: String,
}

struct SearchTool;

impl DynAomiTool for SearchTool {
    type App = ZeroDriftApp;
    type Args = SearchArgs;
    const NAME: &'static str = "search";
    const DESCRIPTION: &'static str = "Search Limitless markets by keyword";

    fn run(_app: &Self::App, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let url = format!("{}/markets/search?query={}&limit=5&similarityThreshold=0.3", LIMITLESS_API, args.keyword);
            let res = reqwest::Client::new().get(&url).send().await.map_err(|e| e.to_string())?;
            let markets: Value = res.json().await.map_err(|e| e.to_string())?;
            
            let items = if markets.is_array() {
                markets.as_array().unwrap().clone()
            } else {
                markets.get("data")
                    .or_else(|| markets.get("markets"))
                    .and_then(|v| v.as_array())
                    .unwrap_or(&vec![])
                    .clone()
            };

            Ok(json!({ "success": true, "keyword": args.keyword, "count": items.len(), "markets": items.iter().map(|m| json!({"slug": m.get("slug").and_then(|v| v.as_str()), "title": m.get("title").and_then(|v| v.as_str())})).collect::<Vec<_>>() }))
        })
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct OrderbookArgs {
    slug: String,
}

struct OrderbookTool;

impl DynAomiTool for OrderbookTool {
    type App = ZeroDriftApp;
    type Args = OrderbookArgs;
    const NAME: &'static str = "orderbook";
    const DESCRIPTION: &'static str = "Get live orderbook pricing for a market";

    fn run(_app: &Self::App, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let url = format!("{}/markets/{}/orderbook", LIMITLESS_API, args.slug);
            let res = reqwest::Client::new().get(&url).send().await.map_err(|e| e.to_string())?;
            let ob: Value = res.json().await.map_err(|e| e.to_string())?;

            let yes_price = ob.get("asks").and_then(|a| a.as_array()).and_then(|a| a.first()).and_then(|f| f.get("price")).and_then(|p| p.as_f64());
            let no_price = yes_price.map(|y| 1.0 - y);

            Ok(json!({"success": true, "slug": args.slug, "yes_price": yes_price, "no_price": no_price, "status": ob.get("status").and_then(|v| v.as_str()).unwrap_or("UNKNOWN")}))
        })
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TradeArgs {
    slug: String,
    side: String,
    amount: f64,
}

struct TradeTool;

impl DynAomiTool for TradeTool {
    type App = ZeroDriftApp;
    type Args = TradeArgs;
    const NAME: &'static str = "trade";
    const DESCRIPTION: &'static str = "Generate a trade proposal";

    fn run(_app: &Self::App, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let url = format!("{}/markets/{}/orderbook", LIMITLESS_API, args.slug);
            let res = reqwest::Client::new().get(&url).send().await.map_err(|e| e.to_string())?;
            let ob: Value = res.json().await.map_err(|e| e.to_string())?;

            let yes_price = ob.get("asks").and_then(|a| a.as_array()).and_then(|a| a.first()).and_then(|f| f.get("price")).and_then(|p| p.as_f64()).unwrap_or(0.5);
            let est_price = if args.side.to_uppercase() == "YES" { yes_price } else { 1.0 - yes_price };
            let est_shares = args.amount / est_price;

            Ok(json!({"success": true, "slug": args.slug, "side": args.side, "amount_usdc": args.amount, "estimated_price": est_price, "estimated_shares": est_shares}))
        })
    }
}

dyn_aomi_app!(
    app = ZeroDriftApp,
    name = "zerodrift",
    version = "0.1.0",
    preamble = "Autonomous Limitless alpha catalyst. Search markets, get live pricing, generate trade proposals.",
    tools = [SearchTool, OrderbookTool, TradeTool],
    namespaces = ["defi"],
);