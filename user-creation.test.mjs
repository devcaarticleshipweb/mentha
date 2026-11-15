import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const inputs = new Map([
  ["newUserId", { value: "" }],
  ["newUserPin", { value: "1234" }],
  ["newUserName", { value: "New trader" }],
  ["newUserFunds", { value: "500000" }],
  ["newUserBrokerage", { value: "0" }],
  ["newUserMargin", { value: "0" }],
  ["newUserMarketOrders", { checked: true }],
  ["newUserLimitOrders", { checked: true }],
  ["userFormStatus", { textContent: "" }]
]);
const button = { disabled: false };
const form = {
  dataset: { dirty: "true" },
  querySelector: (selector) => selector === "#userFormStatus" ? inputs.get("userFormStatus") : button
};
const context = vm.createContext({
  window: { MENTHA_LOCAL_ONLY: false },
  document: { getElementById: (id) => inputs.get(id) },
  localStorage: { getItem: () => null },
  structuredClone,
  clearInterval,
  setInterval
});
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/bootstrap\(\);\s*$/, "");
vm.runInContext(`${source}\n globalThis.createUserTest = createUser;`, context);
let submitted = false;
context.mockApi = async () => { submitted = true; return { user: { id: "TRADER2" } }; };
context.mockRefresh = async () => {};
vm.runInContext("api = mockApi; refreshState = mockRefresh;", context);
const event = { preventDefault() {}, currentTarget: form };

await context.createUserTest(event);
assert.equal(submitted, false);
assert.match(inputs.get("userFormStatus").textContent, /User ID needs/);

inputs.get("newUserId").value = "TRADER2";
await context.createUserTest(event);
assert.equal(submitted, true);
assert.equal(inputs.get("userFormStatus").textContent, "User TRADER2 created.");
assert.equal(button.disabled, false);
console.log("Create-user validation and persistent status checks passed.");
