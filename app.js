const SCRIP = {
  symbol: "MCX MENTHAOIL",
  lotSize: 360,
  tickSize: 0.1,
  expiry: "Current Contract"
};

const DEFAULT_CONTRACT_ID = "MENTHAOIL-OCT26";
const defaultContract = {
  id: DEFAULT_CONTRACT_ID, name: "MENTHAOIL FUT", subtitle: "MCX 30 OCT 26",
  instrumentKey: "MCX_FO|552719", lotSize: 360, tickSize: 0.1,
  initialPrice: 927.4, previousClose: 921.8, active: true
};

const TOKEN_KEY = "mentha-session-token";

const seedState = {
  session: null,
  master: { id: "MASTER", name: "Master" },
  users: [
    { id: "TRADER1", pin: "1111", name: "Trader 1", funds: 500000, brokeragePerLot: 0, marginPerLot: 0, allowMarketOrders: true, allowLimitOrders: true, active: true, createdAt: new Date().toISOString() }
  ],
  orders: [],
  trades: [],
  ledger: [],
  contracts: [defaultContract],
  settings: { brokeragePerLot: 0, marginPerLot: 0 }
};

let state = structuredClone(seedState);
let market = makeInitialMarket();
let markets = { [DEFAULT_CONTRACT_ID]: market };
let selectedContractId = DEFAULT_CONTRACT_ID;
let activeView = "watchlist";
let activeSide = "BUY";
let marketDetailsExpanded = false;
let toastTimer = null;
let refreshTimer = null;
let localMarketTimer = null;

function apiBase() {
  return window.MENTHA_API_BASE || "";
}

