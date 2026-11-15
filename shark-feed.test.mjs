import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const storage = new Map();
const sockets = [];
class MockWebSocket {
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
  window: {},
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
vm.runInContext(`${source}\n globalThis.feedTest = { startLocalSharkStream, quoteFor };`, context);

context.feedTest.startLocalSharkStream();
assert.equal(sockets.length, 1);
const socket = sockets[0];
assert.match(socket.url, /^wss:\/\/fawss\.sharkexchange\.in/);
socket.onmessage({ data: '0{"sid":"test"}' });
socket.onmessage({ data: '40{"sid":"test"}' });
assert.match(socket.sent[1], /btcinr@ticker/);
assert.match(socket.sent[1], /btcinr@depth_0.1/);
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
