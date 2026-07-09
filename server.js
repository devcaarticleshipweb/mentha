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
  source: "demo",
  bids: [[927.3, 144], [927.2, 216], [927.1, 360], [927.0, 504], [926.9, 288]],
  asks: [[927.5, 180], [927.6, 288], [927.7, 432], [927.8, 360], [927.9, 540]]
};

let market = { ...demoMarket };
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
    active: Boolean(row.active),
    createdAt: row.created_at
  };
}

function publicOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
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
    side: row.side,
    qty: Number(row.qty),
    price: Number(row.price),
    brokerage: Number(row.brokerage || 0),
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

function roundTick(value) {
  return Math.round(Number(value) / 0.1) * 0.1;
}

function executablePrice(order) {
  if (order.type === "MARKET") return order.side === "BUY" ? market.asks[0][0] : market.bids[0][0];
  if (order.side === "BUY" && market.ltp <= Number(order.price)) return Number(order.price);
  if (order.side === "SELL" && market.ltp >= Number(order.price)) return Number(order.price);
  return null;
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

function calculatePosition(trades) {
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
    realized += pnlPerUnit * closingQty * 360;
    qty += signedQty;

    if (qty === 0) avg = 0;
    if (qty !== 0 && Math.sign(qty) === Math.sign(signedQty)) avg = tradePrice;
  }

  return { qty, avg, realized: realized - brokerage, brokerage };
}

async function marginSnapshot(userId, settings) {
  const [user, trades, openOrders] = await Promise.all([
    db(supabase.from("app_users").select("*").eq("id", userId).single()),
    db(supabase.from("trades").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(500)),
    db(supabase.from("orders").select("*").eq("user_id", userId).eq("status", "OPEN").limit(500))
  ]);
  const pos = calculatePosition(trades);
  const openLots = openOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0);
  const usedMargin = (Math.abs(pos.qty) + openLots) * settings.marginPerLot;
  const available = Number(user.funds || 0) + pos.realized - usedMargin;
  return { user, pos, openLots, usedMargin, available };
}

async function fillOrder(order) {
  const settings = await ensureSettings();
  const fillPrice = executablePrice(order);
  if (!fillPrice) return order;
  const brokerage = Number(settings.brokeragePerLot || 0) * Number(order.qty || 0);
  const now = new Date().toISOString();
  await db(supabase.from("orders").update({
    status: "FILLED",
    fill_price: fillPrice,
    filled_at: now
  }).eq("id", order.id));
  await db(supabase.from("trades").insert({
    order_id: order.id,
    user_id: order.user_id,
    side: order.side,
    qty: order.qty,
    price: fillPrice,
    brokerage
  }));
  return { ...order, status: "FILLED", fill_price: fillPrice, filled_at: now };
}

async function matchOpenOrders() {
  const orders = await db(supabase.from("orders").select("*").eq("status", "OPEN").limit(100));
  for (const order of orders) await fillOrder(order);
}

function normalizeDepth(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => [Number(level.price || 0), Number(level.quantity || level.qty || 0)])
    .filter(([price, qty]) => price > 0 && qty > 0)
    .slice(0, 5);
}

function parseUpstoxQuote(raw) {
  const first = Object.values(raw?.data || {})[0];
  if (!first) throw new Error("No quote returned by Upstox.");
  const bids = normalizeDepth(first.depth?.buy);
  const asks = normalizeDepth(first.depth?.sell);
  return {
    ltp: Number(first.last_price || demoMarket.ltp),
    prevClose: Number(first.ohlc?.close || demoMarket.prevClose),
    open: Number(first.ohlc?.open || demoMarket.open),
    high: Number(first.ohlc?.high || demoMarket.high),
    low: Number(first.ohlc?.low || demoMarket.low),
    volume: Number(first.volume || 0),
    ltq: Number(first.last_quantity || 0),
    bids: bids.length ? bids : demoMarket.bids,
    asks: asks.length ? asks : demoMarket.asks,
    source: "upstox",
    instrumentKey: UPSTOX_INSTRUMENT_KEY,
    timestamp: first.timestamp || new Date().toISOString()
  };
}

