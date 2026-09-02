#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(SITE_DIR, "public");
const PRODUCTION_URL = "https://bit.onsites.me";
const ASSET_EXTENSION = /\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp)$/i;

const PROTECTED_ROUTES = [
  { route: "/LINKI", file: "public/linki-page.txt", group: "/LINKI" },
  { route: "/VPNAH", file: "public/vpnah-page.txt", group: "/VPNAH" },
  {
    route: "/VPNAH/tutorial",
    file: "public/vpnah-tutorial-page.txt",
    group: "/VPNAH/tutorial",
  },
];

const VERIFY_ROUTES = [
  { route: "/", file: "public/index.html" },
  ...PROTECTED_ROUTES,
];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const [mode = "local", ...rest] = argv;
  const allowedRoutes = new Set();
  let baseUrl = PRODUCTION_URL;

  for (const argument of rest) {
    if (argument.startsWith("--allow-route=")) {
      const route = argument.slice("--allow-route=".length);
      if (!PROTECTED_ROUTES.some((entry) => entry.group === route)) {
        fail(`Unknown protected route approval: ${route}`);
      }
      allowedRoutes.add(route);
    } else if (argument.startsWith("--base-url=")) {
      baseUrl = argument.slice("--base-url=".length).replace(/\/+$/, "");
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }

  if (!["local", "preflight", "verify"].includes(mode)) {
    fail(`Unknown mode: ${mode}`);
  }

  return { mode, allowedRoutes, baseUrl };
}

async function localFile(relativePath) {
  return readFile(path.join(SITE_DIR, relativePath));
}

function signupButtonCount(html) {
  return (html.match(/<a\b[^>]*>/gi) || []).filter((tag) => {
    const classValue = /\bclass=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    return /(?:^|\s)btn(?:\s|$)/.test(classValue) && /\bdata-signup-link\b/i.test(tag);
  }).length;
}

async function assertLocalIsolation() {
  const [worker, linki, vpnah, tutorial] = await Promise.all([
    localFile("src/worker.js").then(String),
    localFile("public/linki-page.txt").then(String),
    localFile("public/vpnah-page.txt").then(String),
    localFile("public/vpnah-tutorial-page.txt").then(String),
  ]);

  if (!worker.includes('LINKI: "/linki-page.txt"')) {
    fail("Worker must route LINKI to its independent linki-page.txt asset");
  }
  if (!worker.includes('VPNAH: "/vpnah-page.txt"')) {
    fail("Worker must route VPNAH to its independent vpnah-page.txt asset");
  }
  if (!worker.includes('return vpnahPageAsset(request, env, url, "/vpnah-tutorial-page.txt", "/VPNAH/tutorial")')) {
    fail("Worker must keep the dedicated VPNAH tutorial route");
  }

  const requiredLinkiMarkers = [
    "9736740",
    "27766628",
    "snap.licdn.com/li.lms-analytics/insight.min.js",
    "location.pathname.replace(/\\/+$/,'').toUpperCase()!=='/LINKI'",
  ];
  for (const marker of requiredLinkiMarkers) {
    if (!linki.includes(marker)) fail(`LINKI is missing required marker: ${marker}`);
  }
  const buttonCount = signupButtonCount(linki);
  if (buttonCount !== 5) {
    fail(`LINKI must bind conversion tracking to exactly 5 signup buttons; found ${buttonCount}`);
  }
  if (/VPNAH|啊哈加速器/i.test(linki)) {
    fail("LINKI must not contain VPNAH-specific content");
  }

  const vpnahCombined = `${vpnah}\n${tutorial}`;
  if (/linkedin|licdn|lintrk|9736740|27766628/i.test(vpnahCombined)) {
    fail("VPNAH pages must not contain LINKI/LinkedIn tracking");
  }
}

