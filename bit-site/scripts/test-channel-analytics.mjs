#!/usr/bin/env node

// Offline regression: execute the browser trackers and the actual Worker against in-memory D1.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://bit.onsites.me";
const read = (file) => readFile(path.join(siteDir, file), "utf8");
const [tracker, linki, vpnah, tutorial, linkiTutorial] = await Promise.all([
  read("public/channel-analytics.js"),
  read("public/linki-page.txt"),
  read("public/vpnah-page.txt"),
  read("public/vpnah-tutorial-page.txt"),
  read("public/linki-tutorial-page.txt"),
]);

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fire(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function browser(route, html, { storage = new Map(), referrer = "", beacon = "success" } = {}) {
  const location = new URL(route, origin);
  const sent = [];
  const beacons = [];
  const fetched = [];
  let uuid = 0;
  let now = Date.now();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class FakeBlob {
    constructor(parts) { this.body = parts.join(""); }
  }
  const document = Object.assign(target(), {
    title: "Channel analytics regression",
    referrer,
    visibilityState: "visible",
    documentElement: { scrollTop: 0, scrollHeight: 2000 },
    head: { children: [], appendChild(child) { this.children.push(child); } },
    createElement(tag) {
      return { tagName: tag.toUpperCase(), setAttribute(name, value) { this[name] = value; } };
    },
  });
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)]
      .map((attr) => [attr[1], attr[2] ?? attr[3] ?? ""]));
    const anchor = Object.assign(target(), {
      tagName: "A", parentNode: document, attrs,
      textContent: match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      hasAttribute: (name) => Object.hasOwn(attrs, name),
      getAttribute: (name) => attrs[name] ?? null,
      setAttribute: (name, value) => { attrs[name] = value; },
      classList: { contains: (name) => (attrs.class || "").split(/\s+/).includes(name) },
    });
    Object.defineProperty(anchor, "href", { get: () => new URL(attrs.href, location).href });
    return anchor;
  });
  document.querySelectorAll = (selector) => {
    if (selector === "[data-signup-link]") return anchors.filter((a) => a.hasAttribute("data-signup-link"));
    if (selector === "a.btn[data-signup-link]") return anchors.filter((a) => a.classList.contains("btn") && a.hasAttribute("data-signup-link"));
    throw new Error(`Unexpected selector in tracked inline script: ${selector}`);
  };
  document.querySelector = (selector) => {
    assert.equal(selector, "script[data-linkedin-insight]");
    return document.head.children.find((child) => Object.hasOwn(child, "data-linkedin-insight")) || null;
  };
  const window = Object.assign(target(), {
    document, location, scrollY: 0, innerHeight: 1000,
    screen: { width: 1440, height: 900 },
    crypto: { randomUUID: () => `offline-${location.pathname}-${++uuid}` },
  });
  const navigator = {
    userAgent: "Mozilla/5.0 Chrome/130.0 Safari/537.36", language: "zh-CN",
    sendBeacon(url, blob) {
      assert.equal(url, "/api/track");
      beacons.push(JSON.parse(blob.body));
      if (beacon === "throw") throw new Error("Beacon unavailable");
      if (beacon === "reject") return false;
      sent.push(JSON.parse(blob.body));
      return true;
    },
  };
  if (beacon === "missing") delete navigator.sendBeacon;
  const context = vm.createContext({
    window, document, location, navigator, screen: window.screen, crypto: window.crypto,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    URL, URLSearchParams, Blob: FakeBlob, Date: FakeDate, Intl, Promise,
    fetch(url, options) {
      assert.equal(url, "/api/track");
      assert.equal(options.method, "POST");
      assert.equal(options.keepalive, true);
      assert.equal(options.credentials, "same-origin");
      fetched.push(options);
      sent.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true });
    },
  });
  return {
    anchors, sent, beacons, fetched, storage, window, document,
    run: (source = tracker) => vm.runInContext(source, context, { timeout: 1000 }),
    click(anchor) {
      assert.ok(anchor, "Expected download or tutorial link in the real HTML");
      document.fire("click", { target: { tagName: "SPAN", parentNode: anchor } });
      anchor.fire("click");
    },
    scroll(percent) { window.scrollY = percent * 10; window.fire("scroll"); },
    leave() {
      now += 12000;
      document.visibilityState = "hidden";
      document.fire("visibilitychange");
      window.fire("pagehide");
      document.fire("visibilitychange");
    },
  };
}

