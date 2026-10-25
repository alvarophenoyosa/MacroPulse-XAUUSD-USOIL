# MacroPulse — XAUUSD + USOIL

Independent, paper-first macro-news research desk. This is a separate project from Crypto-Vertex. Exness/MT5 is **not connected** and no live order-routing code is enabled.

## Implemented
- Responsive dashboard for gold and WTI reference pricing.
- Server-side polling every 5 minutes while the Railway service is online.
- GDELT headline search (no key) with source links.
- FRED daily/periodic series: 10Y Treasury yield, 10Y TIPS real yield, effective federal funds rate, broad USD index and WTI spot reference (no key).
- Optional Twelve Data quote + 1-hour candle adapter for XAU/USD and WTI/USD.
- Optional Trading Economics US economic calendar for actual / forecast / previous / importance.
- Basic keyword + hourly momentum watch context, capped at 55% and clearly marked unvalidated. It is not a trained AI model.
- $500 paper balance display; configured paper lot sizes XAUUSD 0.01 and USOIL 0.10.
- Entry validation endpoint with basic 1% estimated-risk guard. No order is sent.

## Required for live source coverage
Set these variables in Railway → `macropulse-web` → Variables. Never commit keys to GitHub.

- `TWELVE_DATA_API_KEY`: get a key from [Twelve Data](https://twelvedata.com/). The app queries XAU/USD and WTI/USD reference symbols and 1-hour candles. Check your plan's symbol coverage and credit limits. These are not guaranteed to match Exness CFD quotes.
- `TRADING_ECONOMICS_API_KEY`: subscribe and obtain a key at [Trading Economics](https://developer.tradingeconomics.com/). The app requests the US economic calendar with actual/forecast/previous values. Check plan access, rate limits and data redistribution rights.

After setting either key, Railway redeploys the service automatically. If a provider returns an error, the dashboard should show it rather than invent data. GDELT and FRED public feeds can still fail or be delayed.

## Data limitations (important)
- GDELT is a news index, not a licensed guaranteed-complete real-time newswire. It does not provide guaranteed full transcripts of every Fed speech or every geopolitical event.
- FRED series are daily/periodic, not tick-level live market data. Oil series may be delayed.
- Market quotes are reference data; the price, spread, sessions and contract specs can differ from Exness XAUUSD/USOIL CFDs.
- Keyword counts are simplistic context filters. “BULLISH WATCH” / “BEARISH WATCH” is not a recommendation or a proven edge. Default is WAIT and no orders are sent.
- This release does not yet have a persistent paper-trade ledger, realistic simulated fills, spread/slippage and funding/carry model, alert delivery, historical event replay, or out-of-sample validation. The 5-minute polling loop is not a guarantee of uninterrupted 24/5 uptime.
- Do not use a positive paper result as proof of future profitability. Validate event-by-event results and max drawdown first.

## Run locally
Node.js 20+: `npm install && npm start`, then open `http://localhost:8080`.

## Next milestones before calling the system complete
1. Add reliable/licensed headline and transcript access; official EIA/API oil inventory data and OPEC primary-source updates.
2. Validate provider timestamps, stale-data detection, API limits, retry/backoff and source health alerts.
3. Implement persistent paper positions/trades, realized/unrealized P/L, simulated spreads/slippage, exit/invalidation logic, and a hard maximum of two adds per thesis.
4. Backtest and replay CPI, NFP, jobless claims, FOMC statements/speeches, EIA inventories and OPEC events; measure latency, false signals, drawdown and net performance.
5. Add durable scheduling, notifications and health monitoring; keep live execution disabled until user explicitly authorizes it after validation.

No system can guarantee 100% accuracy or profitability.
