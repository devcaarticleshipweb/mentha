import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const MASTER_PIN = process.env.MASTER_PIN || "1234";
const UPSTOX_ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const UPSTOX_INSTRUMENT_KEY = process.env.UPSTOX_INSTRUMENT_KEY || "MCX_FO|552719";
const POLL_MS = Number(process.env.MARKET_POLL_MS || 1500);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(__dirname));

const demoMarket = {
  ltp: 927.4,
  prevClose: 921.8,
  open: 922.3,
  high: 931.2,
  low: 918.9,
  volume: 18420,
  ltq: 72,
  avgPrice: 925.9,
  lowerCircuit: 884.9,
  upperCircuit: 958.7,
  netChange: 5.6,
  changePercent: 0.61,
  oi: 458,
  previousOi: 453,
  oiChange: 5,
  source: "demo",
  bids: [[927.3, 144], [927.2, 216], [927.1, 360], [927.0, 504], [926.9, 288]],
  asks: [[927.5, 180], [927.6, 288], [927.7, 432], [927.8, 360], [927.9, 540]]
};

let market = { ...demoMarket };
const markets = new Map();
let contractsCache = [];
let lastMarketError = null;
let cachedSettings = { brokeragePerLot: 0, marginPerLot: 0 };

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createToken(session) {
  const payload = base64url(JSON.stringify({ ...session, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || sign(payload) !== signature) return null;
  const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!session.exp || session.exp < Date.now()) return null;
  return session;
}

function hashPin(pin, salt) {
  return crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    funds: Number(row.funds || 0),
    brokeragePerLot: Number(row.brokerage_per_lot || 0),
    marginPerLot: Number(row.margin_per_lot || 0),
    allowMarketOrders: row.allow_market_orders !== false,
    allowLimitOrders: row.allow_limit_orders !== false,
    active: Boolean(row.active),
    createdAt: row.created_at
  };
}

function publicContract(row) {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    instrumentKey: row.instrument_key,
    lotSize: Number(row.lot_size),
    tickSize: Number(row.tick_size),
    initialPrice: Number(row.initial_price),
    previousClose: Number(row.previous_close),
    active: Boolean(row.active)
  };
}

function quoteFor(contract) {
  if (contract.id === "MENTHAOIL-OCT26") return markets.get(contract.id) || market;
  if (markets.has(contract.id)) return markets.get(contract.id);
  const ltp = Number(contract.initial_price);
  const prevClose = Number(contract.previous_close);
  const tick = Number(contract.tick_size);
  return {
    ...demoMarket, ltp, prevClose, open: ltp, high: ltp, low: ltp,
    avgPrice: ltp, netChange: ltp - prevClose,
    changePercent: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
    bids: demoMarket.bids.map(([, qty, count], index) => [ltp - tick * (index + 1), qty, count || 1]),
    asks: demoMarket.asks.map(([, qty, count], index) => [ltp + tick * (index + 1), qty, count || 1]),
    source: "demo", instrumentKey: contract.instrumentKey
  };
}

function publicOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
    contractId: row.contract_id,
    side: row.side,
    type: row.type,
    qty: Number(row.qty),
    price: row.price === null ? null : Number(row.price),
    status: row.status,
    fillPrice: row.fill_price === null ? null : Number(row.fill_price),
    createdAt: row.created_at,
    filledAt: row.filled_at,
    cancelledAt: row.cancelled_at
  };
}

function publicTrade(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    userId: row.user_id,
    contractId: row.contract_id,
    side: row.side,
    qty: Number(row.qty),
    price: Number(row.price),
    brokerage: Number(row.brokerage || 0),
    time: row.created_at
  };
}

function publicLedger(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amount: Number(row.amount || 0),
    note: row.note || "",
    time: row.created_at
  };
}

function publicSettings(row = {}) {
  return {
    brokeragePerLot: Number(row.brokerage_per_lot || 0),
    marginPerLot: Number(row.margin_per_lot || 0)
  };
}

async function db(query) {
  const result = await query;
  if (result.error) throw result.error;
  return result.data;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const session = readToken(header.replace(/^Bearer\s+/i, ""));
  if (!session) return res.status(401).json({ error: "Login required." });
  req.session = session;
  next();
}

