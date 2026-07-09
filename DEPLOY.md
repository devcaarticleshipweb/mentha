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

If you already deployed an older version, run `supabase-schema.sql` again. It safely adds the new brokerage, margin, and settings fields.
The latest schema also adds `fund_ledger`, used for opening balance and fund addition/removal history.

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

## 5. Configure Trading Rules

Login as master and open Admin.

Set:

- Brokerage per lot: fixed rupee amount charged on every filled lot.
- Margin per lot: rupee margin required for each lot before an order is accepted.

Order behavior:

- Market buy fills immediately at the first sell/ask in market depth.
- Market sell fills immediately at the first buy/bid in market depth.
- Buy limit fills when LTP is at or below the limit price.
- Sell limit fills when LTP is at or above the limit price.

Pages:

- Trade: pulse price, market depth, then order ticket.
- Positions: total P&L, open P&L, closed P&L, open positions, then closed positions.
- Account: funds, margin, brokerage, and ledger entries.

## Notes

- Upstox access tokens can expire. When that happens, update `UPSTOX_ACCESS_TOKEN` in Render and redeploy/restart.
- Orders, users, funds, and trades are stored in Supabase.
- Market data comes from the Render backend, so your Upstox token is not exposed to the browser.
