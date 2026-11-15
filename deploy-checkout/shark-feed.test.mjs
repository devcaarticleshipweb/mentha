import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const storage = new Map();
const sockets = [];
class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  readyState = 1;
  sent = [];
  constructor(url) {
    this.url = url;
    sockets.push(this);
  }
  send(packet) { this.sent.push(packet); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const context = vm.createContext({
  window: { MENTHA_LOCAL_ONLY: true },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key)
  },
  WebSocket: MockWebSocket,
  structuredClone,
  clearInterval,
  setInterval
});
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/bootstrap\(\);\s*$/, "");
vm.runInContext(`${source}\n globalThis.feedTest = { startLocalSharkStream, quoteFor, quotePrice, roundTick, positionReport, availableFunds };`, context);

context.feedTest.startLocalSharkStream();
assert.equal(sockets.length, 1);
const socket = sockets[0];
assert.match(socket.url, /^wss:\/\/fawss\.sharkexchange\.in/);
socket.onmessage({ data: '0{"sid":"test"}' });
socket.onmessage({ data: '40{"sid":"test"}' });
assert.match(socket.sent[1], /btcinr@ticker/);
assert.match(socket.sent[1], /btcinr@depth_0.1/);
assert.match(socket.sent[1], /xrpusdt@ticker/);
assert.match(socket.sent[1], /xrpusdt@depth_0.1/);
assert.equal(context.feedTest.quotePrice(0.9026, "SHARK-XRPUSDT"), "0.9026 USDT");
assert.equal(context.feedTest.roundTick(0.90263, 0.0001), 0.9026);
assert.equal(context.feedTest.quotePrice(6152773, "SHARK-BTCINR"), "₹61,52,773.00");
vm.runInContext(`state.trades = [
  { userId: "TRADER1", contractId: "SHARK-XRPUSDT", side: "SELL", qty: 1, price: 1.9026, brokerage: 0 },
  { userId: "TRADER1", contractId: "SHARK-XRPUSDT", side: "BUY", qty: 1, price: 0.9026, brokerage: 0 }
];`, context);
assert.equal(context.feedTest.positionReport("TRADER1", "SHARK-XRPUSDT").summary.realized, 1);
assert.equal(context.feedTest.availableFunds("TRADER1"), 500001);
socket.onmessage({ data: `42${JSON.stringify(["24hrTicker", { s: "BTCINR", c: "6152773", p: "-428517", o: "6581291", h: "6600600", l: "6105652", w: "6342145", v: "100", Q: "0.131", E: Date.now() }])}` });
socket.onmessage({ data: `42${JSON.stringify(["depthUpdate", { s: "BTCINR", b: [["6153000", "0.1"], ["6153500", "0.2"]], a: [["6154000", "0.3"], ["6153900", "0.4"]] }])}` });
const live = context.feedTest.quoteFor("SHARK-BTCINR");
assert.equal(live.source, "shark");
assert.equal(live.ltp, 6152773);
assert.equal(live.bids[0][0], 6153500);
assert.equal(live.asks[0][0], 6153900);
socket.close();
assert.equal(context.feedTest.quoteFor("SHARK-BTCINR").source, "pending");
console.log("Shark local stream quote and disconnect checks passed.");

const hostedContext = vm.createContext({
  window: { MENTHA_LOCAL_ONLY: false },
  localStorage: context.localStorage,
  WebSocket: MockWebSocket,
  structuredClone,
  clearInterval,
  setInterval
});
vm.runInContext(`${source}\n globalThis.feedTest = { startLocalSharkStream, quoteFor, watchlistTemplate, tradeTemplate, relayBrowserSharkQuotes };`, hostedContext);
hostedContext.feedTest.startLocalSharkStream();
const hostedSocket = sockets.at(-1);
hostedSocket.onmessage({ data: '0{"sid":"test"}' });
hostedSocket.onmessage({ data: '40{"sid":"test"}' });
hostedSocket.onmessage({ data: `42${JSON.stringify(["24hrTicker", { s: "BTCINR", c: "6152773", p: "-428517", o: "6581291", h: "6600600", l: "6105652", w: "6342145", v: "100", Q: "0.131", E: Date.now() }])}` });
hostedSocket.onmessage({ data: `42${JSON.stringify(["depthUpdate", { s: "BTCINR", b: [["6153000", "0.1"]], a: [["6154000", "0.3"]] }])}` });
assert.equal(hostedContext.feedTest.quoteFor("SHARK-BTCINR").source, "shark-browser");
assert.match(hostedContext.feedTest.watchlistTemplate(), /Shark live · paper trading/);
vm.runInContext('state.session = { role: "user", id: "TRADER1" }; selectedContractId = "SHARK-BTCINR"; market = quoteFor(selectedContractId);', hostedContext);
assert.match(hostedContext.feedTest.tradeTemplate(null), /id="orderForm"/);
let relayRequest;
storage.set("mentha-session-token", "test-token");
hostedContext.fetch = async (url, options) => {
  relayRequest = { url, options };
  return { ok: true, json: async () => ({ accepted: 1 }) };
};
assert.equal(await hostedContext.feedTest.relayBrowserSharkQuotes("SHARK-BTCINR"), 1);
assert.equal(relayRequest.url, "/api/shark/quotes");
assert.equal(JSON.parse(relayRequest.options.body).quotes[0].quote.source, "shark-browser");
storage.delete("mentha-session-token");
vm.runInContext("state.session = null;", hostedContext);
hostedSocket.close();
assert.equal(hostedContext.feedTest.quoteFor("SHARK-BTCINR").source, "pending");
console.log("Shark hosted display fallback checks passed.");