function requireMaster(req, res, next) {
  if (req.session?.role !== "master") return res.status(403).json({ error: "Master access required." });
  next();
}

function roundTick(value, tick = 0.1) {
  return Math.round(Number(value) / tick) * tick;
}

function validFillPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price > 9999999999.99) return null;
  return Math.round(price * 100) / 100 || null;
}

function executablePrice(order, quote) {
  if (order.type === "MARKET") return order.side === "BUY" ? quote.asks[0][0] : quote.bids[0][0];
  if (order.side === "BUY" && quote.ltp <= Number(order.price)) return Number(order.price);
  if (order.side === "SELL" && quote.ltp >= Number(order.price)) return Number(order.price);
  return null;
}

async function loadContracts() {
  contractsCache = (await db(supabase.from("contracts").select("*").order("created_at", { ascending: true }))).map((row) => {
    const contract = publicContract(row);
    if (contract.id === "MENTHAOIL-OCT26") contract.instrumentKey = UPSTOX_INSTRUMENT_KEY;
    return contract;
  });
  return contractsCache;
}

async function ensureSettings() {
  const row = await db(supabase.from("app_settings").select("*").eq("id", 1).maybeSingle());
  if (row) {
    cachedSettings = publicSettings(row);
    return cachedSettings;
  }
  const inserted = await db(supabase.from("app_settings").insert({ id: 1 }).select().single());
  cachedSettings = publicSettings(inserted);
  return cachedSettings;
}

function calculatePosition(trades, lotSize = 360) {
  let qty = 0;
  let avg = 0;
  let realized = 0;
  let brokerage = 0;

  for (const trade of trades.slice().reverse()) {
    const tradeQty = Number(trade.qty || 0);
    const tradePrice = Number(trade.price || 0);
    const signedQty = trade.side === "BUY" ? tradeQty : -tradeQty;
    brokerage += Number(trade.brokerage || 0);

    if (qty === 0 || Math.sign(qty) === Math.sign(signedQty)) {
      avg = (Math.abs(qty) * avg + Math.abs(signedQty) * tradePrice) / (Math.abs(qty) + Math.abs(signedQty));
      qty += signedQty;
      continue;
    }

    const closingQty = Math.min(Math.abs(qty), Math.abs(signedQty));
    const pnlPerUnit = qty > 0 ? tradePrice - avg : avg - tradePrice;
    realized += pnlPerUnit * closingQty * lotSize;
    qty += signedQty;

    if (qty === 0) avg = 0;
    if (qty !== 0 && Math.sign(qty) === Math.sign(signedQty)) avg = tradePrice;
  }

  return { qty, avg, realized: realized - brokerage, brokerage };
}

async function marginSnapshot(userId) {
  const [user, trades, openOrders, contracts] = await Promise.all([
    db(supabase.from("app_users").select("*").eq("id", userId).single()),
    db(supabase.from("trades").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(500)),
    db(supabase.from("orders").select("*").eq("user_id", userId).eq("status", "OPEN").limit(500)),
    contractsCache.length ? Promise.resolve(contractsCache) : loadContracts()
  ]);
  const positions = contracts.map((contract) => calculatePosition(trades.filter((trade) => trade.contract_id === contract.id), contract.lotSize));
  const pos = { realized: positions.reduce((sum, position) => sum + position.realized, 0) };
  const openLots = openOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0);
  const heldLots = positions.reduce((sum, position) => sum + Math.abs(position.qty), 0);
  const usedMargin = (heldLots + openLots) * Number(user.margin_per_lot || 0);
  const available = Number(user.funds || 0) + pos.realized - usedMargin;
  return { user, pos, openLots, usedMargin, available };
}

async function fillOrder(order, forcedPrice = null) {
  const contract = contractsCache.find((item) => item.id === order.contract_id);
  if (!contract && forcedPrice === null) return order;
  const fillPrice = forcedPrice ?? executablePrice(order, quoteFor(contract));
  if (!fillPrice) return order;
  const user = await db(supabase.from("app_users").select("brokerage_per_lot").eq("id", order.user_id).single());
  const brokerage = Number(user.brokerage_per_lot || 0) * Number(order.qty || 0);
  const now = new Date().toISOString();
  const updated = await db(supabase.from("orders").update({
    status: "FILLED",
    fill_price: fillPrice,
    filled_at: now
  }).eq("id", order.id).eq("status", "OPEN").select().maybeSingle());
  if (!updated) return null;
  await db(supabase.from("trades").insert({
    order_id: order.id,
    user_id: order.user_id,
    contract_id: order.contract_id,
    side: order.side,
    qty: order.qty,
    price: fillPrice,
    brokerage,
    created_at: now
  }));
  return updated;
}