async function updateMarket() {
  if (!UPSTOX_ACCESS_TOKEN) {
    market = {
      ...market,
      ltp: roundTick(market.ltp + (Math.random() - 0.48) * 1.4),
      source: "demo"
    };
    await matchOpenOrders();
    return;
  }

  try {
    const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(UPSTOX_INSTRUMENT_KEY)}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`
      }
    });
    if (!response.ok) throw new Error(`Upstox HTTP ${response.status}`);
    market = parseUpstoxQuote(await response.json());
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
}, POLL_MS);
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
    if (req.session.role === "master") {
      const [users, orders, trades] = await Promise.all([
        db(supabase.from("app_users").select("*").order("created_at", { ascending: false })),
        db(supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(500)),
        db(supabase.from("trades").select("*").order("created_at", { ascending: false }).limit(500))
      ]);
      return res.json({
        session: req.session,
        master: { id: "MASTER", name: "Master" },
        users: users.map(publicUser),
        orders: orders.map(publicOrder),
        trades: trades.map(publicTrade),
        settings
      });
    }

    const [user, orders, trades] = await Promise.all([
      db(supabase.from("app_users").select("*").eq("id", req.session.id).single()),
      db(supabase.from("orders").select("*").eq("user_id", req.session.id).order("created_at", { ascending: false }).limit(200)),
      db(supabase.from("trades").select("*").eq("user_id", req.session.id).order("created_at", { ascending: false }).limit(200))
    ]);
    res.json({
      session: req.session,
      master: { id: "MASTER", name: "Master" },
      users: [publicUser(user)],
      orders: orders.map(publicOrder),
      trades: trades.map(publicTrade),
      settings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/market", requireAuth, (req, res) => {
  res.json({ ...market, error: lastMarketError });
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
    if (!/^[A-Z0-9_-]{3,20}$/.test(id)) return res.status(400).json({ error: "Use 3-20 letters, numbers, _ or - for user ID." });
    if (!pin || pin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });
    if (!Number.isFinite(funds) || funds < 0) return res.status(400).json({ error: "Opening funds must be valid." });
    if (id === "MASTER") return res.status(400).json({ error: "That user ID is reserved." });

    const salt = crypto.randomBytes(16).toString("hex");
    const inserted = await db(supabase.from("app_users").insert({
      id,
      name,
      funds,
      pin_salt: salt,
      pin_hash: hashPin(pin, salt),
      active: true
    }).select().single());
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
    const type = String(req.body.type || "").toUpperCase();
    const qty = Math.floor(Number(req.body.qty || 0));
    const price = req.body.price === null || req.body.price === undefined ? null : roundTick(req.body.price);
    if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "Invalid side." });
    if (!["MARKET", "LIMIT"].includes(type)) return res.status(400).json({ error: "Invalid order type." });
    if (!qty || qty < 1) return res.status(400).json({ error: "Enter at least 1 lot." });
    if (type === "LIMIT" && !price) return res.status(400).json({ error: "Enter a valid limit price." });

    const settings = await ensureSettings();
    const margin = await marginSnapshot(req.session.id, settings);
    if (!margin.user.active) return res.status(403).json({ error: "User is blocked." });
    const requiredMargin = settings.marginPerLot * qty;
    const estimatedBrokerage = settings.brokeragePerLot * qty;
    if (margin.available < requiredMargin + estimatedBrokerage) {
      return res.status(400).json({
        error: `Insufficient funds. Required margin plus brokerage is ${requiredMargin + estimatedBrokerage}, available is ${Math.max(0, margin.available).toFixed(2)}.`
      });
    }

    const order = await db(supabase.from("orders").insert({
      user_id: req.session.id,
      side,
      type,
      qty,
      price: type === "MARKET" ? null : price,
      status: "OPEN"
    }).select().single());
    const finalOrder = await fillOrder(order);
    res.status(201).json({ order: publicOrder(finalOrder) });
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
