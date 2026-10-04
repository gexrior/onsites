#!/usr/bin/env node

// Offline browser regression: every request is fulfilled locally or blocked.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BIT_LAYOUT_PLAYWRIGHT_PATH || "playwright");
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const html = await readFile(path.join(publicDir, "index.html"), "utf8");
const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/i)?.[1];
assert.ok(footer, "Template footer must remain present");
assert.doesNotMatch(footer, /推广说明：|风险提示：/, "Remove only the requested footer notices");
assert.match(footer, /免责声明：/, "Preserve the footer disclaimer");
assert.match(footer, /class="copy"[\s\S]*?href="\/disclosure"/, "Preserve copyright and full disclosure link");
const origin = "https://bit-layout.test";
const screenshotDir = process.env.BIT_LAYOUT_SCREENSHOT_DIR
  ? path.resolve(process.env.BIT_LAYOUT_SCREENSHOT_DIR) : "";
const widths = [320, 360, 375, 390, 430, 480, 560, 561, 599, 600, 700, 701, 768, 820,
  900, 901, 960, 961, 1024, 1100, 1101, 1280, 1440, 1920];
const mobileUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const desktopUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const mimeTypes = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif", ".js": "text/javascript" };

if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BIT_LAYOUT_BROWSER_PATH ? { executablePath: process.env.BIT_LAYOUT_BROWSER_PATH } : {}),
});

async function openPage(width, height = 900, mobile = width <= 700) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    userAgent: mobile ? mobileUa : desktopUa,
    serviceWorkers: "block",
  });
  const events = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname === "/") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
    if (url.pathname === "/api/config") {
      return route.fulfill({ json: { invite_code: "STOCK" } });
    }
    if (url.pathname === "/api/track") {
      try { events.push(JSON.parse(request.postData() || "{}")); }
      catch { pageErrors.push("Invalid analytics JSON"); }
      return route.fulfill({ status: 204 });
    }
    const assetPath = path.resolve(publicDir, `.${decodeURIComponent(url.pathname)}`);
    const contentType = mimeTypes[path.extname(assetPath).toLowerCase()];
    if (!assetPath.startsWith(`${publicDir}${path.sep}`) || !contentType) {
      return route.abort("blockedbyclient");
    }
    try { return await route.fulfill({ contentType, body: await readFile(assetPath) }); }
    catch { return route.abort("failed"); }
  });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.__bitInvite.ready);
  return { context, page, events, pageErrors };
}

async function checkLayout(page, width, height) {
  const errors = await page.evaluate(() => {
    const errors = [];
    const tolerance = 1.5;
    const visible = (element) => element.getClientRects().length &&
      getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none";
    const box = (element) => element.getBoundingClientRect();
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const inside = (a, b) => a.left >= b.left - tolerance && a.right <= b.right + tolerance &&
      a.top >= b.top - tolerance && a.bottom <= b.bottom + tolerance;
    const textInside = (element, container, label) => {
      const bounds = box(container);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim() || !visible(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width && rect.height && !inside(rect, bounds)) {
            errors.push(`${label}: text outside container (${node.textContent.trim().slice(0, 35)})`);
          }
        }
      }
    };
    const viewport = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > viewport + tolerance || document.body.scrollWidth > viewport + tolerance) {
      errors.push(`body: horizontal overflow (${document.documentElement.scrollWidth}/${document.body.scrollWidth} > ${viewport})`);
    }
    const grid = document.querySelector("#task1 .card-grid-4");
    const cards = [...grid.children];
    const expectedColumns = innerWidth < 600 ? 1 : innerWidth <= 1100 ? 2 : 4;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length;
    if (columns !== expectedColumns) errors.push(`#task1 .card-grid-4: ${columns} columns, expected ${expectedColumns}`);
    if (cards.length !== 4 || grid.scrollWidth > grid.clientWidth + tolerance) {
      errors.push("#task1 .card-grid-4: all four benefits must be available without horizontal scrolling");
    }
    for (const [index, card] of cards.entries()) {
      if (!visible(card) || !inside(box(card), box(grid))) errors.push(`#task1 .icard[${index}]: outside grid`);
      textInside(card.querySelector("h3"), card, `#task1 .icard[${index}] h3`);
      textInside(card.querySelector("p"), card, `#task1 .icard[${index}] p`);
    }
    for (const selector of [".hero h1", "#task1 .h-sec", ".task2-title", ".hero-cta", ".task2-cta"] ) {
      document.querySelectorAll(selector).forEach((element) => {
        if (!visible(element)) return;
        textInside(element, element.matches("h1,h2") ? element.parentElement : element, selector);
        const rect = box(element);
        if (rect.left < -tolerance || rect.right > viewport + tolerance) errors.push(`${selector}: outside viewport`);
      });
    }
    const groups = [
      [".task2-calculator", ".task2-tier-side", ".task2-breakdown"],
      [".task2-tier-side", ".task2-tier-label", ".task2-tier-group"],
      [".task2-breakdown", ".task2-metric", ".task2-total"],
    ];
    for (const [parentSelector, ...childSelectors] of groups) {
      const parent = document.querySelector(parentSelector);
      const children = childSelectors.flatMap((selector) => [...parent.querySelectorAll(selector)]);
      for (const [index, child] of children.entries()) {
        if (!inside(box(child), box(parent))) errors.push(`${parentSelector} child[${index}]: outside calculator region`);
        textInside(child, parent, `${parentSelector} child[${index}]`);
        for (const other of children.slice(index + 1)) {
          if (overlaps(box(child), box(other))) errors.push(`${parentSelector}: child regions overlap`);
        }
      }
    }
    const badge = document.querySelector(".hero-download-heading");
    const firstDownload = document.querySelector(".hero-download-btn");
    if (visible(badge) && visible(firstDownload) && overlaps(box(badge), box(firstDownload))) {
      errors.push(".hero-download-heading: overlaps first download button");
    }
    for (const selector of ["a.btn[data-signup-link]", ".hero-download-btn", ".download-btn", ".task2-tier", ".quick-nav-toggle"]) {
      document.querySelectorAll(selector).forEach((element) => {
        if (!visible(element)) return;
        const rect = box(element);
        if (rect.height < 43.99) errors.push(`${selector}: touch target height ${rect.height.toFixed(1)} < 44`);
        if (rect.left < -tolerance || rect.right > viewport + tolerance) errors.push(`${selector}: button outside viewport`);
        textInside(element, element, selector);
      });
    }
    const mcta = document.querySelector(".mcta");
    const nav = document.querySelector(".quick-nav-toggle");
    if (visible(mcta) && overlaps(box(mcta), box(nav))) errors.push(".quick-nav-toggle: overlaps mobile fixed CTA");
    return errors;
  });
  assert.deepEqual(errors, [], `${width}×${height}:\n${errors.join("\n")}`);
}