async function matchOpenOrders() {
  const orders = await db(supabase.from("orders").select("*").eq("status", "OPEN").limit(100));
  for (const order of orders) await fillOrder(order);
}

function normalizeDepth(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => [Number(level.price || 0), Number(level.quantity || level.qty || 0), Number(level.orders || level.order_count || 0)])
    .filter(([price, qty]) => price > 0 && qty > 0)
    .slice(0, 5);
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function parseUpstoxQuote(first, contract) {
  if (!first) throw new Error("No quote returned by Upstox.");
  const fallback = quoteFor(contract);
  const bids = normalizeDepth(first.depth?.buy);
  const asks = normalizeDepth(first.depth?.sell);
  const feed = first.eFeedDetails || first.extended_feed_details || {};
  const ltpc = first.ltpc || {};
  const ltp = firstNumber(first.last_price, first.ltp, ltpc.ltp, fallback.ltp);
  const prevClose = firstNumber(first.prev_close_price, first.cp, first.close_price, first.previous_close, ltpc.cp, first.ohlc?.close, fallback.prevClose);
  const netChange = firstNumber(first.net_change, first.change, first.absolute_change, ltp - prevClose);
  const changePercent = firstNumber(first.change_percent, first.percent_change, first.pchange, prevClose ? (netChange / prevClose) * 100 : 0);
  const oi = firstNumber(first.oi, first.open_interest, feed.oi, 0);
  const previousOi = firstNumber(first.previous_oi, first.prev_oi, feed.poi, feed.previous_oi, 0);
  const oiChange = firstNumber(first.oi_change, first.oi_chg, first.oi_change_value, feed.oi_chg, feed.oichange, previousOi ? oi - previousOi : 0);
  const open = firstNumber(first.ohlc?.open, first.open, fallback.open);
  const high = firstNumber(first.ohlc?.high, first.high, fallback.high);
  const low = firstNumber(first.ohlc?.low, first.low, fallback.low);
  return {
    ltp,
    prevClose,
    netChange,
    changePercent,
    open,
    high,
    low,
    lowerCircuit: firstNumber(first.lower_circuit_limit, first.lower_circuit, first.lc, feed.lc, feed.lower_circuit_limit, fallback.lowerCircuit),
    upperCircuit: firstNumber(first.upper_circuit_limit, first.upper_circuit, first.uc, feed.uc, feed.upper_circuit_limit, fallback.upperCircuit),
    volume: firstNumber(first.volume, first.vtt, feed.vtt, 0),
    avgPrice: firstNumber(first.average_price, first.avg_price, first.average_traded_price, first.atp, feed.atp, (open + high + low + ltp) / 4),
    ltq: firstNumber(first.ltq, first.last_quantity, first.last_traded_quantity, ltpc.ltq, feed.ltq, 0),
    totalBuyQty: firstNumber(first.total_buy_quantity, first.tbq, 0),
    totalSellQty: firstNumber(first.total_sell_quantity, first.tsq, 0),
    oi,
    previousOi,
    oiChange,
    oiDayHigh: firstNumber(first.oi_day_high, feed.oi_day_high, 0),
    oiDayLow: firstNumber(first.oi_day_low, feed.oi_day_low, 0),
    bids: bids.length ? bids : fallback.bids,
    asks: asks.length ? asks : fallback.asks,
    source: "upstox",
    instrumentKey: contract.instrumentKey,
    lastTradeTime: Number(first.last_trade_time ?? first.ltt ?? 0),
    timestamp: first.timestamp || first.last_trade_time || new Date().toISOString()
  };
}