const serverSource = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const serverMethods = serverSource.slice(serverSource.indexOf("function sharkPair"), serverSource.indexOf("function publicOrder"));
class MockSocket {
  connected = true;
  active = true;
  handlers = new Map();
  sent = [];
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, data) { this.sent.push([event, data]); }
  trigger(event, data) { this.handlers.get(event)?.(data); }
}
const serverSocket = new MockSocket();
const serverContext = vm.createContext({ io: () => serverSocket, Date, Map, Set, Number, JSON });
vm.runInContext(`
  let sharkSocket = null;
  let sharkStreamError = null;
  let sharkPairs = "";
  const sharkTickers = new Map();
  const sharkDepth = new Map();
  const sharkTickAt = new Map();
  const markets = new Map();
  const contractsCache = [{ id: "SHARK-BTCINR", instrumentKey: "SHARK:BTCINR" }];
  ${serverMethods}
  globalThis.feedTest = { ensureSharkStream, markets, streamError: () => sharkStreamError };
`, serverContext);
serverContext.feedTest.ensureSharkStream([{ id: "SHARK-BTCINR", instrumentKey: "SHARK:BTCINR" }]);
serverSocket.trigger("connect");
assert.equal(serverSocket.sent[0][0], "subscribe");
assert.match(JSON.stringify(serverSocket.sent[0][1]), /btcinr@ticker/);
serverSocket.trigger("24hrTicker", { s: "BTCINR", c: "6152773", p: "-428517", o: "6581291", h: "6600600", l: "6105652", w: "6342145", v: "100", Q: "0.131", E: Date.now() });
serverSocket.trigger("depthUpdate", { s: "BTCINR", b: [["6153000", "0.1"], ["6153500", "0.2"]], a: [["6154000", "0.3"], ["6153900", "0.4"]] });
const serverQuote = serverContext.feedTest.markets.get("SHARK-BTCINR");
assert.equal(serverQuote.source, "shark");
assert.equal(serverQuote.ltp, 6152773);
assert.equal(serverQuote.bids[0][0], 6153500);
assert.equal(serverQuote.asks[0][0], 6153900);
serverSocket.trigger("disconnect", "test");
assert.equal(serverContext.feedTest.markets.has("SHARK-BTCINR"), false);
serverSocket.trigger("connect_error", { message: "blocked" });
assert.match(serverContext.feedTest.streamError(), /blocked/);
console.log("Shark server stream quote and disconnect checks passed.");

let seeded;
const seedContext = vm.createContext({
  Set, String, Promise,
  db: async (result) => result,
  supabase: { from: () => ({
    select: () => [{ id: "SHARK-BTCUSDT", instrument_key: "SHARK:OLD-BTCUSDT" }],
    upsert: (rows, options) => { seeded = { rows, options }; return []; }
  }) }
});
const seedMethods = serverSource.slice(serverSource.indexOf("let sharkSeedPromise;"), serverSource.indexOf("async function loadContracts"));
vm.runInContext(`${seedMethods}\n globalThis.seedTest = ensureSharkContracts;`, seedContext);
await seedContext.seedTest();
assert.equal(seeded.rows.some((row) => row.id === "SHARK-BTCUSDT"), false);
assert.equal(seeded.options.onConflict, "id");
assert.equal(seeded.options.ignoreDuplicates, true);
console.log("Shark contract seed primary-key collision check passed.");

const relayContext = vm.createContext({
  Date, Number, Array, Map,
  quoteFor: () => ({ source: "pending" })
});
const relayMethods = serverSource.slice(serverSource.indexOf("const browserSharkQuotes"), serverSource.indexOf("function sharkPair"));
vm.runInContext(`${relayMethods}\n globalThis.relayTest = { validBrowserSharkQuote, tradingQuoteFor, browserSharkQuotes };`, relayContext);
const relayContract = { id: "SHARK-XRPUSDT", instrumentKey: "SHARK:XRPUSDT" };
const relayQuote = {
  source: "shark-browser", instrumentKey: "SHARK:XRPUSDT", timestamp: new Date().toISOString(),
  ltp: 0.9026, bids: [[0.9025, 100]], asks: [[0.9027, 100]]
};
const acceptedQuote = relayContext.relayTest.validBrowserSharkQuote(relayQuote, relayContract);
assert.equal(acceptedQuote.ltp, 0.9026);
relayContext.relayTest.browserSharkQuotes.set("TRADER1:SHARK-XRPUSDT", { quote: acceptedQuote, receivedAt: Date.now() });
assert.equal(relayContext.relayTest.tradingQuoteFor(relayContract, "TRADER1").source, "shark-browser");
assert.equal(relayContext.relayTest.tradingQuoteFor(relayContract, "TRADER2").source, "pending");
assert.equal(relayContext.relayTest.validBrowserSharkQuote({ ...relayQuote, timestamp: new Date(Date.now() - 30000).toISOString() }, relayContract), null);
assert.equal(relayContext.relayTest.validBrowserSharkQuote({ ...relayQuote, bids: [[0.9030, 100]] }, relayContract), null);
console.log("Shark browser relay freshness and account isolation checks passed.");
