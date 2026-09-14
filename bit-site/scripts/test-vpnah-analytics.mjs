#!/usr/bin/env node
// Offline tests only: real Worker + in-memory SQLite, never send analytics to production.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import worker from "../src/worker.js";
import { fetchVpnahCheck, readVpnahPassword } from "./check-vpnah-access.mjs";

const site = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, site), "utf8");
const html = await read("public/vpnah-analytics-page.txt");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.equal(scripts.length, 1);
new vm.Script(scripts[0], { filename: "vpnah-dashboard-inline.js" });
assert.ok(!html.includes("/api/track"), "The private dashboard must not pollute public analytics");
assert.doesNotMatch(html, /(?:href|action)\s*=\s*["']\/(?:analytics|admin)(?:[/?#"']|\.html)/i, "The standalone dashboard must not expose global navigation");

// Mock every network call and retry delay; no production request or secret is used.
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const retryRequests = [];
const retryDelays = [];
let retryResponses = [];
const retryResponse = (version, status = 401, realm = "VPNAH Analytics") => new Response("offline response only", {
  status, headers: { "x-bit-worker-version": version, "WWW-Authenticate": `Basic realm="${realm}"` },
});
try {
  globalThis.fetch = async (url, options) => {
    retryRequests.push(new URL(url));
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(retryResponses.length > 0, "Unexpected fetch must never reach the network");
    return retryResponses.shift();
  };
  globalThis.setTimeout = (callback, delay) => { retryDelays.push(delay); callback(); return 0; };
  const resetRetry = (responses) => { retryRequests.length = 0; retryDelays.length = 0; retryResponses = responses; };

  const oldResponse = retryResponse("offline-old-version", 401, "BIT Control");
  const targetResponse = retryResponse("offline-target-version");
  resetRetry([oldResponse, targetResponse]);
  assert.equal(await fetchVpnahCheck("/VPNAH/analytics?days=1", {}, "offline-target-version"), targetResponse);
  assert.equal(retryRequests.length, 2);
  assert.deepEqual(retryDelays, [500]);
  assert.ok(oldResponse.bodyUsed, "Wrong-version response body must be released before retrying");
  const nonces = retryRequests.map((url) => url.searchParams.get("__vpnah_access_check"));
  assert.notEqual(nonces[0], nonces[1]);
  assert.deepEqual(nonces.map((nonce) => Number(nonce.split("-").at(-1))), [1, 2], "Retry nonce must include the increasing attempt");
  assert.ok(retryRequests.every((url) => url.origin === "https://bit.onsites.me" && url.searchParams.get("days") === "1"));

  const incorrectStatus = retryResponse("offline-target-version", 200);
  resetRetry([incorrectStatus]);
  assert.equal(await fetchVpnahCheck("/VPNAH/analytics", {}, "offline-target-version"), incorrectStatus, "Target-version status must reach the caller's strict assertion unchanged");
  assert.equal(retryRequests.length, 1);
  assert.deepEqual(retryDelays, []);

  resetRetry(Array.from({ length: 7 }, () => retryResponse("offline-old-version")));
  await assert.rejects(fetchVpnahCheck("/VPNAH/analytics", {}, "offline-target-version"), /received Worker offline-old-version; expected offline-target-version/);
  assert.equal(retryRequests.length, 7, "Version propagation retries must remain bounded");
  assert.deepEqual(retryDelays, [500, 1000, 1500, 2000, 2500, 3000]);

  resetRetry([]);
  await assert.rejects(fetchVpnahCheck("https://example.invalid/VPNAH/analytics", {}, "offline-target-version"), /Never send the production password to another origin/);
  assert.equal(retryRequests.length, 0, "Foreign origins must be rejected before fetch");
  assert.deepEqual(retryDelays, []);

  const incorrectRealm = retryResponse("offline-target-version", 401, "BIT Control");
  resetRetry([incorrectRealm]);
  assert.equal(await fetchVpnahCheck("/VPNAH/analytics", {}, "offline-target-version"), incorrectRealm, "Target-version realm must reach the caller's strict assertion unchanged");
  assert.equal(retryRequests.length, 1);
  assert.deepEqual(retryDelays, []);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
}

// Validate only synthetic password fixtures; never load an actual deployment secret.
const passwordFixtureDirectory = await mkdtemp(join(tmpdir(), "vpnah-password-test-"));
const passwordFixturePath = join(passwordFixtureDirectory, "offline-password.json");
const fixturePassword = "offline-password-fixture-only";
try {
  await writeFile(passwordFixturePath, JSON.stringify({ VPNAH_ANALYTICS_PASSWORD: fixturePassword }), { mode: 0o600 });
  assert.equal(await readVpnahPassword(passwordFixturePath), fixturePassword);
  await chmod(passwordFixturePath, 0o644);
  await assert.rejects(readVpnahPassword(passwordFixturePath), /small private file/);
  await chmod(passwordFixturePath, 0o600);
  const invalidJson = '{"VPNAH_ANALYTICS_PASSWORD":"synthetic-body-must-not-leak"';
  await writeFile(passwordFixturePath, invalidJson);
  await assert.rejects(readVpnahPassword(passwordFixturePath), (error) => {
    assert.equal(error.message, "Password file must contain valid JSON");
    assert.ok(!error.message.includes("synthetic-body-must-not-leak"), "Invalid JSON errors must not expose file contents");
    return true;
  });
  await writeFile(passwordFixturePath, JSON.stringify({ VPNAH_ANALYTICS_PASSWORD: fixturePassword, DASHBOARD_PASSWORD: "offline-global-fixture-only" }));
  await assert.rejects(readVpnahPassword(passwordFixturePath), /Only VPNAH_ANALYTICS_PASSWORD may be provided/);
  for (const password of ["short-offline", "offline-password-\u4e2d\u6587"]) {
    await writeFile(passwordFixturePath, JSON.stringify({ VPNAH_ANALYTICS_PASSWORD: password }));
    await assert.rejects(readVpnahPassword(passwordFixturePath), /16–128 character printable ASCII/);
  }
  await assert.rejects(readVpnahPassword(fileURLToPath(import.meta.url)), /outside the repository/, "Repository files must be rejected before reading them");
} finally {
  await unlink(passwordFixturePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rmdir(passwordFixtureDirectory);
}

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
  DB, DASHBOARD_PASSWORD: "offline-test-only", VPNAH_ANALYTICS_PASSWORD: "offline-vpnah-test-only", WORKER_VERSION: { id: "offline-version" },
  ASSETS: { async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/vpnah-analytics-page.txt");
    return new Response(html, { headers: { "Content-Type": "text/plain" } });
  } },
};
const origin = "https://bit.onsites.me";
const basic = (username, password) => "Basic " + Buffer.from(username + ":" + password).toString("base64");
const auth = basic("admin", "offline-test-only");
const scopedAuth = basic("vpnah", "offline-vpnah-test-only");
const call = (route, { authorized = true, password = auth, method = "GET", environment = env } = {}) => worker.fetch(new Request(origin + route, {
  method, headers: authorized ? { Authorization: password } : {},
}), environment);
const api = "/VPNAH/analytics/data";
const legacyApi = "/api/analytics/vpnah";
const scopedPages = ["/VPNAH/analytics", "/VPNAH/analytics/", "/VPNAH/analytics.html", "/VPNAH/anal%79tics", "/VPNAH%2fanalytics", "/vpnah-analytics-page.txt", "/vpnah-analytics-page%2etxt", "/vpnah-analytics-page.txt/"];
const scopedApis = [api, api + "/", "/VPNAH/analytics/d%61ta", legacyApi, legacyApi + "/", "/api/analytics/vpn%61h"];
for (const route of [...scopedPages, ...scopedApis]) {
  const anonymous = await call(route, { authorized: false });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("WWW-Authenticate"), /Basic realm="VPNAH Analytics"/);
  assert.equal(anonymous.headers.get("Cache-Control"), "no-store");
  for (const password of [basic("admin", "wrong"), basic("vpnah", "wrong"), basic("admin", "offline-vpnah-test-only"), basic("vpnah", "offline-test-only"), basic("VPNAH", "offline-vpnah-test-only"), "Basic %%%", "Bearer offline-vpnah-test-only"]) {
    assert.equal((await call(route, { password })).status, 401, route + " must reject invalid or crossed credentials");
  }
  assert.ok((await call(route, { password: scopedAuth })).status < 400, route + " accepts scoped credentials");
  assert.ok((await call(route)).status < 400, route + " retains owner access");
  const adminOnlyEnv = { ...env, VPNAH_ANALYTICS_PASSWORD: "" };
  assert.equal((await call(route, { password: scopedAuth, environment: adminOnlyEnv })).status, 401);
  assert.ok((await call(route, { environment: adminOnlyEnv })).status < 400, "Missing scoped secret must not lock out the owner");
  const scopedOnlyEnv = { ...env, DASHBOARD_PASSWORD: "" };
  assert.ok((await call(route, { password: scopedAuth, environment: scopedOnlyEnv })).status < 400, "Scoped access must not depend on a global secret");
  assert.equal((await call(route, { environment: scopedOnlyEnv })).status, 401);
  assert.equal((await call(route, { environment: { ...env, DASHBOARD_PASSWORD: "", VPNAH_ANALYTICS_PASSWORD: "" } })).status, 503);
  const collidingEnv = { ...env, VPNAH_ANALYTICS_PASSWORD: env.DASHBOARD_PASSWORD };
  assert.equal((await call(route, { password: basic("vpnah", env.DASHBOARD_PASSWORD), environment: collidingEnv })).status, 401, "A shared admin password must never activate scoped access");
  assert.ok((await call(route, { environment: collidingEnv })).status < 400, "Password collision must preserve owner access");
  assert.equal((await call(route, { method: "POST" })).status, 405);
}
for (const route of ["/analytics", "/analytics/", "/analytics.html", "/anal%79tics", "/analytics%2ehtml", "/admin", "/admin/", "/admin.html", "/ad%6din", "/admin%2ehtml", "/api/analytics", "/api/analytics/", "/api/anal%79tics", "/api/analytics?invite_code=VPNAH", "/api/admin/settings", "/api/admin/settings/", "/api/admin/sett%69ngs"]) {
  for (const password of [scopedAuth, basic("admin", env.VPNAH_ANALYTICS_PASSWORD)]) {
    const denied = await call(route, { password });
    assert.equal(denied.status, 401, route + " must not allow scoped credentials into the global backend");
    assert.match(denied.headers.get("WWW-Authenticate"), /Basic realm="BIT Control"/);
  }
  assert.equal((await call(route, { authorized: false })).status, 401, route + " must not expose an unauthenticated static shell");
}
assert.equal((await call("/api/admin/settings", { password: scopedAuth, method: "PUT" })).status, 401, "Scoped credentials cannot change global settings");
const page = await call("/VPNAH/analytics", { password: scopedAuth });
assert.equal(page.status, 200);
assert.equal(await page.text(), html);
assert.match(page.headers.get("Content-Type"), /^text\/html/);
assert.match(page.headers.get("Cache-Control"), /no-store/);
assert.equal(page.headers.get("X-Robots-Tag"), "noindex, nofollow");
assert.equal(page.headers.get("X-Frame-Options"), "DENY");
assert.match(page.headers.get("Content-Security-Policy"), /connect-src 'self'/);
assert.equal((await call("/VPNAH/analytics", { password: scopedAuth, method: "HEAD" })).status, 200);
for (const alias of scopedPages.filter((route) => route !== "/VPNAH/analytics")) {
  const result = await call(alias, { password: scopedAuth });
  assert.equal(result.status, 308);
  assert.equal(result.headers.get("Location"), origin + "/VPNAH/analytics");
}
assert.equal((await call(api, { method: "HEAD" })).status, 405);
assert.equal((await call(legacyApi, { method: "HEAD" })).status, 405);
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
  const result = await call(api + query, { password: scopedAuth });
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
assert.deepEqual((await (await call(legacyApi + "?days=7", { password: scopedAuth })).json()).pages, seven.pages, "The legacy scoped API remains equally restricted");
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
    assert.match(url, /^\/VPNAH\/analytics\/data\?days=(1|7|30)$/);
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
console.log("PASS VPNAH dashboard: isolated viewer credentials, global endpoint denial, scoped device metrics, historical clicks, unknown channels, empty/error UI, and no production writes");