const events = (page, type, value) => page.sent.filter((event) => event.event === type && (value === undefined || event.value === value));
const signupButtons = (page) => page.anchors.filter((a) => a.classList.contains("btn") && a.hasAttribute("data-signup-link"));
const loaders = (html) => [...html.matchAll(/<script\b[^>]*\bsrc=["']\/channel-analytics\.js["'][^>]*>/g)];
for (const [route, html] of [["/LINKI", linki], ["/VPNAH", vpnah], ["/VPNAH/tutorial", tutorial]]) {
  assert.equal(loaders(html).length, 1, `${route} must load the tracker exactly once`);
}
assert.equal(loaders(linkiTutorial).length, 0, "LINKI tutorial remains outside this tracking change");
const untouched = browser("/LINKI/tutorial", linkiTutorial);
untouched.run();
untouched.leave();
assert.equal(untouched.sent.length, 0, "Tracker must not activate on unrequested routes");

const landing = browser("/VPNAH?utm_source=partner&utm_medium=referral&utm_campaign=launch", vpnah, { referrer: "https://example.org/offer" });
landing.run();
landing.run();
assert.equal(events(landing, "view").length, 1, "Duplicate loading must not double-count pageviews");
assert.equal(landing.sent[0].path, "/VPNAH");
assert.equal(landing.sent[0].invite_code, "VPNAH");
landing.click(landing.anchors.find((a) => new URL(a.href).pathname === "/VPNAH/tutorial"));
assert.equal(events(landing, "click", "tutorial").length, 1);
assert.equal(events(landing, "click", "signup").length, 0, "Opening a tutorial is not an account signup");
for (const percent of [26, 26, 76, 51, 100, 100]) landing.scroll(percent);
assert.deepEqual(events(landing, "scroll").map((event) => event.value), ["25", "50", "75", "100"]);
landing.leave();
assert.equal(events(landing, "dwell").length, 1);
assert.equal(events(landing, "dwell")[0].value, "12");
assert.equal(landing.fetched.length, 0, "Successful beacons must not also use fetch");

const guide = browser("/VPNAH/tutorial", tutorial, { storage: landing.storage, referrer: `${origin}/VPNAH` });
guide.run();
assert.equal(events(guide, "view").length, 1);
assert.equal(guide.sent[0].path, "/VPNAH/tutorial");
assert.equal(guide.sent[0].invite_code, "VPNAH");
assert.equal(guide.sent[0].utm_source, "partner");
assert.equal(guide.sent[0].utm_campaign, "launch");
assert.equal(guide.sent[0].landing_page, "/VPNAH");
assert.equal(guide.sent[0].referrer_host, "example.org");
assert.equal(guide.sent[0].session_id, landing.sent[0].session_id);
for (const name of ["ios", "gp", "apk", "tf"]) guide.click(guide.anchors.find((a) => a.classList.contains(name)));
assert.deepEqual(events(guide, "click", "download").map((event) => event.label), ["app-store", "google-play", "android-apk", "testflight"]);
guide.click(guide.anchors.find((a) => a.classList.contains("ios")));

for (const referrer of [`${origin}/LINKI`, "https://example.net/VPNAH", ""]) {
  const fresh = browser("/VPNAH/tutorial", tutorial, { storage: new Map(landing.storage), referrer });
  fresh.run();
  assert.equal(fresh.sent[0].utm_source, "", "Unrelated or direct visits must not inherit an old VPNAH campaign");
  assert.equal(fresh.sent[0].landing_page, "/VPNAH/tutorial");
}
const recampaign = browser("/VPNAH/tutorial?utm_source=new-partner", tutorial, { storage: new Map(landing.storage), referrer: `${origin}/VPNAH` });
recampaign.run();
assert.equal(recampaign.sent[0].utm_source, "new-partner");
assert.equal(recampaign.sent[0].utm_campaign, "");

const linked = browser("/LINKI?utm_source=linkedin", linki, { storage: new Map(landing.storage), referrer: `${origin}/VPNAH` });
linked.window.__bitInvite = { code: "LINKI", ready: Promise.resolve("LINKI") };
const inline = [...linki.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
const insight = inline.find((source) => source.includes("var PARTNER_ID="));
const legacy = inline.find((source) => source.includes("var DEFAULT='STOCK',params="));
assert.ok(insight && legacy, "Original LINKI tracking blocks must remain present");
linked.run(insight);
linked.run(legacy);
linked.run();
linked.run();
await Promise.resolve();
await Promise.resolve();
assert.equal(linked.window._linkedin_partner_id, "9736740");
assert.equal(linked.document.head.children[0].src, "https://snap.licdn.com/li.lms-analytics/insight.min.js");
assert.equal(signupButtons(linked).length, 5, "Preserve LINKI's five conversion buttons");
assert.equal(events(linked, "view").length, 1, "Supplementary tracking must not duplicate LINKI pageviews");
for (const button of signupButtons(linked)) button.setAttribute("href", "https://www.bit.com/zh/register?invite_code=LINKI");
linked.click(signupButtons(linked)[0]);
linked.click(signupButtons(linked)[1]);
assert.equal(events(linked, "click", "signup").length, 2, "One site signup event per click");
assert.deepEqual(JSON.parse(JSON.stringify(linked.window.lintrk.q)), [["track", { conversion_id: 27766628 }]], "Preserve LinkedIn conversion deduplication");
for (const label of ["app-store", "google-play", "android-apk"]) linked.click(linked.anchors.find((a) => a.getAttribute("data-download-link") === label));
assert.deepEqual(events(linked, "click", "download").map((event) => event.label), ["app-store", "google-play", "android-apk"]);
linked.click(linked.anchors.find((a) => new URL(a.href).pathname === "/LINKI/tutorial"));
assert.equal(events(linked, "click", "tutorial").length, 1);
assert.equal(events(linked, "click", "signup").length, 2);
assert.equal(events(linked, "click", "download")[0].utm_source, "linkedin");
assert.ok(linked.sent.every((event) => event.invite_code === "LINKI"));
linked.scroll(100);
linked.scroll(100);
linked.leave();
assert.equal(events(linked, "scroll").length, 4, "LINKI scroll tracking has one owner");
assert.equal(events(linked, "dwell").length, 1, "LINKI dwell tracking has one owner");

for (const beacon of ["reject", "throw", "missing"]) {
  const fallback = browser("/VPNAH", vpnah, { beacon });
  fallback.run();
  assert.equal(fallback.sent.length, 1, `${beacon} beacon must fall back without losing the view`);
  assert.equal(fallback.fetched.length, 1);
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
const worker = (await import(pathToFileURL(path.join(siteDir, "src/worker.js")).href)).default;
const env = { DB, DASHBOARD_PASSWORD: "offline-test-password", IP_HASH_SALT: "offline-test-salt" };
let eventSequence = 0;
async function post(payload, ip, userAgent = "Mozilla/5.0 Chrome/130.0") {
  const request = new Request(`${origin}/api/track`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip, "User-Agent": userAgent },
    body: JSON.stringify({ ...payload, event_id: `fixture-${++eventSequence}` }),
  });
  const result = await worker.fetch(request, env);
  assert.equal(result.status, 204, "Actual Worker must accept browser events");
}
for (const payload of [...landing.sent, ...guide.sent]) await post(payload, "192.0.2.1");
for (const payload of linked.sent) await post(payload, "192.0.2.2");
await post({ event: "click", value: "download", label: "app-store", path: "/LINKI", invite_code: "LINKI" }, "192.0.2.3");
await post({ event: "view", path: "/VPNAH", invite_code: "VPNAH" }, "192.0.2.4", "Example crawler bot");
await post({ event: "click", value: "download", label: "app-store", path: "/LINKI", invite_code: "LINKI" }, "192.0.2.4", "Example crawler bot");
const insert = database.prepare("INSERT INTO analytics_events (event_id, created_at, event_type, event_value, event_label, visitor_hash, path, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
insert.run("two-days-ago", new Date(Date.now() - 2 * 86400000).toISOString(), "view", "", "", "older-visitor", "/VPNAH", "VPNAH");
insert.run("expired-view", new Date(Date.now() - 35 * 86400000).toISOString(), "view", "", "", "expired-visitor", "/VPNAH", "VPNAH");
insert.run("expired-download", new Date(Date.now() - 35 * 86400000).toISOString(), "click", "download", "app-store", "expired-visitor", "/LINKI", "LINKI");
assert.equal((await worker.fetch(new Request(`${origin}/api/analytics`), env)).status, 401, "Analytics must remain authenticated");
async function report(days) {
  const result = await worker.fetch(new Request(`${origin}/api/analytics?days=${days}`, {
    headers: { Authorization: `Basic ${Buffer.from(`admin:${env.DASHBOARD_PASSWORD}`).toString("base64")}` },
  }), env);
  assert.equal(result.status, 200);
  return result.json();
}
const seven = await report(7);
assert.equal(seven.summary.pageviews, 4);
assert.equal(seven.summary.visitors, 3, "Clicks without a view must not inflate visitor counts");
assert.equal(seven.summary.signup_clicks, 2);
assert.equal(seven.summary.download_clicks, 9);
assert.equal(seven.summary.tutorial_clicks, 2);
assert.equal(seven.summary.avg_dwell_seconds, 12);
const pageCounts = seven.pages.map(({ path, invite_code, pageviews, visitors, signup_clicks, download_clicks, tutorial_clicks }) =>
  [path, invite_code, pageviews, visitors, signup_clicks, download_clicks, tutorial_clicks]).sort();
assert.deepEqual(pageCounts, [
  ["/LINKI", "LINKI", 1, 1, 2, 4, 1],
  ["/VPNAH", "VPNAH", 2, 2, 0, 0, 1],
  ["/VPNAH/tutorial", "VPNAH", 1, 1, 0, 5, 0],
]);
const vpnahInvite = seven.invite_codes.find((row) => row.invite_code === "VPNAH");
assert.equal(vpnahInvite.pageviews, 3);
assert.equal(vpnahInvite.visitors, 2, "Landing and tutorial views from one visitor share channel attribution");
assert.equal(vpnahInvite.download_clicks, 5);
const guideStore = seven.downloads.find((row) => row.path === "/VPNAH/tutorial" && row.channel === "app-store");
assert.equal(guideStore.clicks, 2);
assert.equal(guideStore.clicked_visitors, 1, "Repeat downloads are clicks, not additional distinct visitors");
const linkiStore = seven.downloads.find((row) => row.path === "/LINKI" && row.channel === "app-store");
assert.equal(linkiStore.clicks, 2);
assert.equal(linkiStore.clicked_visitors, 2);
assert.equal(seven.downloads.length, 7);
const one = await report(1);
assert.equal(one.granularity, "hour");
assert.equal(one.summary.pageviews, 3, "Time range filters must exclude older views");
assert.equal(one.summary.visitors, 2);
assert.equal(one.summary.download_clicks, 9);
assert.equal((await report(30)).summary.pageviews, 4, "Expired data and bots must stay excluded");
database.close();
console.log("PASS channel analytics: route isolation, real LINKI legacy tracking, attribution, event delivery, and authenticated D1 reports");