async function updateMarket() {
  const contracts = await loadContracts();
  if (!UPSTOX_ACCESS_TOKEN) {
    for (const contract of contracts) {
      const current = quoteFor(contract);
      const ltp = Math.max(Number(contract.tickSize), roundTick(current.ltp + (Math.random() - 0.48) * Number(contract.tickSize) * 14, Number(contract.tickSize)));
      const next = { ...current, ltp, netChange: ltp - current.prevClose,
        changePercent: current.prevClose ? ((ltp - current.prevClose) / current.prevClose) * 100 : 0,
        bids: current.bids.map(([, qty, count], index) => [roundTick(ltp - (index + 1) * contract.tickSize, contract.tickSize), qty, count]),
        asks: current.asks.map(([, qty, count], index) => [roundTick(ltp + (index + 1) * contract.tickSize, contract.tickSize), qty, count]),
        source: "demo" };
      markets.set(contract.id, next);
      if (contract.id === "MENTHAOIL-OCT26") market = next;
    }
    await matchOpenOrders();
    return;
  }

  try {
    const keys = contracts.map((contract) => contract.instrumentKey);
    if (!keys.length) return;
    const url = `https://api.upstox.com/v3/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(","))}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`
      }
    });
    if (!response.ok) throw new Error(`Upstox HTTP ${response.status}`);
    const data = (await response.json()).data || {};
    for (const contract of contracts) {
      const quote = Object.values(data).find((item) => item.instrument_token === contract.instrumentKey);
      if (!quote) continue;
      const next = parseUpstoxQuote(quote, contract);
      markets.set(contract.id, next);
      if (contract.id === "MENTHAOIL-OCT26") market = next;
    }
    lastMarketError = null;
    await matchOpenOrders();
  } catch (error) {
    lastMarketError = error.message;
  }
}

setInterval(() => {
  updateMarket().catch((error) => {
    lastMarketError = error.message;
  });
}, Math.max(POLL_MS, 5000));
updateMarket().catch(() => {});
ensureSettings().catch(() => {});

