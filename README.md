# MacroPulse — XAUUSD + USOIL

A separate, paper-first macro research dashboard. It does not modify or connect to Crypto-Vertex.

## Current behavior
- $500 paper starting balance.
- XAUUSD base entry: 0.01 lot; USOIL base entry: 0.10 lot.
- Dashboard and health API deploy on Railway.
- Always defaults to WAIT because no verified live market/news/calendar feed is connected.
- Entry validation endpoint enforces basic sizing and a 1% estimated-risk cap; it is not an order simulator.
- No broker credentials, order routing, P/L simulation, or persistent ledger is implemented.
- Live execution is intentionally disabled.

## Run locally
Node.js 20+: `npm install && npm start`, then open `http://localhost:8080`.

## Before any real trading
1. Choose a licensed economic calendar and news provider; implement and verify its schema, timestamp freshness, release status, actual/forecast/previous values, FOMC speech coverage, and outages.
2. Connect live price feeds for XAUUSD and USOIL plus relevant USD, rates/real yields, inventory and futures-curve inputs.
3. Select a broker and verify instrument contract size, tick value, margin, spread, session, order and stop semantics.
4. Build a broker demo adapter, persistent paper ledger, event replay/backtests, slippage/spread modeling, monitoring and alerting.
5. Validate across CPI, NFP, jobless claims, FOMC and oil inventory/OPEC scenarios. Measure drawdown, false positives, latency and net performance after costs.
6. Keep live orders disabled until the above has passed and explicit authorization is given.

No system can guarantee profitable or perfectly accurate trades. Never average into a losing position without a defined invalidation and total-risk limit. Hosting alone does not provide 24/5 monitoring; a worker and reliable feeds are required.