function token() {
  return localStorage.getItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  if (window.MENTHA_LOCAL_ONLY) return localApi(path, options);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${apiBase()}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed ${response.status}`);
  return data;
}

function localStore() {
  try {
    const db = JSON.parse(localStorage.getItem("mentha-local-db") || "null") || structuredClone(seedState);
    db.contracts ||= structuredClone(seedState.contracts);
    for (const order of db.orders) order.contractId ||= DEFAULT_CONTRACT_ID;
    for (const trade of db.trades) trade.contractId ||= DEFAULT_CONTRACT_ID;
    for (const user of db.users) {
      user.brokeragePerLot ??= Number(db.settings?.brokeragePerLot || 0);
      user.marginPerLot ??= Number(db.settings?.marginPerLot || 0);
      user.allowMarketOrders ??= true;
      user.allowLimitOrders ??= true;
    }
    return db;
  } catch {
    return structuredClone(seedState);
  }
}

function contractFor(id = selectedContractId) {
  return state.contracts.find((contract) => contract.id === id) || defaultContract;
}

function initialQuote(contract) {
  if (contract.id === DEFAULT_CONTRACT_ID) return makeInitialMarket();
  const quote = makeInitialMarket();
  const ltp = Number(contract.initialPrice);
  const prevClose = Number(contract.previousClose);
  const tick = Number(contract.tickSize);
  return { ...quote, ltp, prevClose, open: ltp, high: ltp, low: ltp, avgPrice: ltp,
    netChange: ltp - prevClose, changePercent: prevClose ? ((ltp - prevClose) / prevClose) * 100 : 0,
    bids: quote.bids.map(([, qty, count], index) => [ltp - (index + 1) * tick, qty, count]),
    asks: quote.asks.map(([, qty, count], index) => [ltp + (index + 1) * tick, qty, count]) };
}

function quoteFor(id = selectedContractId) {
  return markets[id] || initialQuote(contractFor(id));
}

function saveLocalStore(db) {
  localStorage.setItem("mentha-local-db", JSON.stringify(db));
}

function localSession() {
  try {
    return JSON.parse(localStorage.getItem("mentha-local-session") || "null");
  } catch {
    return null;
  }
}

function saveLocalSession(session) {
  if (session) localStorage.setItem("mentha-local-session", JSON.stringify(session));
  else localStorage.removeItem("mentha-local-session");
}

function localId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

function localExecutablePrice(order) {
  const quote = quoteFor(order.contractId);
  if (order.type === "MARKET") return order.side === "BUY" ? quote.asks[0][0] : quote.bids[0][0];
  if (order.side === "BUY" && Number(order.price) >= quote.asks[0][0]) return quote.asks[0][0];
  if (order.side === "SELL" && Number(order.price) <= quote.bids[0][0]) return quote.bids[0][0];
  return null;
}

function localFillOrder(db, order, forcedPrice = null) {
  if (order.status !== "OPEN") return;
  const fillPrice = forcedPrice ?? localExecutablePrice(order);
  if (!fillPrice) return;
  const user = db.users.find((item) => item.id === order.userId);
  const brokerage = Number(user?.brokeragePerLot || 0) * Number(order.qty || 0);
  order.status = "FILLED";
  order.fillPrice = fillPrice;
  order.filledAt = new Date().toISOString();
  db.trades.push({
    id: localId("TRD"),
    orderId: order.id,
    userId: order.userId,
    contractId: order.contractId,
    side: order.side,
    qty: order.qty,
    price: fillPrice,
    brokerage,
    time: new Date().toISOString()
  });
}

function localMatchOpenOrders() {
  const db = localStore();
  let changed = false;
  for (const order of db.orders.filter((item) => item.status === "OPEN")) {
    const before = order.status;
    localFillOrder(db, order);
    if (order.status !== before) changed = true;
  }
  if (changed) saveLocalStore(db);
}

async function localApi(path, options = {}) {
  const db = localStore();
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const session = localSession();

  if (path === "/api/login" && method === "POST") {
    const id = String(body.id || "").trim().toUpperCase();
    const pin = String(body.pin || "").trim();
    if (id === "MASTER" && pin === "1234") {
      const masterSession = { role: "master", id: "MASTER", name: "Master" };
      saveLocalSession(masterSession);
      return { token: "local", session: masterSession };
    }
    const user = db.users.find((u) => u.id === id && u.pin === pin && u.active);
    if (!user) throw new Error("Invalid login or blocked user.");
    const userSession = { role: "user", id: user.id, name: user.name };
    saveLocalSession(userSession);
    return { token: "local", session: userSession };
  }

  if (!session) throw new Error("Login required.");

  if (path === "/api/state") {
    if (session.role === "master") return { ...db, session, master: seedState.master };
    return {
      session,
      master: seedState.master,
      users: db.users.filter((u) => u.id === session.id),
      orders: db.orders.filter((o) => o.userId === session.id),
      trades: db.trades.filter((t) => t.userId === session.id),
      ledger: (db.ledger || []).filter((item) => item.userId === session.id),
      contracts: db.contracts
    };
  }

  if (path === "/api/market") return { ...market, source: "demo" };
  if (path === "/api/markets") return { markets: Object.fromEntries(db.contracts.map((contract) => [contract.id, quoteFor(contract.id)])) };

  if (path === "/api/contracts" && method === "POST") {
    if (session.role !== "master") throw new Error("Master access required.");
    const name = String(body.name || "").trim().toUpperCase();
    const subtitle = String(body.subtitle || "").trim().toUpperCase();
    const instrumentKey = String(body.instrumentKey || "").trim();
    const lotSize = Number(body.lotSize);
    const tickSize = Number(body.tickSize);
    const initialPrice = Number(body.initialPrice);
    const previousClose = Number(body.previousClose);
    if (!name || !subtitle || !instrumentKey) throw new Error("Enter contract name, exchange/expiry and instrument key.");
    if (db.contracts.some((item) => item.instrumentKey === instrumentKey)) throw new Error("Instrument key already exists.");
    if (!Number.isInteger(lotSize) || lotSize < 1 || !Number.isFinite(tickSize) || tickSize < 0.01 || Math.abs(tickSize * 100 - Math.round(tickSize * 100)) > 1e-8 || !Number.isFinite(initialPrice) || initialPrice <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) throw new Error("Enter valid lot size, tick size and prices.");
    const contract = { id: localId("CONTRACT"), name, subtitle, instrumentKey, lotSize, tickSize, initialPrice, previousClose, active: true };
    db.contracts.push(contract);
    markets[contract.id] = initialQuote(contract);
    saveLocalStore(db);
    return { contract };
  }

  const contractPatch = path.match(/^\/api\/contracts\/([^/]+)$/);
  if (contractPatch && method === "PATCH") {
    if (session.role !== "master") throw new Error("Master access required.");
    const contract = db.contracts.find((item) => item.id === decodeURIComponent(contractPatch[1]));
    if (!contract) throw new Error("Contract not found.");
    if (typeof body.active !== "boolean") throw new Error("Active status required.");
    contract.active = body.active;
    saveLocalStore(db);
    return { contract };
  }

  if (path === "/api/settings" && method === "PATCH") {
    if (session.role !== "master") throw new Error("Master access required.");
    db.settings = {
      brokeragePerLot: Math.max(0, Number(body.brokeragePerLot || 0)),
      marginPerLot: Math.max(0, Number(body.marginPerLot || 0))
    };
    saveLocalStore(db);
    return { settings: db.settings };
  }

  if (path === "/api/users" && method === "POST") {
    if (session.role !== "master") throw new Error("Master access required.");
    const id = String(body.id || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(id)) throw new Error("Use 3-20 letters, numbers, _ or - for user ID.");
    if (db.users.some((u) => u.id === id) || id === "MASTER") throw new Error("That user ID already exists.");
    if (String(body.pin || "").trim().length < 4) throw new Error("PIN must be at least 4 digits.");
    if (!Number.isFinite(Number(body.funds)) || Number(body.funds) < 0) throw new Error("Opening funds must be valid.");
    if (!Number.isFinite(Number(body.brokeragePerLot)) || Number(body.brokeragePerLot) < 0) throw new Error("Brokerage per lot must be zero or more.");
    if (!Number.isFinite(Number(body.marginPerLot)) || Number(body.marginPerLot) < 0) throw new Error("Margin per lot must be zero or more.");
    if (body.allowMarketOrders !== undefined && typeof body.allowMarketOrders !== "boolean") throw new Error("Market order permission must be true or false.");
    if (body.allowLimitOrders !== undefined && typeof body.allowLimitOrders !== "boolean") throw new Error("Limit order permission must be true or false.");
    db.users.push({
      id,
      pin: String(body.pin || "").trim(),
      name: String(body.name || id).trim(),
      funds: Number(body.funds || 0),
      brokeragePerLot: Number(body.brokeragePerLot || 0),
      marginPerLot: Number(body.marginPerLot || 0),
      allowMarketOrders: body.allowMarketOrders ?? true,
      allowLimitOrders: body.allowLimitOrders ?? true,
      active: true,
      createdAt: new Date().toISOString()
    });
    db.ledger = db.ledger || [];
    db.ledger.push({
      id: localId("LED"),
      userId: id,
      type: "OPENING",
      amount: Number(body.funds || 0),
      note: "Opening balance",
      time: new Date().toISOString()
    });
    saveLocalStore(db);
    return { ok: true };
  }

  const userPatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userPatch && method === "PATCH") {
    if (session.role !== "master") throw new Error("Master access required.");
    const user = db.users.find((u) => u.id === decodeURIComponent(userPatch[1]).toUpperCase());
    if (!user) throw new Error("User not found.");
    if (typeof body.active === "boolean") user.active = body.active;
    if (body.name) user.name = String(body.name).trim();
    if (body.brokeragePerLot !== undefined) {
      if (!Number.isFinite(Number(body.brokeragePerLot)) || Number(body.brokeragePerLot) < 0) throw new Error("Brokerage per lot must be zero or more.");
      user.brokeragePerLot = Number(body.brokeragePerLot);
    }
    if (body.marginPerLot !== undefined) {
      if (!Number.isFinite(Number(body.marginPerLot)) || Number(body.marginPerLot) < 0) throw new Error("Margin per lot must be zero or more.");
      user.marginPerLot = Number(body.marginPerLot);
    }
    if (body.allowMarketOrders !== undefined) {
      if (typeof body.allowMarketOrders !== "boolean") throw new Error("Market order permission must be true or false.");
      user.allowMarketOrders = body.allowMarketOrders;
    }
    if (body.allowLimitOrders !== undefined) {
      if (typeof body.allowLimitOrders !== "boolean") throw new Error("Limit order permission must be true or false.");
      user.allowLimitOrders = body.allowLimitOrders;
    }
    saveLocalStore(db);
    return { ok: true };
  }

  if (userPatch && method === "DELETE") {
    if (session.role !== "master") throw new Error("Master access required.");
    const id = decodeURIComponent(userPatch[1]).toUpperCase();
    db.users = db.users.filter((u) => u.id !== id);
    db.orders = db.orders.map((o) => o.userId === id && o.status === "OPEN" ? { ...o, status: "CANCELLED", cancelledAt: new Date().toISOString() } : o);
    saveLocalStore(db);
    return { ok: true };
  }

  const fundsPatch = path.match(/^\/api\/users\/([^/]+)\/funds$/);
  if (fundsPatch && method === "POST") {
    if (session.role !== "master") throw new Error("Master access required.");
    const user = db.users.find((u) => u.id === decodeURIComponent(fundsPatch[1]).toUpperCase());
    if (!user) throw new Error("User not found.");
    user.funds = Number(user.funds || 0) + Number(body.amount || 0);
    db.ledger = db.ledger || [];
    db.ledger.push({
      id: localId("LED"),
      userId: user.id,
      type: Number(body.amount || 0) > 0 ? "ADD" : "REMOVE",
      amount: Number(body.amount || 0),
      note: Number(body.amount || 0) > 0 ? "Funds added by master" : "Funds removed by master",
      time: new Date().toISOString()
    });
    saveLocalStore(db);
    return { ok: true };
  }

  if (path === "/api/orders" && method === "POST") {
    if (session.role !== "user") throw new Error("Login as a trader to place orders.");
    const user = db.users.find((u) => u.id === session.id);
    if (!user?.active) throw new Error("User is blocked.");
    const contractId = String(body.contractId || DEFAULT_CONTRACT_ID);
    const contract = db.contracts.find((item) => item.id === contractId && item.active);
    if (!contract) throw new Error("Contract is not available.");
    const type = String(body.type || "").toUpperCase();
    if (!["MARKET", "LIMIT"].includes(type)) throw new Error("Invalid order type.");
    if (type === "MARKET" && !user.allowMarketOrders) throw new Error("Market orders are disabled for this trader.");
    if (type === "LIMIT" && !user.allowLimitOrders) throw new Error("Limit orders are disabled for this trader.");
    const pos = positionFor(session.id);
    const available = Number(user?.funds || 0) + pos.realized - usedMargin(session.id);
    const order = {
      id: localId("ORD"),
      userId: session.id,
      contractId,
      side: String(body.side || "").toUpperCase(),
      type,
      qty: Math.floor(Number(body.qty || 0)),
      price: body.type === "MARKET" ? null : Number(body.price || 0),
      status: "OPEN",
      createdAt: new Date().toISOString()
    };
    const required = (Number(user?.marginPerLot || 0) + Number(user?.brokeragePerLot || 0)) * order.qty;
    if (available < required) throw new Error(`Insufficient funds. Required margin plus brokerage is ${required}, available is ${Math.max(0, available).toFixed(2)}.`);
    localFillOrder(db, order);
    db.orders.push(order);
    saveLocalStore(db);
    return { order };
  }

  const manualFill = path.match(/^\/api\/orders\/([^/]+)\/fill$/);
  if (manualFill && method === "POST") {
    if (session.role !== "master") throw new Error("Master access required.");
    const order = db.orders.find((item) => item.id === decodeURIComponent(manualFill[1]));
    if (!order || order.type !== "LIMIT" || order.status !== "OPEN") throw new Error("Only pending limit orders can be filled manually.");
    const rawPrice = Number(body.price);
    const price = Math.round(rawPrice * 100) / 100;
    if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 9999999999.99 || price <= 0) throw new Error("Enter a valid fill price above zero.");
    localFillOrder(db, order, price);
    saveLocalStore(db);
    return { order };
  }

  const editFillPrice = path.match(/^\/api\/orders\/([^/]+)\/fill-price$/);
  if (editFillPrice && method === "PATCH") {
    if (session.role !== "master") throw new Error("Master access required.");
    const order = db.orders.find((item) => item.id === decodeURIComponent(editFillPrice[1]));
    if (!order || order.status !== "FILLED") throw new Error("Only filled orders can have their fill price changed.");
    const trade = db.trades.find((item) => item.orderId === order.id);
    if (!trade) throw new Error("The trade for this order is missing.");
    const rawPrice = Number(body.price);
    const price = Math.round(rawPrice * 100) / 100;
    if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 9999999999.99 || price <= 0) throw new Error("Enter a valid fill price above zero.");
    order.fillPrice = price;
    trade.price = price;
    saveLocalStore(db);
    return { order };
  }

  const cancelPatch = path.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (cancelPatch && method === "POST") {
    const order = db.orders.find((o) => o.id === decodeURIComponent(cancelPatch[1]));
    if (!order) throw new Error("Order not found.");
    if (session.role !== "master" && order.userId !== session.id) throw new Error("Cannot cancel this order.");
    if (order.status === "FILLED" && session.role !== "master") throw new Error("Filled orders cannot be cancelled by trader.");
    if (order.status === "FILLED" && session.role === "master") db.trades = db.trades.filter((t) => t.orderId !== order.id);
    order.status = "CANCELLED";
    order.cancelledAt = new Date().toISOString();
    saveLocalStore(db);
    return { order };
  }

  throw new Error("Local endpoint not found.");
}

function fmt(n, d = 2) {
  return Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
}

function whole(n) {
  return Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function signed(n) {
  return `${n >= 0 ? "+" : ""}${fmt(n)}`;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function marketMove() {
  const change = finiteNumber(market.netChange, market.ltp - market.prevClose);
  const pct = finiteNumber(market.changePercent, market.prevClose ? (change / market.prevClose) * 100 : 0);
  return { change, pct };
}

function formatTradeTime(value) {
  const numeric = Number(value || 0);
  const date = numeric ? new Date(numeric) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function makeInitialMarket() {
  return {
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
    totalBuyQty: 1512,
    totalSellQty: 1800,
    oi: 458,
    previousOi: 453,
    oiChange: 5,
    lastTick: Date.now(),
    source: "demo",
    bids: [
      [927.3, 144, 2],
      [927.2, 216, 3],
      [927.1, 360, 5],
      [927.0, 504, 7],
      [926.9, 288, 4]
    ],
    asks: [
      [927.5, 180, 2],
      [927.6, 288, 4],
      [927.7, 432, 6],
      [927.8, 360, 5],
      [927.9, 540, 8]
    ]
  };
}

function currentUser() {
  if (!state.session) return null;
  if (state.session.role === "master") return state.master;
  return state.users.find((u) => u.id === state.session.id) || state.session;
}

function isMaster() {
  return state.session?.role === "master";
}

function tradeMultiplier(contractId = selectedContractId) {
  return Number(contractFor(contractId).lotSize || SCRIP.lotSize);
}

function userOrders(userId, includeAll = false) {
  return state.orders
    .filter((o) => includeAll || o.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function userTrades(userId) {
  return state.trades.filter((t) => t.userId === userId).sort((a, b) => new Date(b.time) - new Date(a.time));
}

function positionFor(userId) {
  return portfolioReport(userId).summary;
}

function positionReport(userId, contractId = selectedContractId) {
  const lots = userTrades(userId).filter((trade) => (trade.contractId || DEFAULT_CONTRACT_ID) === contractId);
  const quote = quoteFor(contractId);
  let qty = 0;
  let avg = 0;
  let realized = 0;
  let brokerage = 0;
  const closed = [];

  for (const t of lots.slice().reverse()) {
    const signedQty = t.side === "BUY" ? t.qty : -t.qty;
    brokerage += Number(t.brokerage || 0);
    if (qty === 0 || Math.sign(qty) === Math.sign(signedQty)) {
      avg = (Math.abs(qty) * avg + Math.abs(signedQty) * t.price) / (Math.abs(qty) + Math.abs(signedQty));
      qty += signedQty;
      continue;
    }

    const closingQty = Math.min(Math.abs(qty), Math.abs(signedQty));
    const pnlPerUnit = qty > 0 ? t.price - avg : avg - t.price;
    const grossPnl = pnlPerUnit * closingQty * tradeMultiplier(contractId);
    realized += grossPnl;
    closed.push({
      id: t.id,
      userId: t.userId,
      contractId,
      side: qty > 0 ? "LONG" : "SHORT",
      qty: closingQty,
      entry: avg,
      exit: t.price,
      pnl: grossPnl - Number(t.brokerage || 0),
      grossPnl,
      brokerage: Number(t.brokerage || 0),
      time: t.time
    });
    qty += signedQty;

    if (qty === 0) avg = 0;
    if (qty !== 0 && Math.sign(qty) === Math.sign(signedQty)) avg = t.price;
  }

  const mtm = qty === 0 ? 0 : (qty > 0 ? quote.ltp - avg : avg - quote.ltp) * Math.abs(qty) * tradeMultiplier(contractId);
  realized -= brokerage;
  const open = qty === 0 ? [] : [{
    userId,
    contractId,
    side: qty > 0 ? "LONG" : "SHORT",
    qty: Math.abs(qty),
    avg,
    ltp: quote.ltp,
    pnl: mtm
  }];
  return {
    summary: { qty, avg, realized, mtm, net: realized + mtm, brokerage },
    open,
    closed
  };
}

function portfolioReport(userId) {
  const reports = (state.contracts || []).map((contract) => positionReport(userId, contract.id));
  const summary = reports.reduce((total, report) => {
    for (const key of ["qty", "realized", "mtm", "net", "brokerage"]) total[key] += report.summary[key];
    return total;
  }, { qty: 0, avg: 0, realized: 0, mtm: 0, net: 0, brokerage: 0 });
  return { summary, open: reports.flatMap((report) => report.open), closed: reports.flatMap((report) => report.closed) };
}

function availableFunds(userId) {
  const user = state.users.find((u) => u.id === userId);
  if (!user) return 0;
  const pos = positionFor(userId);
  return Number(user.funds || 0) + pos.realized - usedMargin(userId);
}

function openOrderLots(userId) {
  return state.orders
    .filter((order) => order.userId === userId && order.status === "OPEN")
    .reduce((sum, order) => sum + Number(order.qty || 0), 0);
}

function usedMargin(userId) {
  const heldLots = (state.contracts || []).reduce((sum, contract) => sum + Math.abs(positionReport(userId, contract.id).summary.qty), 0);
  const lots = heldLots + openOrderLots(userId);
  const user = state.users.find((item) => item.id === userId);
  return lots * Number(user?.marginPerLot || 0);
}

function normalizeMarket(data, previous = market) {
  const next = { ...previous, ...data, lastTick: Date.now() };
  next.ltp = finiteNumber(next.ltp ?? next.last_price, previous.ltp);
  next.prevClose = finiteNumber(next.prevClose ?? next.prev_close_price ?? next.cp ?? next.close_price ?? next.previous_close ?? next.close, previous.prevClose);
  next.open = finiteNumber(next.open, previous.open);
  next.high = finiteNumber(next.high, Math.max(previous.high, next.ltp));
  next.low = finiteNumber(next.low, Math.min(previous.low, next.ltp));
  next.lowerCircuit = positiveNumber(next.lowerCircuit ?? next.lower_circuit_limit ?? next.lower_circuit, previous.lowerCircuit);
  next.upperCircuit = positiveNumber(next.upperCircuit ?? next.upper_circuit_limit ?? next.upper_circuit, previous.upperCircuit);
  next.netChange = finiteNumber(next.netChange ?? next.net_change ?? next.change, next.ltp - next.prevClose);
  next.changePercent = finiteNumber(next.changePercent ?? next.change_percent ?? next.percent_change, next.prevClose ? (next.netChange / next.prevClose) * 100 : 0);
  next.volume = finiteNumber(next.volume, previous.volume);
  next.avgPrice = positiveNumber(next.avgPrice ?? next.average_price ?? next.avg_price ?? next.atp, previous.avgPrice);
  next.ltq = finiteNumber(next.ltq ?? next.last_quantity ?? next.last_traded_quantity, previous.ltq ?? 0);
  next.totalBuyQty = finiteNumber(next.totalBuyQty ?? next.total_buy_quantity, previous.totalBuyQty ?? 0);
  next.totalSellQty = finiteNumber(next.totalSellQty ?? next.total_sell_quantity, previous.totalSellQty ?? 0);
  next.oi = finiteNumber(next.oi ?? next.open_interest, previous.oi ?? 0);
  next.previousOi = finiteNumber(next.previousOi ?? next.previous_oi ?? next.prev_oi, previous.previousOi ?? 0);
  next.oiChange = finiteNumber(next.oiChange ?? next.oi_change ?? next.oi_chg, next.previousOi ? next.oi - next.previousOi : previous.oiChange ?? 0);
  next.lastTradeTime = finiteNumber(next.lastTradeTime ?? next.last_trade_time, previous.lastTradeTime ?? 0);
  next.bids = Array.isArray(data.bids) && data.bids.length ? data.bids : previous.bids;
  next.asks = Array.isArray(data.asks) && data.asks.length ? data.asks : previous.asks;
  return next;
}

async function bootstrap() {
  if (window.MENTHA_LOCAL_ONLY) {
    state.session = localSession();
    startLocalMarket();
    if (state.session) {
      await refreshState();
      activeView = isMaster() ? "admin" : "watchlist";
      render();
      startRefresh();
    } else {
      render();
    }
    return;
  }

  if (!token()) {
    render();
    return;
  }

  try {
    await refreshState();
    activeView = isMaster() ? "admin" : "watchlist";
    render();
    startRefresh();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    state = structuredClone(seedState);
    render();
  }
}

function startLocalMarket() {
  clearInterval(localMarketTimer);
  localMarketTimer = setInterval(() => {
    for (const contract of localStore().contracts.filter((item) => item.active)) {
      const current = quoteFor(contract.id);
      const tick = Number(contract.tickSize);
      const next = Math.max(tick, roundTick(current.ltp + (Math.random() - 0.48) * tick * 16, tick));
      const bids = Array.from({ length: 5 }, (_, i) => [roundTick(next - tick * (i + 1), tick), 72 * (2 + Math.floor(Math.random() * 7)), 1 + Math.floor(Math.random() * 8)]);
      const asks = Array.from({ length: 5 }, (_, i) => [roundTick(next + tick * (i + 1), tick), 72 * (2 + Math.floor(Math.random() * 7)), 1 + Math.floor(Math.random() * 8)]);
      const ltq = [36, 72, 108, 144, 216, 360][Math.floor(Math.random() * 6)];
      const netChange = next - current.prevClose;
      markets[contract.id] = { ...current, ltp: next, netChange,
        changePercent: current.prevClose ? (netChange / current.prevClose) * 100 : 0,
        high: Math.max(current.high, next), low: Math.min(current.low, next),
        avgPrice: (current.avgPrice + next) / 2, ltq, volume: current.volume + ltq,
        totalBuyQty: bids.reduce((sum, [, qty]) => sum + qty, 0),
        totalSellQty: asks.reduce((sum, [, qty]) => sum + qty, 0),
        bids, asks, source: "demo" };
    }
    market = quoteFor(selectedContractId);
    localMatchOpenOrders();
    if (state.session) renderIfNotEditing();
  }, 1800);
}

function roundTick(value, tick = contractFor().tickSize) {
  return Math.round(value / tick) * tick;
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshState(false).catch(() => {});
  }, 2500);
}

async function refreshState(showErrors = true) {
  try {
    const [stateData, marketData] = await Promise.all([
      api("/api/state"),
      api("/api/markets")
    ]);
    state = { ...state, ...stateData };
    for (const contract of state.contracts || []) {
      markets[contract.id] = normalizeMarket(marketData.markets?.[contract.id] || {}, quoteFor(contract.id));
    }
    if (!state.contracts.some((contract) => contract.id === selectedContractId && contract.active)) {
      selectedContractId = state.contracts.find((contract) => contract.active)?.id || DEFAULT_CONTRACT_ID;
      if (activeView === "trade") activeView = "watchlist";
    }
    market = quoteFor(selectedContractId);
    renderIfNotEditing();
  } catch (error) {
    if (showErrors) notify(error.message);
    throw error;
  }
}

function isEditingField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function renderIfNotEditing() {
  if (!isEditingField()) render();
}

function render() {
  const app = document.getElementById("app");
  if (!state.session) {
    app.innerHTML = authTemplate();
    bindAuth();
    return;
  }

  app.innerHTML = shellTemplate();
  bindShell();
}

function authTemplate() {
  return `
    <main class="auth">
      <section class="auth-card">
        <div class="mark">M</div>
        <h1>MENTHA Paper Trade</h1>
        <p class="muted">Paper trading with a shared contract watchlist. Master ID: MASTER.</p>
        <div class="trade-form" style="margin-top:16px">
          <label class="field"><span class="label">Login ID</span><input id="loginId" autocomplete="username" value="MASTER"></label>
          <label class="field"><span class="label">PIN</span><input id="loginPin" type="password" autocomplete="current-password"></label>
          <button class="secondary" id="loginBtn">Log in</button>
        </div>
      </section>
    </main>
  `;
}

function shellTemplate() {
  const user = currentUser();
  const pos = isMaster() ? null : positionFor(user.id);
  const content = viewTemplate(user, pos);
  const { change, pct } = marketMove();
  const isPortfolio = activeView === "positions";
  const isWatchlist = activeView === "watchlist";
  const contract = contractFor();
  return `
    <main class="shell">
      ${isPortfolio ? portfolioHeaderTemplate() : isWatchlist ? watchlistHeaderTemplate() : `
        <header class="upstox-header">
          <button class="back-btn" aria-label="Back">‹</button>
          <div class="brand">
            <div class="instrument-icon">
              <span></span><span></span><span></span>
            </div>
            <div>
              <h1>${esc(contract.name)}</h1>
              <p>${esc(contract.subtitle)}</p>
            </div>
          </div>
          <div class="header-price">
            <strong class="${change >= 0 ? "up" : "down"}">${fmt(market.ltp, 2)}</strong>
            <span class="${change >= 0 ? "up" : "down"}">${signed(change)} (${signed(pct)}%)</span>
          </div>
        </header>

        <div class="market-tabs">
          <button class="active">Market</button>
          <button>Charts</button>
          <button>News</button>
        </div>
      `}

      <nav class="bottom-nav">
        ${navButton("watchlist", "▣", "My lists")}
        ${navButton("orders", "🛒", "Orders")}
        ${navButton("positions", "▣", "Portfolio")}
        ${isMaster() ? navButton("contracts", "◎", "Contracts") : navButton("discover", "◎", "Discover")}
        ${navButton(isMaster() ? "admin" : "account", "◉", isMaster() ? "Admin" : "Account")}
      </nav>

      <section class="grid ${activeView === "trade" ? "trade-stack" : ""}">
        ${content}
      </section>
    </main>
  `;
}

function portfolioHeaderTemplate() {
  return `
    <header class="portfolio-header">
      <div class="portfolio-title-row">
        <h1>Portfolio</h1>
      </div>
    </header>
  `;
}

function watchlistHeaderTemplate() {
  return `
    <header class="watchlist-header">
      <div class="watchlist-search"><span aria-hidden="true">⌕</span><input id="contractSearch" type="search" placeholder="Search contracts" aria-label="Search contracts"></div>
    </header>
  `;
}

function watchlistTemplate() {
  const contracts = (state.contracts || []).filter((contract) => contract.active);
  return `
    <section class="watchlist-tabs"><span class="active">Watchlist</span><span>Contracts</span></section>
    <section class="watchlist-chips"><span class="active">My list</span><span>${contracts.length} contracts</span></section>
    <section class="watchlist-list">
      ${contracts.length ? contracts.map((contract) => {
        const quote = quoteFor(contract.id);
        const change = Number(quote.netChange ?? quote.ltp - quote.prevClose);
        const pct = Number(quote.changePercent ?? (quote.prevClose ? change / quote.prevClose * 100 : 0));
        return `<button class="watchlist-item" type="button" data-contract="${esc(contract.id)}">
          <span class="watchlist-name"><strong>${esc(contract.name)}</strong><small>${esc(contract.subtitle)}</small></span>
          <span class="watchlist-price"><strong class="${change >= 0 ? "up" : "down"}">${fmt(quote.ltp, 2)}</strong><small>${signed(change)} (${Math.abs(pct).toFixed(2)}%)</small></span>
        </button>`;
      }).join("") : empty("No contracts available")}
    </section>
  `;
}

function viewTemplate(user, pos) {
  if (activeView === "watchlist") return watchlistTemplate();
  if (activeView === "home" || activeView === "trade") return `${marketTemplate(true)}${depthTemplate()}${tradeTemplate(isMaster() ? null : positionReport(user.id).summary)}${tradeActionBar(pos)}`;
  if (activeView === "positions") return positionsPageTemplate();
  if (activeView === "orders") return ordersTemplate();
  if (activeView === "admin") return adminTemplate();
  if (activeView === "contracts" && isMaster()) return contractsAdminTemplate();
  if (activeView === "account" || activeView === "funds") return accountLedgerTemplate(user, pos);
  if (activeView === "discover") return `<section class="panel"><h2>Discover</h2><p class="muted">Discovery tools can be added here later.</p></section>`;
  return tradeTemplate(pos);
}

function navButton(view, icon, label) {
  return `<button class="${activeView === view ? "active" : ""}" data-view="${esc(view)}"><span class="icon">${esc(icon)}</span><span>${esc(label)}</span></button>`;
}

function marketTemplate(pulse = false) {
  const { change, pct } = marketMove();
  const lower = finiteNumber(market.lowerCircuit, market.prevClose * 0.96);
  const upper = finiteNumber(market.upperCircuit, market.prevClose * 1.04);
  const circuitRange = upper - lower;
  const circuitPos = circuitRange > 0 ? Math.max(4, Math.min(96, ((market.ltp - lower) / circuitRange) * 100)) : 50;
  const detailRows = [
    ["Volume", whole(market.volume)],
    ["Avg. traded price", fmt(market.avgPrice, 2)],
    ["Last traded time", formatTradeTime(market.lastTradeTime || market.timestamp || market.lastTick)],
    ["Last traded quantity", whole(market.ltq)],
    ["Spot", fmt(market.ltp, 2)],
    ["Last trading date", "30 Oct 26"],
    ["Expiry", "30 Oct 26"],
    ["OI (chg)", signed(market.oiChange || 0)],
    ["Open Interest", whole(market.oi)]
  ];
  return `
    <section class="market-card ${pulse ? "pulse-board" : ""}">
      <div class="section-title-row">
        <h2>Today's Market</h2>
      </div>
      <div class="today-grid">
        <div><span>Open</span><strong>${fmt(market.open, 2)}</strong></div>
        <div><span>High</span><strong>${fmt(market.high, 2)}</strong></div>
        <div><span>Low</span><strong>${fmt(market.low, 2)}</strong></div>
        <div class="prev-close-cell">
          <span>Prev. close</span>
          <strong>${fmt(market.prevClose, 2)}</strong>
          <button class="market-toggle" type="button" data-market-toggle aria-label="${marketDetailsExpanded ? "Hide market details" : "Show market details"}">${marketDetailsExpanded ? "⌃" : "⌄"}</button>
        </div>
      </div>
      <div class="circuit-block">
        <span>Circuit (Lower-Upper)</span>
        <div class="circuit-line"><i style="left:${circuitPos}%"></i></div>
        <div class="row"><strong>${fmt(lower, 2)}</strong><strong>${fmt(upper, 2)}</strong></div>
      </div>
      <div class="market-detail-list ${marketDetailsExpanded ? "expanded" : ""}">
        ${detailRows.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")}
      </div>
    </section>
  `;
}

function depthTemplate() {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    bid: market.bids[index] || [0, 0],
    ask: market.asks[index] || [0, 0]
  }));
  const maxQty = Math.max(...rows.map((row) => row.bid[1]), ...rows.map((row) => row.ask[1]), 1);
  const totalBuy = Number(market.totalBuyQty || 0) || market.bids.reduce((sum, [, qty]) => sum + qty, 0);
  const totalSell = Number(market.totalSellQty || 0) || market.asks.reduce((sum, [, qty]) => sum + qty, 0);
  const buyPct = totalBuy + totalSell ? Math.round((totalBuy / (totalBuy + totalSell)) * 100) : 50;
  return `
    <section class="depth-card">
      <h2>Market Depth</h2>
      <div class="depth-table">
        <div class="depth-head"><span>Qty</span><span>Orders</span><span>Bid</span><span>Ask</span><span>Orders</span><span>Qty</span></div>
        ${rows.map(({ bid, ask }) => `
          <div class="depth-row" style="--buy-w:${Math.max(10, (bid[1] / maxQty) * 100)}%; --sell-w:${Math.max(10, (ask[1] / maxQty) * 100)}%;">
            <span class="depth-side-bar buy-depth"></span>
            <span class="depth-side-bar sell-depth"></span>
            <span class="qty-cell">${whole(bid[1])}</span>
            <span class="order-count">${whole(bid[2] || 0)}</span>
            <strong>${fmt(bid[0], 2)}</strong>
            <strong>${fmt(ask[0], 2)}</strong>
            <span class="order-count">${whole(ask[2] || 0)}</span>
            <span class="qty-cell">${whole(ask[1])}</span>
          </div>
        `).join("")}
      </div>
      <div class="depth-total">
        <div><span>Total buy qty.</span><strong>${buyPct}% (${whole(totalBuy)})</strong></div>
        <div><span>Total sell qty.</span><strong>(${whole(totalSell)}) ${100 - buyPct}%</strong></div>
      </div>
      <div class="depth-ratio"><span style="width:${buyPct}%"></span><i style="left:${buyPct}%"></i></div>
    </section>
  `;
}

function tradeActionBar(pos) {
  if (isMaster() || currentUser()?.allowMarketOrders === false && currentUser()?.allowLimitOrders === false) return "";
  return `
    <section class="upstox-actions">
      <div class="action-row">
        <button class="buy-action" data-side="BUY">Buy</button>
        <button class="sell-action" data-side="SELL">Sell</button>
      </div>
      <div class="utility-row">
        <button>⏱ GTT</button>
        <button>♟ Alerts</button>
        <button class="following">✓ Following</button>
      </div>
    </section>
  `;
}

function tradeTemplate(pos) {
  if (isMaster()) {
    return `<section class="panel"><h2>Trade</h2><p class="muted">Master can supervise users, adjust funds, and void orders from Admin. Login as a trader to place practice trades.</p></section>`;
  }
  const lastQty = Math.max(1, Math.abs(pos?.qty || 1));
  const trader = currentUser();
  const brokerage = Number(trader?.brokeragePerLot || 0);
  const margin = Number(trader?.marginPerLot || 0);
  const allowMarketOrders = trader?.allowMarketOrders !== false;
  const allowLimitOrders = trader?.allowLimitOrders !== false;
  if (!allowMarketOrders && !allowLimitOrders) {
    return `<section class="panel"><h2>Order Ticket</h2><p class="muted">Market and limit orders are disabled for your account. Contact the admin to enable trading.</p></section>`;
  }
  return `
    <section class="panel">
      <div class="row"><h2>Order Ticket</h2><span class="chip">Margin ${whole(margin)} / lot</span></div>
      <form class="trade-form" id="orderForm">
        <div class="side-tabs">
          <button type="button" class="seg ${activeSide === "BUY" ? "active" : ""}" data-side="BUY">Buy</button>
          <button type="button" class="seg ${activeSide === "SELL" ? "active" : ""}" data-side="SELL">Sell</button>
        </div>
        <div class="form-grid">
          <label class="field"><span class="label">Order type</span><select id="orderType">${allowMarketOrders ? "<option>MARKET</option>" : ""}${allowLimitOrders ? "<option>LIMIT</option>" : ""}</select></label>
          <label class="field"><span class="label">Lots</span><input id="orderQty" type="number" min="1" step="1" value="${lastQty}"></label>
        </div>
        ${allowLimitOrders ? `<label class="field"><span class="label">Limit price</span><input id="orderPrice" type="number" step="${contractFor().tickSize}" value="${Number(activeSide === "BUY" ? market.asks[0][0] : market.bids[0][0]).toFixed(2)}"></label>` : ""}
        <p class="muted">${allowMarketOrders ? "Market buy fills at best ask, market sell fills at best bid. " : ""}${allowLimitOrders ? "Limit orders fill when LTP reaches the limit. " : ""}Brokerage ${whole(brokerage)} per lot.</p>
        <button class="primary ${activeSide === "BUY" ? "buy" : "sell"}" type="submit">${activeSide} ${esc(contractFor().name)}</button>
      </form>
    </section>
  `;
}

function ordersTemplate() {
  const rows = userOrders(currentUser()?.id, isMaster());
  return `
    <section class="panel">
      <div class="row"><h2>${isMaster() ? "All Orders" : "Orders"}</h2><span class="muted">${rows.length} total</span></div>
      <div class="list">${rows.length ? rows.map(orderItem).join("") : empty("No orders yet")}</div>
    </section>
  `;
}

function orderItem(o) {
  const adminFill = isMaster() && o.type === "LIMIT" && o.status === "OPEN";
  const adminEdit = isMaster() && o.status === "FILLED";
  return `
    <article class="item">
      <div class="order-row">
        <div><strong class="${o.side === "BUY" ? "up" : "down"}">${esc(o.side)} ${o.qty} lot</strong><br><small>${esc(contractFor(o.contractId).name)} · ${esc(o.userId)} · ${esc(o.type)}</small></div>
        <span class="chip">${esc(o.status)}</span>
      </div>
      <div class="order-times"><small>Created: ${new Date(o.createdAt).toLocaleString()}</small><small>Executed: ${o.filledAt ? new Date(o.filledAt).toLocaleString() : o.status === "OPEN" ? "Pending" : "Not executed"}</small></div>
      <div class="row" style="margin-top:8px"><span>${o.type === "LIMIT" ? `Limit ₹${fmt(o.price)}` : "Market"}${o.status === "FILLED" && o.fillPrice != null ? ` · Filled ₹${fmt(o.fillPrice)}` : ""}</span>${o.status === "OPEN" || isMaster() && o.status === "FILLED" ? `<button class="ghost" data-cancel="${esc(o.id)}">${o.status === "FILLED" ? "Void" : "Cancel"}</button>` : ""}</div>
      ${adminFill || adminEdit ? `<form class="order-admin-form" data-${adminFill ? "manual-fill" : "edit-fill-price"}="${esc(o.id)}">
        <label class="field"><span class="label">${adminFill ? "Execution price" : "New filled price"}</span><input name="price" type="number" min="0.01" max="9999999999.99" step="0.01" value="${adminFill ? Number(o.price) : Number(o.fillPrice)}" required></label>
        <button class="secondary" type="submit">${adminFill ? "Fill now" : "Change price"}</button>
      </form>` : ""}
    </article>
  `;
}

function fundsTemplate() {
  if (isMaster()) {
    return `
      <section class="panel">
        <h2>Funds Control</h2>
        <div class="list">${state.users.map(userFundItem).join("")}</div>
      </section>
    `;
  }
  const user = currentUser();
  const pos = positionFor(user.id);
  return `
    <section class="panel">
      <h2>Funds</h2>
      <div class="stats">
        <div class="stat"><span class="label">Opening</span><span class="value">₹${whole(user.funds)}</span></div>
        <div class="stat"><span class="label">Realized</span><span class="value ${pos.realized >= 0 ? "up" : "down"}">₹${signed(pos.realized)}</span></div>
        <div class="stat"><span class="label">Available</span><span class="value">₹${whole(availableFunds(user.id))}</span></div>
      </div>
      <div class="stats" style="margin-top:8px">
        <div class="stat"><span class="label">Used Margin</span><span class="value">₹${whole(usedMargin(user.id))}</span></div>
        <div class="stat"><span class="label">Brokerage Paid</span><span class="value">₹${whole(pos.brokerage)}</span></div>
        <div class="stat"><span class="label">Open Lots</span><span class="value">${openOrderLots(user.id)}</span></div>
      </div>
    </section>
  `;
}

function userFundItem(u) {
  return `
    <article class="item">
      <div class="admin-row"><div><strong>${esc(u.name)}</strong><br><small>${esc(u.id)} · ₹${whole(u.funds)}</small></div><span class="chip">${u.active ? "Active" : "Blocked"}</span></div>
      <div class="form-grid" style="margin-top:10px">
        <input id="fund-${esc(u.id)}" type="number" placeholder="Amount">
        <button class="secondary" data-funds="${esc(u.id)}">Apply</button>
      </div>
    </article>
  `;
}

function adminTemplate() {
  return `
    <section class="panel">
      <div class="row"><h2>Admin</h2><button class="danger" id="logoutWide" type="button">Log out</button></div>
      <p class="muted">Set margin, brokerage, and allowed order types separately for each trader below.</p>
    </section>
    <section class="panel">
      <h2>Create User</h2>
      <form class="trade-form" id="userForm">
        <div class="form-grid">
          <label class="field"><span class="label">User ID</span><input id="newUserId" placeholder="TRADER2"></label>
          <label class="field"><span class="label">PIN</span><input id="newUserPin" placeholder="4 digits"></label>
        </div>
        <label class="field"><span class="label">Name</span><input id="newUserName" placeholder="Trader name"></label>
        <label class="field"><span class="label">Opening funds</span><input id="newUserFunds" type="number" value="500000"></label>
        <div class="form-grid">
          <label class="field"><span class="label">Brokerage per lot</span><input id="newUserBrokerage" type="number" min="0" step="0.01" value="0" required></label>
          <label class="field"><span class="label">Margin per lot</span><input id="newUserMargin" type="number" min="0" step="0.01" value="0" required></label>
        </div>
        <div class="permission-options" role="group" aria-label="Allowed order types">
          <label class="permission-option"><input id="newUserMarketOrders" type="checkbox" checked><span>Allow market orders</span></label>
          <label class="permission-option"><input id="newUserLimitOrders" type="checkbox" checked><span>Allow limit orders</span></label>
        </div>
        <button class="secondary">Create user</button>
      </form>
    </section>
    <section class="panel">
      <h2>Users</h2>
      <div class="list">${state.users.map(adminUserItem).join("")}</div>
    </section>
    <section class="panel">
      <h2>Deployment</h2>
      <p class="muted">Market data and all users/orders are now controlled by the Render backend and Supabase database. Configure Upstox token in Render environment variables.</p>
    </section>
  `;
}

function contractsAdminTemplate() {
  return `
    <section class="panel">
      <div class="row"><h2>Contracts</h2><button class="danger" id="logoutWide" type="button">Log out</button></div>
      <p class="muted">Add instruments to every trader's watchlist. Use the exact Upstox instrument key for live quotes.</p>
      <form class="trade-form" id="contractForm" style="margin-top:16px">
        <div class="form-grid">
          <label class="field"><span class="label">Contract name</span><input name="name" placeholder="SILVERMIC FUT" required></label>
          <label class="field"><span class="label">Exchange and expiry</span><input name="subtitle" placeholder="MCX 30 NOV 26" required></label>
        </div>
        <label class="field"><span class="label">Upstox instrument key</span><input name="instrumentKey" placeholder="MCX_FO|..." required></label>
        <div class="form-grid">
          <label class="field"><span class="label">Lot size</span><input name="lotSize" type="number" min="1" step="1" value="1" required></label>
          <label class="field"><span class="label">Tick size</span><input name="tickSize" type="number" min="0.01" step="0.01" value="0.1" required></label>
        </div>
        <div class="form-grid">
          <label class="field"><span class="label">Starting price</span><input name="initialPrice" type="number" min="0.01" step="0.01" required></label>
          <label class="field"><span class="label">Previous close</span><input name="previousClose" type="number" min="0.01" step="0.01" required></label>
        </div>
        <button class="secondary" type="submit">Add contract</button>
      </form>
    </section>
    <section class="panel">
      <h2>Watchlist contracts</h2>
      <div class="list">${(state.contracts || []).map((contract) => `
        <article class="item">
          <div class="admin-row"><div><strong>${esc(contract.name)}</strong><br><small>${esc(contract.subtitle)} · ${esc(contract.instrumentKey)}</small></div><span class="chip">${contract.active ? "Visible" : "Hidden"}</span></div>
          <button class="ghost" type="button" data-contract-toggle="${esc(contract.id)}" style="margin-top:10px">${contract.active ? "Hide from watchlist" : "Show in watchlist"}</button>
        </article>`).join("")}</div>
    </section>
  `;
}

function adminUserItem(u) {
  const pos = positionFor(u.id);
  return `
    <article class="item">
      <div class="admin-row">
        <div><strong>${esc(u.name)}</strong><br><small>${esc(u.id)}</small></div>
        <span class="${pos.net >= 0 ? "up" : "down"}">₹${signed(pos.net)}</span>
      </div>
      <form class="trade-form" data-rules-form="${esc(u.id)}" style="margin-top:10px">
        <div class="form-grid">
          <label class="field"><span class="label">Brokerage per lot</span><input name="brokeragePerLot" type="number" min="0" step="0.01" value="${Number(u.brokeragePerLot || 0)}" required></label>
          <label class="field"><span class="label">Margin per lot</span><input name="marginPerLot" type="number" min="0" step="0.01" value="${Number(u.marginPerLot || 0)}" required></label>
        </div>
        <div class="permission-options" role="group" aria-label="Allowed order types for ${esc(u.id)}">
          <label class="permission-option"><input name="allowMarketOrders" type="checkbox" ${u.allowMarketOrders !== false ? "checked" : ""}><span>Allow market orders</span></label>
          <label class="permission-option"><input name="allowLimitOrders" type="checkbox" ${u.allowLimitOrders !== false ? "checked" : ""}><span>Allow limit orders</span></label>
        </div>
        <button class="secondary" type="submit">Save settings</button>
      </form>
      <div class="actions" style="margin-top:10px">
        <button class="ghost" data-toggle="${esc(u.id)}">${u.active ? "Block" : "Unblock"}</button>
        <button class="danger" data-remove="${esc(u.id)}">Remove</button>
      </div>
    </article>
  `;
}

function accountLedgerTemplate(user, pos) {
  if (isMaster()) return adminTemplate();
  const ledger = ledgerRowsFor(user.id, pos);
  return `
    <section class="panel">
      <h2>Account</h2>
      <div class="stats">
        <div class="stat"><span class="label">User</span><span class="value">${esc(user.id)}</span></div>
        <div class="stat"><span class="label">Available</span><span class="value">₹${whole(availableFunds(user.id))}</span></div>
        <div class="stat"><span class="label">Used Margin</span><span class="value">₹${whole(usedMargin(user.id))}</span></div>
      </div>
      <div class="stats" style="margin-top:8px">
        <div class="stat"><span class="label">Opening</span><span class="value">₹${whole(openingBalance(user.id))}</span></div>
        <div class="stat"><span class="label">Brokerage</span><span class="value">₹${whole(pos.brokerage)}</span></div>
        <div class="stat"><span class="label">Total P&L</span><span class="value ${pos.net >= 0 ? "up" : "down"}">₹${signed(pos.net)}</span></div>
      </div>
      <button class="danger" id="logoutWide" style="width:100%;margin-top:12px">Log out</button>
    </section>
    <section class="panel">
      <div class="row"><h2>Ledger</h2><span class="muted">${ledger.length} entries</span></div>
      <div class="list">${ledger.length ? ledger.map(ledgerItem).join("") : empty("No ledger entries yet")}</div>
    </section>
  `;
}

function positionsPageTemplate() {
  const rows = isMaster()
    ? state.users.map((u) => ({ user: u, report: portfolioReport(u.id) }))
    : [{ user: currentUser(), report: portfolioReport(currentUser().id) }];
  const total = rows.reduce((sum, row) => sum + row.report.summary.net, 0);
  const openPnl = rows.reduce((sum, row) => sum + row.report.summary.mtm, 0);
  const closedPnl = rows.reduce((sum, row) => sum + row.report.summary.realized, 0);
  const openRows = rows.flatMap(({ user, report }) => report.open.map((item) => ({ ...item, userId: user.id })));
  const closedRows = rows.flatMap(({ user, report }) => report.closed.map((item) => ({ ...item, userId: user.id })));
  return `
    <section class="portfolio-tabs">
      <button class="active">Positions (${openRows.length + closedRows.length})</button>
      <button>Holdings</button>
    </section>
    <section class="portfolio-filter-row">
      <button class="active">Regular (${openRows.length + closedRows.length})</button>
      <button>MTF</button>
      <button>Strategy</button>
    </section>
    <section class="portfolio-pnl-strip">
      <div><span>Today's P&L</span><strong class="${openPnl >= 0 ? "up" : "down"}">${signed(openPnl)}</strong></div>
      <div><span>Overall P&L</span><strong class="${total >= 0 ? "up" : "down"}">${signed(total)}</strong></div>
    </section>
    <section class="portfolio-list">
      ${openRows.length ? openRows.map(openPositionItem).join("") : empty("No open positions")}
      <div class="closed-label">Closed (${closedRows.length})</div>
      ${closedRows.length ? closedRows.map(closedPositionItem).join("") : empty("No closed positions")}
    </section>
  `;
}

function openPositionItem(item) {
  return `
    <article class="portfolio-position open-position">
      <div>
        <h3>${esc(contractFor(item.contractId).name)}</h3>
        <p>${esc(contractFor(item.contractId).subtitle)}</p>
        <small>Delivery&nbsp;&nbsp; Qty. <span class="${item.side === "LONG" ? "up" : "down"}">${item.side === "LONG" ? "+" : "-"}${item.qty}</span></small>
      </div>
      <div class="position-right">
        <strong class="${item.pnl >= 0 ? "up" : "down"}">${signed(item.pnl)}</strong>
        <span>${fmt(item.avg, 2)} Avg.</span>
        <span>${fmt(item.ltp, 2)} LTP</span>
      </div>
    </article>
  `;
}

function closedPositionItem(item) {
  return `
    <article class="portfolio-position closed-position">
      <div>
        <h3>${esc(contractFor(item.contractId).name)}</h3>
        <p>${esc(contractFor(item.contractId).subtitle)}</p>
        <small>Delivery&nbsp;&nbsp; Qty. 0</small>
      </div>
      <div class="position-right">
        <strong class="${item.pnl >= 0 ? "up" : "down"}">${signed(item.pnl)}</strong>
        <span>0.00 Avg.</span>
        <span>${fmt(item.exit, 2)} LTP</span>
      </div>
    </article>
  `;
}

function openingBalance(userId) {
  const opening = (state.ledger || []).find((item) => item.userId === userId && item.type === "OPENING");
  if (opening) return opening.amount;
  const user = state.users.find((u) => u.id === userId);
  return Number(user?.funds || 0);
}

function ledgerRowsFor(userId, pos) {
  const rawFundRows = (state.ledger || [])
    .filter((item) => item.userId === userId);
  const hasOpening = rawFundRows.some((item) => item.type === "OPENING");
  const user = state.users.find((item) => item.id === userId);
  const fallbackOpening = hasOpening ? [] : [{
    id: `${userId}-opening-fallback`,
    userId,
    type: "OPENING",
    amount: Number(user?.funds || 0),
    note: "Opening balance",
    time: user?.createdAt || new Date().toISOString()
  }];

  const fundRows = [...fallbackOpening, ...rawFundRows]
    .filter((item) => item.userId === userId)
    .map((item) => ({
      id: item.id,
      time: item.time,
      title: item.type === "OPENING" ? "Opening balance" : item.type === "ADD" ? "Funds added" : "Funds removed",
      note: item.note,
      amount: item.amount,
      kind: item.amount >= 0 ? "credit" : "debit"
    }));

  const brokerageRows = userTrades(userId)
    .filter((trade) => Number(trade.brokerage || 0) > 0)
    .map((trade) => ({
      id: `${trade.id}-brokerage`,
      time: trade.time,
      title: "Brokerage charged",
      note: `${contractFor(trade.contractId).name} · ${trade.side} ${trade.qty} lot at ${fmt(trade.price, 1)}`,
      amount: -Number(trade.brokerage || 0),
      kind: "debit"
    }));

  const pnlRows = portfolioReport(userId).closed.map((item) => ({
    id: `${item.id}-pnl`,
    time: item.time,
    title: "Trade P&L",
    note: `${item.side} ${item.qty} lot · Entry ${fmt(item.entry, 1)} · Exit ${fmt(item.exit, 1)}`,
    amount: item.grossPnl,
    kind: item.grossPnl >= 0 ? "credit" : "debit"
  }));

  const openPnlRow = pos.mtm === 0 ? [] : [{
    id: "open-pnl",
    time: new Date().toISOString(),
    title: "Open P&L",
    note: "Live mark-to-market",
    amount: pos.mtm,
    kind: pos.mtm >= 0 ? "credit" : "debit"
  }];

  return [...openPnlRow, ...pnlRows, ...brokerageRows, ...fundRows]
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}

function ledgerItem(item) {
  return `
    <article class="item">
      <div class="row">
        <strong>${esc(item.title)}</strong>
        <span class="${item.amount >= 0 ? "up" : "down"}">₹${signed(item.amount)}</span>
      </div>
      <small>${esc(item.note || "")}${item.note ? " · " : ""}${new Date(item.time).toLocaleString()}</small>
    </article>
  `;
}

function empty(text) {
  return `<p class="muted">${esc(text)}</p>`;
}

function bindAuth() {
  document.getElementById("loginBtn").addEventListener("click", async () => {
    const id = document.getElementById("loginId").value.trim().toUpperCase();
    const pin = document.getElementById("loginPin").value.trim();
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ id, pin })
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      state.session = data.session;
      activeView = data.session.role === "master" ? "admin" : "watchlist";
      await refreshState();
      startRefresh();
    } catch (error) {
      notify(error.message);
    }
  });
}

function bindShell() {
  document.querySelector(".back-btn")?.addEventListener("click", () => { activeView = "watchlist"; render(); });
  document.querySelectorAll("[data-view]").forEach((btn) => btn.addEventListener("click", () => {
    activeView = btn.dataset.view;
    render();
  }));
  document.getElementById("logoutBtn")?.addEventListener("click", logout);
  document.getElementById("logoutWide")?.addEventListener("click", logout);
  document.querySelectorAll("[data-contract]").forEach((btn) => btn.addEventListener("click", () => {
    selectedContractId = btn.dataset.contract;
    market = quoteFor(selectedContractId);
    activeView = "trade";
    render();
  }));
  document.getElementById("contractSearch")?.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll("[data-contract]").forEach((item) => { item.hidden = !item.textContent.toLowerCase().includes(query); });
  });
  document.querySelectorAll("[data-side]").forEach((btn) => btn.addEventListener("click", () => {
    activeSide = btn.dataset.side;
    render();
  }));
  document.querySelector("[data-market-toggle]")?.addEventListener("click", () => {
    marketDetailsExpanded = !marketDetailsExpanded;
    render();
  });
  document.getElementById("orderForm")?.addEventListener("submit", placeOrder);
  document.querySelectorAll("[data-cancel]").forEach((btn) => btn.addEventListener("click", () => cancelOrder(btn.dataset.cancel)));
  document.querySelectorAll("[data-manual-fill]").forEach((form) => form.addEventListener("submit", manualFillOrder));
  document.querySelectorAll("[data-edit-fill-price]").forEach((form) => form.addEventListener("submit", editOrderFillPrice));
  document.getElementById("userForm")?.addEventListener("submit", createUser);
  document.getElementById("contractForm")?.addEventListener("submit", createContract);
  document.querySelectorAll("[data-contract-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleContract(btn.dataset.contractToggle)));
  document.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleUser(btn.dataset.toggle)));
  document.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", () => removeUser(btn.dataset.remove)));
  document.querySelectorAll("[data-funds]").forEach((btn) => btn.addEventListener("click", () => applyFunds(btn.dataset.funds)));
  document.querySelectorAll("[data-rules-form]").forEach((form) => form.addEventListener("submit", saveTraderRules));
}

function logout() {
  clearInterval(refreshTimer);
  localStorage.removeItem(TOKEN_KEY);
  if (window.MENTHA_LOCAL_ONLY) saveLocalSession(null);
  state = structuredClone(seedState);
  render();
}

async function placeOrder(event) {
  event.preventDefault();
  const type = document.getElementById("orderType").value;
  const qty = Math.floor(Number(document.getElementById("orderQty").value));
  const price = Number(document.getElementById("orderPrice")?.value || 0);
  if (!qty || qty < 1) return notify("Enter at least 1 lot.");
  if (type === "LIMIT" && !price) return notify("Enter a valid limit price.");

  try {
    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ contractId: selectedContractId, side: activeSide, type, qty, price })
    });
    activeView = "orders";
    await refreshState();
    notify("Order submitted.");
  } catch (error) {
    notify(error.message);
  }
}

async function cancelOrder(orderId) {
  try {
    await api(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" });
    await refreshState();
    notify(isMaster() ? "Order voided/cancelled." : "Order cancelled.");
  } catch (error) {
    notify(error.message);
  }
}

async function manualFillOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const price = Number(form.elements.price.value);
  try {
    await api(`/api/orders/${encodeURIComponent(form.dataset.manualFill)}/fill`, { method: "POST", body: JSON.stringify({ price }) });
    await refreshState();
    notify("Limit order filled.");
  } catch (error) {
    notify(error.message);
  }
}

async function editOrderFillPrice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const price = Number(form.elements.price.value);
  try {
    await api(`/api/orders/${encodeURIComponent(form.dataset.editFillPrice)}/fill-price`, { method: "PATCH", body: JSON.stringify({ price }) });
    await refreshState();
    notify("Filled price updated.");
  } catch (error) {
    notify(error.message);
  }
}

async function createUser(event) {
  event.preventDefault();
  const id = document.getElementById("newUserId").value.trim().toUpperCase();
  const pin = document.getElementById("newUserPin").value.trim();
  const name = document.getElementById("newUserName").value.trim() || id;
  const funds = Number(document.getElementById("newUserFunds").value);
  const brokeragePerLot = Number(document.getElementById("newUserBrokerage").value);
  const marginPerLot = Number(document.getElementById("newUserMargin").value);
  const allowMarketOrders = document.getElementById("newUserMarketOrders").checked;
  const allowLimitOrders = document.getElementById("newUserLimitOrders").checked;
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({ id, pin, name, funds, brokeragePerLot, marginPerLot, allowMarketOrders, allowLimitOrders })
    });
    await refreshState();
    notify("User created.");
  } catch (error) {
    notify(error.message);
  }
}

async function createContract(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    name: form.elements.namedItem("name").value.trim(),
    subtitle: form.elements.namedItem("subtitle").value.trim(),
    instrumentKey: form.elements.namedItem("instrumentKey").value.trim(),
    lotSize: Number(form.elements.namedItem("lotSize").value),
    tickSize: Number(form.elements.namedItem("tickSize").value),
    initialPrice: Number(form.elements.namedItem("initialPrice").value),
    previousClose: Number(form.elements.namedItem("previousClose").value)
  };
  try {
    await api("/api/contracts", { method: "POST", body: JSON.stringify(body) });
    await refreshState();
    notify("Contract added to the watchlist.");
  } catch (error) {
    notify(error.message);
  }
}

async function toggleContract(id) {
  const contract = state.contracts.find((item) => item.id === id);
  if (!contract) return;
  try {
    await api(`/api/contracts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active: !contract.active }) });
    await refreshState();
    notify(contract.active ? "Contract hidden." : "Contract visible.");
  } catch (error) {
    notify(error.message);
  }
}