async function checkInteractions(page, events, width, mobile) {
  for (const [tier, total, deposit] of [["10000", "$310", "$200"], ["3000", "$210", "$100"]]) {
    await page.locator(`[data-task2-tier="${tier}"]`).click();
    assert.equal(await page.locator("[data-task2-total]").textContent(), total, `${width}: calculator total`);
    assert.equal(await page.locator("[data-task2-deposit]").textContent(), deposit, `${width}: calculator deposit`);
    assert.equal(await page.locator(`[data-task2-tier="${tier}"]`).getAttribute("aria-pressed"), "true");
  }
  const toggle = page.locator(".quick-nav-toggle");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${width}: open navigation`);
  const menuBox = await page.locator(".quick-nav-menu").boundingBox();
  assert.ok(menuBox && menuBox.y >= 0 && menuBox.y + menuBox.height <= page.viewportSize().height,
    `${width}: open navigation must fit viewport height`);
  await page.locator(".quick-nav-close").click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${width}: close navigation`);
  await toggle.click();
  await page.keyboard.press("Escape");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${width}: Escape navigation`);
  await toggle.click();
  await page.locator('.quick-nav-link[href="#task1"]').click();
  assert.equal(new URL(page.url()).hash, "#task1", `${width}: navigation anchor`);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${width}: anchor closes navigation`);
  const expectedLabels = await page.evaluate(() => {
    const links = [...document.querySelectorAll("[data-signup-link]")];
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-signup-link]")) event.preventDefault();
    }, true);
    return links.map((link) => {
      assertLink(link);
      const label = link.textContent.trim().slice(0, 40);
      link.click();
      return label;
    });
    function assertLink(link) {
      const url = new URL(link.href);
      if (url.hostname !== "www.bit.com" || url.searchParams.get("invite_code") !== "STOCK") {
        throw new Error(`Unexpected signup destination: ${link.href}`);
      }
    }
  });
  assert.equal(expectedLabels.length, 6, `${width}: preserve six remaining signup anchors`);
  for (let attempt = 0; attempt < 40 && events.filter((event) => event.event === "click" && event.value === "signup").length < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const signupEvents = events.filter((event) => event.event === "click" && event.value === "signup");
  assert.deepEqual(signupEvents.map((event) => event.label), expectedLabels, `${width}: one labelled event per signup click`);
  assert.ok(signupEvents.every((event) => event.device === (mobile ? "mobile" : "desktop") &&
    event.path === "/" && event.invite_code === "STOCK"), `${width}: device, route and invite attribution`);
}

try {
  for (const [width, height] of [...widths.map((width) => [width, 900]), [360, 640], [844, 390]]) {
    const mobile = width <= 700 || height === 390;
    const { context, page, events, pageErrors } = await openPage(width, height, mobile);
    try {
      await checkLayout(page, width, height);
      const interactions = width === 375 || width === 1440 || height === 640;
      if (interactions) {
        await checkInteractions(page, events, width, mobile);
        if (screenshotDir && height === 900) {
          const label = mobile ? "mobile" : "desktop";
          await page.screenshot({ path: path.join(screenshotDir, `${label}-full.png`), fullPage: true });
          await page.locator("#task1").screenshot({ path: path.join(screenshotDir, `${label}-benefits.png`) });
        }
      }
      assert.deepEqual(pageErrors, [], `${width}×${height}: browser errors`);
      console.log(`${width}×${height}: layout${interactions ? " and interactions" : ""} passed`);
    } finally { await context.close(); }
  }
  console.log("Template responsive layout regression passed; no production requests sent.");
} finally { await browser.close(); }
