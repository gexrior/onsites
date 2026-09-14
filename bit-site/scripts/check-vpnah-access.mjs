#!/usr/bin/env node
// Passwords are read only in memory, never included in command arguments or output.
import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const production = "https://bit.onsites.me";

export async function readVpnahPassword(filename) {
  const resolved = await realpath(filename);
  assert.ok(!resolved.startsWith(repo), "Password file must be outside the repository");
  const info = await stat(resolved);
  assert.ok(info.isFile() && info.size <= 1024 && (info.mode & 0o077) === 0, "Password file must be a small private file (chmod 600)");
  let values;
  try { values = JSON.parse(await readFile(resolved, "utf8")); }
  catch { throw new Error("Password file must contain valid JSON"); }
  assert.ok(values && Object.keys(values).length === 1 && typeof values.VPNAH_ANALYTICS_PASSWORD === "string", "Only VPNAH_ANALYTICS_PASSWORD may be provided");
  assert.ok(/^[!-~]{16,128}$/.test(values.VPNAH_ANALYTICS_PASSWORD), "Use an independent 16–128 character printable ASCII password");
  return values.VPNAH_ANALYTICS_PASSWORD;
}

export async function checkVpnahAccess({ vpnahPasswordFile, baseUrl = production, overrideVersion = "", expectedVersion = "" }) {
  assert.equal(baseUrl, production, "Never send the production password to another origin");
  const password = await readVpnahPassword(vpnahPasswordFile);
  async function get(route, username = "vpnah") {
    const headers = { Authorization: "Basic " + Buffer.from(`${username}:${password}`).toString("base64"), "Cache-Control": "no-store" };
    if (overrideVersion) headers["Cloudflare-Workers-Version-Overrides"] = `bit-onsites="${overrideVersion}"`;
    const result = await fetch(baseUrl + route, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (expectedVersion) assert.equal(result.headers.get("x-bit-worker-version"), expectedVersion, `${route}: unexpected version`);
    assert.equal(result.headers.get("cache-control"), "no-store", `${route}: must not cache private responses`);
    return result;
  }
  const page = await get("/VPNAH/analytics");
  assert.equal(page.status, 200, "Independent account cannot open the VPNAH page");
  const html = await page.text();
  assert.ok(!/<a\b/i.test(html), "Independent page must not contain navigation links");
  for (const route of ["/VPNAH/analytics/data?days=1&invite_code=LINKI&path=/LINKI", "/api/analytics/vpnah?days=1"]) {
    const result = await get(route);
    assert.equal(result.status, 200, "Independent account cannot read its report");
    const data = await result.json();
    assert.equal(data.scope, "VPNAH");
    assert.ok(data.pages.length === 2 && [data.pages, data.devices, data.downloads].flat().every((row) => ["/VPNAH", "/VPNAH/tutorial"].includes(row.path)), "Report escaped its VPNAH scope");
  }
  for (const route of ["/analytics", "/analytics/", "/anal%79tics.html", "/admin", "/ad%6din/", "/api/analytics?invite_code=VPNAH", "/api/admin/settings"]) {
    const result = await get(route);
    assert.equal(result.status, 401, `${route}: independent account must not have global access`);
    await result.body?.cancel();
  }
  const escalation = await get("/api/analytics", "admin");
  assert.equal(escalation.status, 401, "Shared password must never grant admin access");
  await escalation.body?.cancel();
  console.log("VPNAH read-only login verified; global pages, reports and administration denied");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const filename = args.find((arg) => arg.startsWith("--vpnah-password-file="))?.slice("--vpnah-password-file=".length);
  try {
    assert.ok(filename && args.includes("--validate-only"), "Use --validate-only --vpnah-password-file=/absolute/private/path.json");
    await readVpnahPassword(filename);
    console.log("Independent password file validated without displaying its value");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
