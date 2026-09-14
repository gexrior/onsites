#!/usr/bin/env node
// Offline tests only: real Worker + in-memory SQLite, never send analytics to production.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import worker from "../src/worker.js";

const site = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, site), "utf8");
const html = await read("public/vpnah-analytics-page.txt");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.equal(scripts.length, 1);
new vm.Script(scripts[0], { filename: "vpnah-dashboard-inline.js" });
assert.ok(!html.includes("/api/track"), "The private dashboard must not pollute public analytics");

const database = new DatabaseSync(":memory:");
database.exec(await read("migrations/0001_analytics.sql"));
database.exec(await read("migrations/0002_site_settings.sql"));
const DB = {
  prepare(sql) {
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async all() { return { results: database.prepare(sql).all(...this.values) }; },
      async first() { return database.prepare(sql).get(...this.values) ?? null; },
      async run() { database.prepare(sql).run(...this.values); return { success: true }; },
    };
  },
  batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
};
const env = {
  DB, DASHBOARD_PASSWORD: "offline-test-only", WORKER_VERSION: { id: "offline-version" },
  ASSETS: { async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/vpnah-analytics-page.txt");
    return new Response(html, { headers: { "Content-Type": "text/plain" } });
  } },
};
const origin = "https://bit.onsites.me";
const auth = "Basic " + Buffer.from("admin:offline-test-only").toString("base64");
const call = (route, { authorized = true, password = auth, method = "GET", environment = env } = {}) => worker.fetch(new Request(origin + route, {
  method, headers: authorized ? { Authorization: password } : {},
}), environment);
const api = "/api/analytics/vpnah";
for (const route of ["/VPNAH/analytics", "/VPNAH/analytics/", "/VPNAH/analytics.html", "/vpnah-analytics-page.txt", "/vpnah-analytics-page%2etxt", api]) {
  assert.equal((await call(route, { authorized: false })).status, 401);
  assert.equal((await call(route, { password: "Basic " + Buffer.from("admin:wrong").toString("base64") })).status, 401);
  assert.equal((await call(route, { environment: { ...env, DASHBOARD_PASSWORD: "" } })).status, 503);
  assert.equal((await call(route, { method: "POST" })).status, 405);
}
const page = await call("/VPNAH/analytics");
assert.equal(page.status, 200);
assert.equal(await page.text(), html);
assert.match(page.headers.get("Content-Type"), /^text\/html/);
assert.match(page.headers.get("Cache-Control"), /no-store/);
assert.equal(page.headers.get("X-Robots-Tag"), "noindex, nofollow");
assert.equal(page.headers.get("X-Frame-Options"), "DENY");
assert.match(page.headers.get("Content-Security-Policy"), /connect-src 'self'/);
assert.equal((await call("/VPNAH/analytics", { method: "HEAD" })).status, 200);
for (const alias of ["/VPNAH/analytics/", "/VPNAH/analytics.html", "/vpnah-analytics-page.txt"]) {
  const result = await call(alias);
  assert.equal(result.status, 308);
  assert.equal(result.headers.get("Location"), origin + "/VPNAH/analytics");
}
assert.equal((await call(api, { method: "HEAD" })).status, 405);
const originalDashboard = await call("/analytics", { environment: { ...env, ASSETS: { async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/analytics");
  return new Response("original analytics", { headers: { "Content-Type": "text/html" } });
} } } });
assert.equal(await originalDashboard.text(), "original analytics");
assert.equal(originalDashboard.headers.get("X-Robots-Tag"), null);
const oldError = console.error;
try {
  console.error = () => {};
  const failed = await call(api, { environment: { ...env, DB: { async batch() { throw new Error("offline DB failure"); }, prepare() { return { bind() { return this; } }; } } } });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("Cache-Control"), "no-store");
} finally { console.error = oldError; }

async function report(query = "?days=7") {
  const result = await call(api + query);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  return result.json();
}
const empty = await report();
assert.equal(empty.pages.length, 2);
assert.equal(empty.devices.length, 6);
assert.ok(empty.devices.every((row) => row.pageviews === 0 && row.tutorial_clicks === 0));
assert.deepEqual(empty.downloads, []);

