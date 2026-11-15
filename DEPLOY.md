# Deploy MENTHA Paper Trade

This version is ready for Render + Supabase.

## 1. Create Supabase Project

1. Go to Supabase and create a project.
2. Open SQL Editor.
3. Paste and run `supabase-schema.sql`.
4. Go to Project Settings -> API.
5. Copy:
   - Project URL
   - `service_role` key

Keep the service role key secret. It goes only in Render environment variables.

If the last schema change you applied was individual margin and brokerage rates, run `supabase-migration-after-trader-rates.sql` in Supabase SQL Editor before starting the updated app. For a fresh project, run the complete `supabase-schema.sql` instead. The migration adds contracts and order permissions, assigns existing orders and trades to the original MENTHAOIL contract, and backfills missing execution details.
If login reports that `public.contracts` is missing from the schema cache, run the migration in the Supabase project configured by Render's `SUPABASE_URL`. Its final query should return `public.contracts`. The migration also requests a PostgREST schema cache reload.
The latest schema also adds `fund_ledger`, used for opening balance and fund addition/removal history.
For an existing deployment, run `supabase-fix-mentha-lot-size.sql` in Supabase SQL Editor to correct the MENTHAOIL contract to 360 kg per lot.
The backend automatically adds the four default Shark crypto pairs to an existing database on startup. `supabase-add-shark-crypto.sql` remains available if you need to add them manually. A fresh project gets these pairs from `supabase-schema.sql`.

## 2. Push Project To GitHub

Upload this folder to a GitHub repo.

Required deploy files:

- `server.js`
- `package.json`
- `render.yaml`
- `index.html`
- `styles.css`
- `app.js`
- `manifest.webmanifest`
- `supabase-schema.sql`
- `supabase-add-shark-crypto.sql` (existing databases)

## 3. Deploy On Render

1. Open Render.
2. New -> Web Service.
3. Connect your GitHub repo.
4. Runtime: Node.
5. Build command: `npm install`
6. Start command: `npm start`

Set environment variables:

```text
SUPABASE_URL=your Supabase project URL
SUPABASE_SERVICE_ROLE_KEY=your Supabase service role key
SESSION_SECRET=any long random text
MASTER_PIN=your master login pin
UPSTOX_ACCESS_TOKEN=your Upstox access token
UPSTOX_INSTRUMENT_KEY=MCX_FO|552719
MARKET_POLL_MS=1500
```

## 4. Use The App

Open your Render URL.

Master login:

```text
MASTER
your MASTER_PIN
```

Create users from the Admin tab. Users can then login from their own phone.

The master-only Contracts tab adds instruments to every trader's Watchlist. Enter the instrument's Upstox key, lot size, tick size, and starting and previous-close prices. The starting prices are used when the Upstox token is unavailable. Traders can open a watchlist row to view its market depth and place paper orders for that contract.

Bitcoin, Ethereum, Solana, and XRP INR perpetual pairs use Shark Exchange's public ticker and depth endpoints. They need no Shark API key. Other supported INR or USDT pairs can be added in Contracts using an instrument key such as `SHARK:BNBINR` or `SHARK:BTCUSDT`. Shark quotes show as unavailable until a valid exchange response arrives; simulated prices are never used to fill Shark orders.

The PowerShell-only `?local=1` demo receives Shark quotes from its public WebSocket stream. Its non-crypto instruments are simulated. The watchlist labels each quote as Shark live, Upstox live, simulated, or feed unavailable. When Shark is unavailable, crypto paper orders pause until the feed returns.

## 5. Configure Trading Rules

Login as master and open Admin. Set rates and order permissions when creating a trader, or edit and save the settings on that trader's card. Run the latest `supabase-schema.sql` in Supabase SQL Editor before using order permissions on an existing deployment.

Set:

- Brokerage per lot: fixed rupee amount charged on every filled lot.
- Margin per lot: rupee margin required for each lot before an order is accepted.
- Allow market orders: permit this trader to place new market orders.
- Allow limit orders: permit this trader to place new limit orders. Turn off both to block all new orders for that trader.

Order behavior:

- Market buy fills immediately at the first sell/ask in market depth.
- Market sell fills immediately at the first buy/bid in market depth.
- Buy limit fills when LTP is at or below the limit price.
- Sell limit fills when LTP is at or above the limit price.
- In the master Orders view, a pending limit order can be filled at an admin-entered execution price regardless of the current market price. The admin can also change the fill price of an executed order; this updates the matching trade and recalculates P&L. Each order shows its creation and execution times.

Pages:

- Trade: pulse price, market depth, then order ticket.
- Positions: total P&L, open P&L, closed P&L, open positions, then closed positions.
- Account: funds, margin, brokerage, and ledger entries.

## Notes

- Upstox access tokens can expire. When that happens, update `UPSTOX_ACCESS_TOKEN` in Render and redeploy/restart.
- Orders, users, funds, and trades are stored in Supabase.
- Market data comes from the Render backend, so your Upstox token is not exposed to the browser.
