const SCRIP = {
  symbol: "MCX MENTHAOIL",
  lotSize: 360,
  tickSize: 0.1,
  expiry: "Current Contract"
};

const TOKEN_KEY = "mentha-session-token";

const seedState = {
  session: null,
  master: { id: "MASTER", name: "Master" },
  users: [
    { id: "TRADER1", pin: "1111", name: "Trader 1", funds: 500000, active: true, createdAt: new Date().toISOString() }
  ],
  orders: [],
  trades: [],
  ledger: [],
  settings: { brokeragePerLot: 0, marginPerLot: 0 }
};

let state = structuredClone(seedState);
let market = makeInitialMarket();
let activeView = "trade";
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
    return JSON.parse(localStorage.getItem("mentha-local-db") || "null") || structuredClone(seedState);
  } catch {
    return structuredClone(seedState);
  }
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
  if (order.type === "MARKET") return order.side === "BUY" ? market.asks[0][0] : market.bids[0][0];
  if (order.side === "BUY" && Number(order.price) >= market.asks[0][0]) return market.asks[0][0];
  if (order.side === "SELL" && Number(order.price) <= market.bids[0][0]) return market.bids[0][0];
  return null;
}

function localFillOrder(db, order) {
  const fillPrice = localExecutablePrice(order);
  if (!fillPrice) return;
  const brokerage = Number(db.settings?.brokeragePerLot || 0) * Number(order.qty || 0);
  order.status = "FILLED";
  order.fillPrice = fillPrice;
  order.filledAt = new Date().toISOString();
  db.trades.push({
    id: localId("TRD"),
    orderId: order.id,
    userId: order.userId,
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
      trades: db.trades.filter((t) => t.userId === session.id)
    };
  }

  if (path === "/api/market") return { ...market, source: "demo" };

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
    db.users.push({
      id,
      pin: String(body.pin || "").trim(),
      name: String(body.name || id).trim(),
      funds: Number(body.funds || 0),
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
    const pos = positionFor(session.id);
    const openLots = db.orders.filter((o) => o.userId === session.id && o.status === "OPEN").reduce((sum, order) => sum + Number(order.qty || 0), 0);
    const settings = db.settings || seedState.settings;
    const available = Number(user?.funds || 0) + pos.realized - (Math.abs(pos.qty) + openLots) * Number(settings.marginPerLot || 0);
    const order = {
      id: localId("ORD"),
      userId: session.id,
      side: String(body.side || "").toUpperCase(),
      type: String(body.type || "").toUpperCase(),
      qty: Math.floor(Number(body.qty || 0)),
      price: body.type === "MARKET" ? null : Number(body.price || 0),
      status: "OPEN",
      createdAt: new Date().toISOString()
    };
    const required = Number(settings.marginPerLot || 0) * order.qty + Number(settings.brokeragePerLot || 0) * order.qty;
    if (available < required) throw new Error(`Insufficient funds. Required margin plus brokerage is ${required}, available is ${Math.max(0, available).toFixed(2)}.`);
    localFillOrder(db, order);
    db.orders.push(order);
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
    lastTick: Date.now(),
    source: "demo",
    bids: [
      [927.3, 144],
      [927.2, 216],
      [927.1, 360],
      [927.0, 504],
      [926.9, 288]
    ],
    asks: [
      [927.5, 180],
      [927.6, 288],
      [927.7, 432],
      [927.8, 360],
      [927.9, 540]
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

function tradeMultiplier() {
  return SCRIP.lotSize;
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
  return positionReport(userId).summary;
}

function positionReport(userId) {
  const lots = userTrades(userId);
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
    const grossPnl = pnlPerUnit * closingQty * tradeMultiplier();
    realized += grossPnl;
    closed.push({
      id: t.id,
      userId: t.userId,
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

  const mtm = qty === 0 ? 0 : (qty > 0 ? market.ltp - avg : avg - market.ltp) * Math.abs(qty) * tradeMultiplier();
  realized -= brokerage;
  const open = qty === 0 ? [] : [{
    userId,
    side: qty > 0 ? "LONG" : "SHORT",
    qty: Math.abs(qty),
    avg,
    ltp: market.ltp,
    pnl: mtm
  }];
  return {
    summary: { qty, avg, realized, mtm, net: realized + mtm, brokerage },
    open,
    closed
  };
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
  const pos = positionFor(userId);
  const lots = Math.abs(pos.qty) + openOrderLots(userId);
  return lots * Number(state.settings?.marginPerLot || 0);
}

function normalizeMarket(data) {
  const next = { ...market, ...data, lastTick: Date.now() };
  next.ltp = Number(next.ltp || market.ltp);
  next.prevClose = Number(next.prevClose || next.close || market.prevClose);
  next.open = Number(next.open || market.open);
  next.high = Number(next.high || Math.max(market.high, next.ltp));
  next.low = Number(next.low || Math.min(market.low, next.ltp));
  next.volume = Number(next.volume || market.volume);
  next.ltq = Number(next.ltq || 0);
  next.bids = Array.isArray(data.bids) && data.bids.length ? data.bids : market.bids;
  next.asks = Array.isArray(data.asks) && data.asks.length ? data.asks : market.asks;
  return next;
}

async function bootstrap() {
  if (window.MENTHA_LOCAL_ONLY) {
    state.session = localSession();
    startLocalMarket();
    if (state.session) {
      await refreshState();
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
    const next = Math.max(700, roundTick(market.ltp + (Math.random() - 0.48) * 1.6));
    const spread = 0.2 + (Math.random() > 0.7 ? 0.1 : 0);
    market = {
      ...market,
      ltp: next,
      high: Math.max(market.high, next),
      low: Math.min(market.low, next),
      ltq: [36, 72, 108, 144, 216, 360][Math.floor(Math.random() * 6)],
      volume: market.volume + market.ltq,
      bids: Array.from({ length: 5 }, (_, i) => [roundTick(next - spread / 2 - i * 0.1), 72 * (2 + Math.floor(Math.random() * 7))]),
      asks: Array.from({ length: 5 }, (_, i) => [roundTick(next + spread / 2 + i * 0.1), 72 * (2 + Math.floor(Math.random() * 7))]),
      source: "demo"
    };
    localMatchOpenOrders();
    if (state.session) renderIfNotEditing();
  }, 1800);
}

function roundTick(value) {
  return Math.round(value / SCRIP.tickSize) * SCRIP.tickSize;
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
      api("/api/market")
    ]);
    state = { ...state, ...stateData };
    market = normalizeMarket(marketData);
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
        <p class="muted">Render + Supabase paper trading for MCX Mentha Oil. Master ID: MASTER.</p>
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
  const change = market.ltp - market.prevClose;
  const pct = (change / market.prevClose) * 100;
  const isPortfolio = activeView === "positions";
  return `
    <main class="shell">
      ${isPortfolio ? portfolioHeaderTemplate() : `
        <header class="upstox-header">
          <button class="back-btn" aria-label="Back">‹</button>
          <div class="brand">
            <div class="instrument-icon">
              <span></span><span></span><span></span>
            </div>
            <div>
              <h1>MENTHAOIL FUT</h1>
              <p>MCX 30 OCT 26</p>
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
        ${navButton("trade", "▣", "My lists")}
        ${navButton("orders", "🛒", "Orders")}
        ${navButton("positions", "▣", "Portfolio")}
        ${navButton("discover", "◎", "Discover")}
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
      <div class="portfolio-status">11:31 AM <span>▴ ≋ 🔋</span></div>
      <div class="portfolio-title-row">
        <h1>Portfolio</h1>
        <div class="portfolio-icons"><span>▰</span><span>♢</span><span>⇱</span><span>≡</span><span>⌕</span></div>
      </div>
    </header>
  `;
}

function viewTemplate(user, pos) {
  if (activeView === "home" || activeView === "trade") return `${marketTemplate(true)}${depthTemplate()}${tradeTemplate(pos)}${tradeActionBar(pos)}`;
  if (activeView === "positions") return positionsPageTemplate();
  if (activeView === "orders") return ordersTemplate();
  if (activeView === "admin") return adminTemplate();
  if (activeView === "account" || activeView === "funds") return accountLedgerTemplate(user, pos);
  if (activeView === "discover") return `<section class="panel"><h2>Discover</h2><p class="muted">Discovery tools can be added here later.</p></section>`;
  return tradeTemplate(pos);
}

function navButton(view, icon, label) {
  return `<button class="${activeView === view ? "active" : ""}" data-view="${esc(view)}"><span class="icon">${esc(icon)}</span><span>${esc(label)}</span></button>`;
}

function marketTemplate(pulse = false) {
  const change = market.ltp - market.prevClose;
  const pct = (change / market.prevClose) * 100;
  const lower = market.prevClose * 0.96;
  const upper = market.prevClose * 1.04;
  const circuitPos = Math.max(4, Math.min(96, ((market.ltp - lower) / (upper - lower)) * 100));
  const detailRows = [
    ["Volume", whole(market.volume)],
    ["Avg. traded price", fmt((market.open + market.high + market.low + market.ltp) / 4, 2)],
    ["Last traded time", new Date(market.lastTick || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })],
    ["Last traded quantity", whole(market.ltq)],
    ["Spot", fmt(market.ltp, 2)],
    ["Last trading date", "30 Oct 26"],
    ["Expiry", "30 Oct 26"],
    ["OI (chg)", "+5"],
    ["Open Interest", "458"]
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
  const totalBuy = market.bids.reduce((sum, [, qty]) => sum + qty, 0);
  const totalSell = market.asks.reduce((sum, [, qty]) => sum + qty, 0);
  const buyPct = totalBuy + totalSell ? Math.round((totalBuy / (totalBuy + totalSell)) * 100) : 50;
  return `
    <section class="depth-card">
      <h2>Market Depth</h2>
      <div class="depth-table">
        <div class="depth-head"><span>Qty</span><span>Bid</span><span>Ask</span><span>Qty</span></div>
        ${rows.map(({ bid, ask }) => `
          <div class="depth-row">
            <span class="qty-cell buy-depth" style="--w:${Math.max(10, (bid[1] / maxQty) * 100)}%">${whole(bid[1])}</span>
            <strong>${fmt(bid[0], 2)}</strong>
            <strong>${fmt(ask[0], 2)}</strong>
            <span class="qty-cell sell-depth" style="--w:${Math.max(10, (ask[1] / maxQty) * 100)}%">${whole(ask[1])}</span>
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
  if (isMaster()) return "";
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
  const brokerage = Number(state.settings?.brokeragePerLot || 0);
  const margin = Number(state.settings?.marginPerLot || 0);
  return `
    <section class="panel">
      <div class="row"><h2>Order Ticket</h2><span class="chip">Margin ${whole(margin)} / lot</span></div>
      <form class="trade-form" id="orderForm">
        <div class="side-tabs">
          <button type="button" class="seg ${activeSide === "BUY" ? "active" : ""}" data-side="BUY">Buy</button>
          <button type="button" class="seg ${activeSide === "SELL" ? "active" : ""}" data-side="SELL">Sell</button>
        </div>
        <div class="form-grid">
          <label class="field"><span class="label">Order type</span><select id="orderType"><option>MARKET</option><option>LIMIT</option></select></label>
          <label class="field"><span class="label">Lots</span><input id="orderQty" type="number" min="1" step="1" value="${lastQty}"></label>
        </div>
        <label class="field"><span class="label">Limit price</span><input id="orderPrice" type="number" step="0.1" value="${fmt(activeSide === "BUY" ? market.asks[0][0] : market.bids[0][0], 1)}"></label>
        <p class="muted">Market buy fills at best ask, market sell fills at best bid. Limit orders fill when LTP reaches the limit. Brokerage ${whole(brokerage)} per lot.</p>
        <button class="primary ${activeSide === "BUY" ? "buy" : "sell"}" type="submit">${activeSide} ${esc(SCRIP.symbol)}</button>
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
  return `
    <article class="item">
      <div class="order-row">
        <div><strong class="${o.side === "BUY" ? "up" : "down"}">${esc(o.side)} ${o.qty} lot</strong><br><small>${esc(o.userId)} · ${esc(o.type)} · ${new Date(o.createdAt).toLocaleString()}</small></div>
        <span class="chip">${esc(o.status)}</span>
      </div>
      <div class="row" style="margin-top:8px"><span>${o.price ? fmt(o.price, 1) : "Market"}</span>${o.status === "OPEN" || isMaster() && o.status === "FILLED" ? `<button class="ghost" data-cancel="${esc(o.id)}">${o.status === "FILLED" ? "Void" : "Cancel"}</button>` : ""}</div>
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
      <h2>Trading Rules</h2>
      <form class="trade-form" id="settingsForm">
        <div class="form-grid">
          <label class="field"><span class="label">Brokerage per lot</span><input id="brokeragePerLot" type="number" min="0" step="1" value="${Number(state.settings?.brokeragePerLot || 0)}"></label>
          <label class="field"><span class="label">Margin per lot</span><input id="marginPerLot" type="number" min="0" step="1" value="${Number(state.settings?.marginPerLot || 0)}"></label>
        </div>
        <button class="secondary">Save trading rules</button>
      </form>
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

function adminUserItem(u) {
  const pos = positionFor(u.id);
  return `
    <article class="item">
      <div class="admin-row">
        <div><strong>${esc(u.name)}</strong><br><small>${esc(u.id)}</small></div>
        <span class="${pos.net >= 0 ? "up" : "down"}">₹${signed(pos.net)}</span>
      </div>
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
    ? state.users.map((u) => ({ user: u, report: positionReport(u.id) }))
    : [{ user: currentUser(), report: positionReport(currentUser().id) }];
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
        <h3>MENTHAOIL FUT</h3>
        <p>MCX 30 OCT 26</p>
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
        <h3>MENTHAOIL FUT</h3>
        <p>MCX 30 OCT 26</p>
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
      note: `${trade.side} ${trade.qty} lot at ${fmt(trade.price, 1)}`,
      amount: -Number(trade.brokerage || 0),
      kind: "debit"
    }));

  const pnlRows = positionReport(userId).closed.map((item) => ({
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
      activeView = data.session.role === "master" ? "admin" : "trade";
      await refreshState();
      startRefresh();
    } catch (error) {
      notify(error.message);
    }
  });
}

function bindShell() {
  document.querySelectorAll("[data-view]").forEach((btn) => btn.addEventListener("click", () => {
    activeView = btn.dataset.view;
    render();
  }));
  document.getElementById("logoutBtn")?.addEventListener("click", logout);
  document.getElementById("logoutWide")?.addEventListener("click", logout);
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
  document.getElementById("userForm")?.addEventListener("submit", createUser);
  document.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleUser(btn.dataset.toggle)));
  document.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", () => removeUser(btn.dataset.remove)));
  document.querySelectorAll("[data-funds]").forEach((btn) => btn.addEventListener("click", () => applyFunds(btn.dataset.funds)));
  document.getElementById("settingsForm")?.addEventListener("submit", saveSettings);
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
  const price = Number(document.getElementById("orderPrice").value);
  if (!qty || qty < 1) return notify("Enter at least 1 lot.");
  if (type === "LIMIT" && !price) return notify("Enter a valid limit price.");

  try {
    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ side: activeSide, type, qty, price })
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

async function createUser(event) {
  event.preventDefault();
  const id = document.getElementById("newUserId").value.trim().toUpperCase();
  const pin = document.getElementById("newUserPin").value.trim();
  const name = document.getElementById("newUserName").value.trim() || id;
  const funds = Number(document.getElementById("newUserFunds").value);
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({ id, pin, name, funds })
    });
    await refreshState();
    notify("User created.");
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

async function saveSettings(event) {
  event.preventDefault();
  const brokeragePerLot = Number(document.getElementById("brokeragePerLot").value);
  const marginPerLot = Number(document.getElementById("marginPerLot").value);
  try {
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ brokeragePerLot, marginPerLot })
    });
    await refreshState();
    notify("Trading rules saved.");
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