const insert = database.prepare("INSERT INTO analytics_events(event_id,created_at,event_type,event_value,event_label,visitor_hash,path,invite_code,device,is_bot) VALUES(?,?,?,?,?,?,?,?,?,?)");
let sequence = 0;
const landingPath = "/VPNAH", guidePath = "/VPNAH/tutorial";
function event({ path = landingPath, code = "VPNAH", device = "mobile", type = "view", value = "", label = "", visitor = "ip-A", age = 0, bot = 0 } = {}) {
  insert.run("test-" + ++sequence, new Date(Date.now() - age * 86400000).toISOString(), type, value, label, visitor, path, code, device, bot);
}
event(); event(); // Two views, one mobile IP.
event({ device: "desktop" }); // Same IP: page-wide visitors must stay one.
event({ device: null, visitor: "ip-B" });
event({ type: "click", value: "tutorial" });
event({ type: "click", value: "tutorial" });
event({ type: "click", value: "tutorial", device: "desktop" });
event({ type: "click", value: "signup", device: "desktop" }); // Historical direct signup.
event({ path: guidePath });
event({ path: guidePath, device: "desktop", visitor: "ip-C" });
for (const [device, label] of [["mobile", "app-store"], ["mobile", "app-store"], ["desktop", "google-play"], ["mobile", "testflight"], ["desktop", "android-apk"], ["unexpected", "unlisted-download"]]) {
  event({ path: guidePath, type: "click", value: "download", device, label });
}
event({ age: 2, visitor: "ip-older" });
event({ age: 10, visitor: "ip-month" });
event({ age: 35 }); // Expired.
event({ path: "/LINKI", code: "LINKI", type: "click", value: "download", label: "app-store" });
event({ path: "/OTHER", type: "click", value: "tutorial" });
event({ code: "LINKI", type: "click", value: "tutorial" });
event({ bot: 1, type: "click", value: "tutorial" });

const seven = await report();
const getPage = (data, path) => data.pages.find((row) => row.path === path);
const landing = getPage(seven, landingPath);
assert.deepEqual(landing, { path: landingPath, pageviews: 5, visitors: 3, tutorial_clicks: 3, signup_clicks: 1, download_clicks: 0 });
const guide = getPage(seven, guidePath);
assert.deepEqual(guide, { path: guidePath, pageviews: 2, visitors: 2, tutorial_clicks: 0, signup_clicks: 0, download_clicks: 6 });
assert.equal(seven.devices.find((row) => row.path === guidePath && row.device === "unknown").download_clicks, 1);
assert.equal(seven.devices.filter((row) => row.path === landingPath).reduce((sum, row) => sum + row.visitors, 0), 4, "Device UVs must not be summed to form page UVs");
assert.equal(seven.downloads.find((row) => row.channel === "app-store").clicks, 2);
assert.equal(seven.downloads.find((row) => row.channel === "app-store").clicked_visitors, 1);
assert.equal(seven.downloads.reduce((sum, row) => sum + row.clicks, 0), 6);
assert.equal(getPage(await report("?days=1"), landingPath).pageviews, 4);
assert.equal(getPage(await report("?days=30"), landingPath).pageviews, 6);
for (const query of ["", "?days=bad", "?days=-1", "?days=999", "?days=2"]) assert.equal((await report(query)).days, 7);
assert.deepEqual((await report("?days=7&invite_code=LINKI&path=/LINKI")).pages, seven.pages, "Query strings cannot widen the channel scope");
assert.ok(!JSON.stringify(seven).includes("ip-A"));

// Execute the actual dashboard renderer against the actual API fixture (no browser/network).
function domNode() {
  return { textContent: "", hidden: false, disabled: false, children: [], attrs: {}, listeners: {},
    appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
  };
}
const ids = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], domNode()]));
const buttons = [1, 7, 30].map((days) => ({ ...domNode(), dataset: { days: String(days) } }));
let responseStatus = 200;
let currentData = seven;
const context = vm.createContext({
  document: { getElementById: (id) => ids.get(id), createElement: domNode, querySelectorAll: () => buttons },
  location: new URL(origin + "/VPNAH/analytics"), history: { replaceState() {} },
  URL, URLSearchParams, AbortController,
  fetch: async (url, options) => {
    assert.match(url, /^\/api\/analytics\/vpnah\?days=(1|7|30)$/);
    assert.equal(options.credentials, "same-origin");
    return { ok: responseStatus === 200, status: responseStatus, json: async () => currentData };
  },
});
vm.runInContext(scripts[0], context);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(ids.get("landingVisitors").textContent, "3");
assert.equal(ids.get("tutorialClicks").textContent, "3");
assert.equal(ids.get("downloadClicks").textContent, "6");
assert.equal(ids.get("downloadRows").children.length, 5, "Unknown download labels remain visible");
assert.equal(ids.get("report").hidden, false);
responseStatus = 500;
await ids.get("refresh").listeners.click();
assert.equal(ids.get("error").hidden, false);
assert.equal(ids.get("report").hidden, true, "Failed requests must not present stale data as current");
assert.match(ids.get("status").textContent, /不显示为 0/);
responseStatus = 200; currentData = empty;
await ids.get("refresh").listeners.click();
assert.equal(ids.get("empty").hidden, false);
assert.equal(ids.get("report").hidden, false);
assert.equal(ids.get("landingVisitors").textContent, "0");

database.close();
console.log("PASS VPNAH dashboard: scoped device metrics, historical clicks, unknown channels, auth, empty/error UI, and no production writes");