app.post("/api/login", async (req, res) => {
  try {
    const id = String(req.body.id || "").trim().toUpperCase();
    const pin = String(req.body.pin || "").trim();
    if (!id || !pin) return res.status(400).json({ error: "Login ID and PIN are required." });

    if (id === "MASTER") {
      if (pin !== MASTER_PIN) return res.status(401).json({ error: "Invalid login." });
      const session = { role: "master", id: "MASTER", name: "Master" };
      return res.json({ token: createToken(session), session });
    }

    const user = await db(supabase.from("app_users").select("*").eq("id", id).maybeSingle());
    if (!user || !user.active || hashPin(pin, user.pin_salt) !== user.pin_hash) {
      return res.status(401).json({ error: "Invalid login or blocked user." });
    }

    const session = { role: "user", id: user.id, name: user.name };
    res.json({ token: createToken(session), session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const settings = await ensureSettings();
    const contracts = await loadContracts();
    if (req.session.role === "master") {
      const [users, orders, trades, ledger] = await Promise.all([
        db(supabase.from("app_users").select("*").order("created_at", { ascending: false })),
        db(supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(500)),
        db(supabase.from("trades").select("*").order("created_at", { ascending: false }).limit(500)),
        db(supabase.from("fund_ledger").select("*").order("created_at", { ascending: false }).limit(500))
      ]);
      return res.json({
        session: req.session,
        master: { id: "MASTER", name: "Master" },
        users: users.map(publicUser),
        orders: orders.map(publicOrder),
        trades: trades.map(publicTrade),
        ledger: ledger.map(publicLedger),
        contracts,
        settings
      });
    }

    const [user, orders, trades, ledger] = await Promise.all([
      db(supabase.from("app_users").select("*").eq("id", req.session.id).single()),
      db(supabase.from("orders").select("*").eq("user_id", req.session.id).order("created_at", { ascending: false }).limit(200)),
      db(supabase.from("trades").select("*").eq("user_id", req.session.id).order("created_at", { ascending: false }).limit(200)),
      db(supabase.from("fund_ledger").select("*").eq("user_id", req.session.id).order("created_at", { ascending: false }).limit(200))
    ]);
    res.json({
      session: req.session,
      master: { id: "MASTER", name: "Master" },
      users: [publicUser(user)],
      orders: orders.map(publicOrder),
      trades: trades.map(publicTrade),
      ledger: ledger.map(publicLedger),
      contracts,
      settings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/market", requireAuth, (req, res) => {
  res.json({ ...market, error: lastMarketError });
});

app.get("/api/markets", requireAuth, async (req, res) => {
  try {
    const contracts = contractsCache.length ? contractsCache : await loadContracts();
    res.json({ markets: Object.fromEntries(contracts.map((contract) => [contract.id, quoteFor(contract)])), error: lastMarketError });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/contracts", requireAuth, requireMaster, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().toUpperCase();
    const subtitle = String(req.body.subtitle || "").trim().toUpperCase();
    const instrumentKey = String(req.body.instrumentKey || "").trim();
    const lotSize = Number(req.body.lotSize);
    const tickSize = Number(req.body.tickSize);
    const initialPrice = Number(req.body.initialPrice);
    const previousClose = Number(req.body.previousClose);
    if (!name || name.length > 50 || !subtitle || subtitle.length > 60) return res.status(400).json({ error: "Enter a contract name and exchange/expiry." });
    if (!instrumentKey || instrumentKey.length > 150) return res.status(400).json({ error: "Enter a valid Upstox instrument key." });
    if (!Number.isInteger(lotSize) || lotSize < 1 || !Number.isFinite(tickSize) || tickSize < 0.01 || Math.abs(tickSize * 100 - Math.round(tickSize * 100)) > 1e-8 || !Number.isFinite(initialPrice) || initialPrice <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) return res.status(400).json({ error: "Enter valid lot size, tick size and prices." });
    const row = await db(supabase.from("contracts").insert({
      id: crypto.randomUUID(), name, subtitle, instrument_key: instrumentKey,
      lot_size: lotSize, tick_size: tickSize, initial_price: initialPrice,
      previous_close: previousClose, active: true
    }).select().single());
    await loadContracts();
    res.status(201).json({ contract: publicContract(row) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/contracts/:id", requireAuth, requireMaster, async (req, res) => {
  try {
    if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "Active status required." });
    const row = await db(supabase.from("contracts").update({ active: req.body.active }).eq("id", req.params.id).select().single());
    await loadContracts();
    res.json({ contract: publicContract(row) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/settings", requireAuth, requireMaster, async (req, res) => {
  try {
    const brokeragePerLot = Number(req.body.brokeragePerLot ?? cachedSettings.brokeragePerLot);
    const marginPerLot = Number(req.body.marginPerLot ?? cachedSettings.marginPerLot);
    if (!Number.isFinite(brokeragePerLot) || brokeragePerLot < 0) return res.status(400).json({ error: "Brokerage per lot must be zero or more." });
    if (!Number.isFinite(marginPerLot) || marginPerLot < 0) return res.status(400).json({ error: "Margin per lot must be zero or more." });
    const row = await db(supabase.from("app_settings").upsert({
      id: 1,
      brokerage_per_lot: brokeragePerLot,
      margin_per_lot: marginPerLot,
      updated_at: new Date().toISOString()
    }).select().single());
    cachedSettings = publicSettings(row);
    res.json({ settings: cachedSettings });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/users", requireAuth, requireMaster, async (req, res) => {
  try {
    const id = String(req.body.id || "").trim().toUpperCase();
    const pin = String(req.body.pin || "").trim();
    const name = String(req.body.name || id).trim();
    const funds = Number(req.body.funds || 0);
    const brokeragePerLot = Number(req.body.brokeragePerLot ?? 0);
    const marginPerLot = Number(req.body.marginPerLot ?? 0);
    const allowMarketOrders = req.body.allowMarketOrders ?? true;
    const allowLimitOrders = req.body.allowLimitOrders ?? true;
    if (!/^[A-Z0-9_-]{3,20}$/.test(id)) return res.status(400).json({ error: "Use 3-20 letters, numbers, _ or - for user ID." });
    if (!pin || pin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });
    if (!Number.isFinite(funds) || funds < 0) return res.status(400).json({ error: "Opening funds must be valid." });
    if (!Number.isFinite(brokeragePerLot) || brokeragePerLot < 0) return res.status(400).json({ error: "Brokerage per lot must be zero or more." });
    if (!Number.isFinite(marginPerLot) || marginPerLot < 0) return res.status(400).json({ error: "Margin per lot must be zero or more." });
    if (typeof allowMarketOrders !== "boolean" || typeof allowLimitOrders !== "boolean") return res.status(400).json({ error: "Order permissions must be true or false." });
    if (id === "MASTER") return res.status(400).json({ error: "That user ID is reserved." });

    const salt = crypto.randomBytes(16).toString("hex");
    const inserted = await db(supabase.from("app_users").insert({
      id,
      name,
      funds,
      brokerage_per_lot: brokeragePerLot,
      margin_per_lot: marginPerLot,
      allow_market_orders: allowMarketOrders,
      allow_limit_orders: allowLimitOrders,
      pin_salt: salt,
      pin_hash: hashPin(pin, salt),
      active: true
    }).select().single());
    await db(supabase.from("fund_ledger").insert({
      user_id: id,
      type: "OPENING",
      amount: funds,
      note: "Opening balance"
    }));
    res.status(201).json({ user: publicUser(inserted) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/users/:id", requireAuth, requireMaster, async (req, res) => {
  try {
    const id = String(req.params.id || "").toUpperCase();
    const updates = {};
    if (typeof req.body.active === "boolean") updates.active = req.body.active;
    if (req.body.name) updates.name = String(req.body.name).trim();
    if (req.body.brokeragePerLot !== undefined) {
      updates.brokerage_per_lot = Number(req.body.brokeragePerLot);
      if (!Number.isFinite(updates.brokerage_per_lot) || updates.brokerage_per_lot < 0) return res.status(400).json({ error: "Brokerage per lot must be zero or more." });
    }
    if (req.body.marginPerLot !== undefined) {
      updates.margin_per_lot = Number(req.body.marginPerLot);
      if (!Number.isFinite(updates.margin_per_lot) || updates.margin_per_lot < 0) return res.status(400).json({ error: "Margin per lot must be zero or more." });
    }
    if (req.body.allowMarketOrders !== undefined) {
      if (typeof req.body.allowMarketOrders !== "boolean") return res.status(400).json({ error: "Market order permission must be true or false." });
      updates.allow_market_orders = req.body.allowMarketOrders;
    }
    if (req.body.allowLimitOrders !== undefined) {
      if (typeof req.body.allowLimitOrders !== "boolean") return res.status(400).json({ error: "Limit order permission must be true or false." });
      updates.allow_limit_orders = req.body.allowLimitOrders;
    }
    const user = await db(supabase.from("app_users").update(updates).eq("id", id).select().single());
    res.json({ user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/users/:id/funds", requireAuth, requireMaster, async (req, res) => {
  try {
    const id = String(req.params.id || "").toUpperCase();
    const amount = Number(req.body.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "Enter a valid amount." });
    const user = await db(supabase.from("app_users").select("*").eq("id", id).single());
    const updated = await db(supabase.from("app_users").update({ funds: Number(user.funds) + amount }).eq("id", id).select().single());
    await db(supabase.from("fund_ledger").insert({
      user_id: id,
      type: amount > 0 ? "ADD" : "REMOVE",
      amount,
      note: amount > 0 ? "Funds added by master" : "Funds removed by master"
    }));
    res.json({ user: publicUser(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/users/:id", requireAuth, requireMaster, async (req, res) => {
  try {
    const id = String(req.params.id || "").toUpperCase();
    await db(supabase.from("orders").update({ status: "CANCELLED", cancelled_at: new Date().toISOString() }).eq("user_id", id).eq("status", "OPEN"));
    await db(supabase.from("app_users").delete().eq("id", id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/orders", requireAuth, async (req, res) => {
  try {
    if (req.session.role !== "user") return res.status(403).json({ error: "Login as a trader to place orders." });
    const side = String(req.body.side || "").toUpperCase();
    const contractId = String(req.body.contractId || "MENTHAOIL-OCT26");
    const contract = (contractsCache.length ? contractsCache : await loadContracts()).find((item) => item.id === contractId && item.active);
    if (!contract) return res.status(400).json({ error: "Contract is not available." });
    const type = String(req.body.type || "").toUpperCase();
    const qty = Math.floor(Number(req.body.qty || 0));
    const price = req.body.price === null || req.body.price === undefined ? null : roundTick(req.body.price, contract.tickSize);
    if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "Invalid side." });
    if (!["MARKET", "LIMIT"].includes(type)) return res.status(400).json({ error: "Invalid order type." });
    if (!qty || qty < 1) return res.status(400).json({ error: "Enter at least 1 lot." });
    if (type === "LIMIT" && !price) return res.status(400).json({ error: "Enter a valid limit price." });

    const margin = await marginSnapshot(req.session.id);
    if (!margin.user.active) return res.status(403).json({ error: "User is blocked." });
    if (type === "MARKET" && !margin.user.allow_market_orders) return res.status(403).json({ error: "Market orders are disabled for this trader." });
    if (type === "LIMIT" && !margin.user.allow_limit_orders) return res.status(403).json({ error: "Limit orders are disabled for this trader." });
    const requiredMargin = Number(margin.user.margin_per_lot || 0) * qty;
    const estimatedBrokerage = Number(margin.user.brokerage_per_lot || 0) * qty;
    if (margin.available < requiredMargin + estimatedBrokerage) {
      return res.status(400).json({
        error: `Insufficient funds. Required margin plus brokerage is ${requiredMargin + estimatedBrokerage}, available is ${Math.max(0, margin.available).toFixed(2)}.`
      });
    }

    const order = await db(supabase.from("orders").insert({
      user_id: req.session.id,
      contract_id: contractId,
      side,
      type,
      qty,
      price: type === "MARKET" ? null : price,
      status: "OPEN"
    }).select().single());
    const finalOrder = await fillOrder(order) || await db(supabase.from("orders").select("*").eq("id", order.id).single());
    res.status(201).json({ order: publicOrder(finalOrder) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/orders/:id/fill", requireAuth, requireMaster, async (req, res) => {
  try {
    const price = validFillPrice(req.body.price);
    if (price === null) return res.status(400).json({ error: "Enter a valid fill price above zero." });
    const id = String(req.params.id || "");
    const order = await db(supabase.from("orders").select("*").eq("id", id).single());
    if (order.type !== "LIMIT" || order.status !== "OPEN") return res.status(409).json({ error: "Only pending limit orders can be filled manually." });
    const filled = await fillOrder(order, price);
    if (!filled) return res.status(409).json({ error: "This order is no longer pending." });
    res.json({ order: publicOrder(filled) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/orders/:id/fill-price", requireAuth, requireMaster, async (req, res) => {
  try {
    const price = validFillPrice(req.body.price);
    if (price === null) return res.status(400).json({ error: "Enter a valid fill price above zero." });
    const id = String(req.params.id || "");
    const order = await db(supabase.from("orders").select("*").eq("id", id).single());
    if (order.status !== "FILLED") return res.status(409).json({ error: "Only filled orders can have their fill price changed." });
    const trade = await db(supabase.from("trades").select("id").eq("order_id", id).maybeSingle());
    if (!trade) return res.status(409).json({ error: "The trade for this order is missing." });
    const updated = await db(supabase.from("orders").update({ fill_price: price }).eq("id", id).eq("status", "FILLED").select().maybeSingle());
    if (!updated) return res.status(409).json({ error: "This order is no longer filled." });
    await db(supabase.from("trades").update({ price }).eq("order_id", id));
    res.json({ order: publicOrder(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/orders/:id/cancel", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const order = await db(supabase.from("orders").select("*").eq("id", id).single());
    if (req.session.role !== "master" && order.user_id !== req.session.id) {
      return res.status(403).json({ error: "Cannot cancel this order." });
    }
    if (order.status === "FILLED" && req.session.role !== "master") {
      return res.status(400).json({ error: "Filled orders cannot be cancelled by trader." });
    }
    if (order.status === "FILLED" && req.session.role === "master") {
      await db(supabase.from("trades").delete().eq("order_id", id));
    }
    const updated = await db(supabase.from("orders").update({
      status: "CANCELLED",
      cancelled_at: new Date().toISOString()
    }).eq("id", id).select().single());
    res.json({ order: publicOrder(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, source: market.source, instrumentKey: UPSTOX_INSTRUMENT_KEY, marketError: lastMarketError });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`MENTHA Paper Trade running on port ${PORT}`);
});