async function toggleUser(id) {
  const user = state.users.find((u) => u.id === id);
  if (!user) return;
  try {
    await api(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !user.active })
    });
    await refreshState();
  } catch (error) {
    notify(error.message);
  }
}

async function removeUser(id) {
  try {
    await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshState();
    notify("User removed.");
  } catch (error) {
    notify(error.message);
  }
}

async function applyFunds(id) {
  const input = document.getElementById(`fund-${id}`);
  const amount = Number(input.value);
  if (!amount) return notify("Enter a positive or negative amount.");
  try {
    await api(`/api/users/${encodeURIComponent(id)}/funds`, {
      method: "POST",
      body: JSON.stringify({ amount })
    });
    await refreshState();
    notify(`Funds updated for ${id}.`);
  } catch (error) {
    notify(error.message);
  }
}

async function saveTraderRules(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.rulesForm;
  const brokeragePerLot = Number(form.elements.brokeragePerLot.value);
  const marginPerLot = Number(form.elements.marginPerLot.value);
  const allowMarketOrders = form.elements.allowMarketOrders.checked;
  const allowLimitOrders = form.elements.allowLimitOrders.checked;
  if (!Number.isFinite(brokeragePerLot) || brokeragePerLot < 0 || !Number.isFinite(marginPerLot) || marginPerLot < 0) return notify("Enter valid charges.");
  try {
    await api(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ brokeragePerLot, marginPerLot, allowMarketOrders, allowLimitOrders })
    });
    await refreshState();
    notify(`Settings saved for ${id}.`);
  } catch (error) {
    notify(error.message);
  }
}

function notify(message) {
  clearTimeout(toastTimer);
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

bootstrap();