async function candidateAssetPaths(html, pageRoute) {
  const values = [];
  const attributePattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const cssPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let match;
  while ((match = attributePattern.exec(html))) values.push(match[1]);
  while ((match = cssPattern.exec(html))) values.push(match[1]);

  const paths = new Set();
  for (const value of values) {
    if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) continue;
    let parsed;
    try {
      parsed = new URL(value, `${PRODUCTION_URL}${pageRoute}`);
    } catch {
      continue;
    }
    if (parsed.origin !== PRODUCTION_URL || !ASSET_EXTENSION.test(parsed.pathname)) continue;
    const decodedPath = decodeURIComponent(parsed.pathname);
    const diskPath = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
    if (!diskPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) fail(`Unsafe asset path: ${decodedPath}`);
    try {
      await access(diskPath);
      paths.add(decodedPath);
    } catch {
      fail(`Referenced protected asset is missing locally: ${decodedPath}`);
    }
  }
  return [...paths].sort();
}

async function fetchWithRetry(baseUrl, route) {
  let lastError;
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    try {
      const url = new URL(route, `${baseUrl}/`);
      url.searchParams.set("__protected_check", `${Date.now()}-${attempt}`);
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      if (response.status !== 200) fail(`${route} returned HTTP ${response.status}`);
      return {
        body: Buffer.from(await response.arrayBuffer()),
        headers: response.headers,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

function assertPageHeaders(route, headers) {
  const contentType = headers.get("content-type") || "";
  const cacheControl = headers.get("cache-control") || "";
  const csp = headers.get("content-security-policy") || "";
  if (!contentType.toLowerCase().startsWith("text/html")) {
    fail(`${route} has unexpected Content-Type: ${contentType}`);
  }
  if (route !== "/" && !/no-store/i.test(cacheControl)) {
    fail(`${route} must use Cache-Control: no-store`);
  }
  if (route === "/LINKI" && (!csp.includes("snap.licdn.com") || !csp.includes("px.ads.linkedin.com"))) {
    fail("LINKI CSP must allow its LinkedIn Insight Tag endpoints");
  }
  if (route.startsWith("/VPNAH") && /linkedin|licdn/i.test(csp)) {
    fail(`${route} CSP must not contain LINKI/LinkedIn endpoints`);
  }
}

async function compareRouteToLocal(baseUrl, entry) {
  const local = await localFile(entry.file);
  const remote = await fetchWithRetry(baseUrl, entry.route);
  assertPageHeaders(entry.route, remote.headers);
  if (!remote.body.equals(local)) {
    fail(`${entry.route} differs from ${entry.file} (remote ${sha256(remote.body)}, local ${sha256(local)})`);
  }

  const assets = await candidateAssetPaths(local.toString("utf8"), entry.route);
  for (const assetPath of assets) {
    const localAsset = await readFile(path.join(PUBLIC_DIR, `.${assetPath}`));
    const remoteAsset = await fetchWithRetry(baseUrl, assetPath);
    if (!remoteAsset.body.equals(localAsset)) {
      fail(`${entry.route} dependency ${assetPath} differs (remote ${sha256(remoteAsset.body)}, local ${sha256(localAsset)})`);
    }
  }

  return { route: entry.route, hash: sha256(local), assets: assets.length };
}

async function main() {
  const { mode, allowedRoutes, baseUrl } = parseArguments(process.argv.slice(2));
  await assertLocalIsolation();

  if (mode === "local") {
    console.log("Protected page isolation checks passed");
    return;
  }

  const entries = mode === "verify"
    ? VERIFY_ROUTES
    : PROTECTED_ROUTES.filter((entry) => !allowedRoutes.has(entry.group));

  for (const entry of entries) {
    const result = await compareRouteToLocal(baseUrl, entry);
    console.log(`${result.route}: ${result.hash} (${result.assets} protected assets)`);
  }

  if (mode === "preflight" && allowedRoutes.size > 0) {
    console.log(`Explicitly approved protected changes: ${[...allowedRoutes].join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`Protected page check failed: ${error.message}`);
  process.exitCode = 1;
});
