const ALLOWED_EVENTS = new Set(["view", "click", "scroll", "dwell"]);
const MAX_BODY_BYTES = 16 * 1024;
const DASHBOARD_RANGES = new Set([1, 7, 30]);
const DEFAULT_INVITE_CODE = "STOCK";
const SIGNUP_BASE_URL = "https://www.bit.com/zh/register";
const SPECIAL_SIGNUP_URLS = new Map([
  ["MEIGU88", "https://bit.bshareweb.com/newRegister/cn?invite_code=MEIGU88"],
  ["W7CF6T", "https://bit.bshareweb.com/newRegister/cn?invite_code=W7CF6T"],
]);
const VPNAH_CONTENT_SECURITY_POLICY = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; upgrade-insecure-requests";
const RESERVED_INVITE_PATHS = new Set([
  "admin",
  "admin.html",
  "analytics",
  "analytics.html",
  "api",
  "disclosure",
  "disclosure.html",
]);

function text(value, maxLength = 160) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function integer(value, max = 100000) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, max)) : 0;
}

function inviteCode(value) {
  const code = text(value, 100);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return "";
  return code.toUpperCase() === "MIA" ? DEFAULT_INVITE_CODE : code;
}

function signupUrl(code) {
  const resolvedCode = inviteCode(code) || DEFAULT_INVITE_CODE;
  return SPECIAL_SIGNUP_URLS.get(resolvedCode) ||
    `${SIGNUP_BASE_URL}?invite_code=${encodeURIComponent(resolvedCode)}`;
}

function inviteCodeFromPath(pathname) {
  const match = /^\/([A-Za-z0-9_-]{1,100})\/?$/.exec(pathname);
  if (!match || RESERVED_INVITE_PATHS.has(match[1].toLowerCase())) return "";
  return inviteCode(match[1]);
}

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

function classifyUserAgent(userAgent) {
  const ua = userAgent || "";
  return {
    device: /Mobi|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop",
    browser: /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Other",
    os: /Windows/i.test(ua)
      ? "Windows"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad|iPod/i.test(ua)
          ? "iOS"
          : /Mac OS/i.test(ua)
            ? "macOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Other",
    isBot: /bot|crawler|spider|slurp|headless/i.test(ua) ? 1 : 0,
  };
}

async function stableVisitorHash(ip, salt) {
  const bytes = new TextEncoder().encode(`${salt}:stable-ip-v1:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `ip1_${hash}`;
}

function response(status, message) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="BIT Control", charset="UTF-8"',
    },
  });
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

async function dashboardAuthorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Basic ")) return false;

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== "admin") return false;
    return secureEqual(decoded.slice(separator + 1), env.DASHBOARD_PASSWORD);
  } catch {
    return false;
  }
}

function rows(result) {
  return result?.results || [];
}

async function currentInviteSetting(env) {
  const row = await env.DB.prepare(`
    SELECT value, updated_at
    FROM site_settings
    WHERE key = 'invite_code'
    LIMIT 1
  `).first();
  const code = inviteCode(row?.value) || DEFAULT_INVITE_CODE;
  return {
    invite_code: code,
    signup_url: signupUrl(code),
    updated_at: row?.updated_at || null,
  };
}

async function publicConfig(env) {
  try {
    return jsonResponse(await currentInviteSetting(env));
  } catch (error) {
    console.error("public config failed", error);
    return jsonResponse({
      invite_code: DEFAULT_INVITE_CODE,
      signup_url: signupUrl(DEFAULT_INVITE_CODE),
      updated_at: null,
    });
  }
}

async function updateInviteSetting(request, env, url) {
  if (!sameOrigin(request, url)) return response(403, "forbidden");

  const length = integer(request.headers.get("Content-Length"), MAX_BODY_BYTES + 1);
  if (length > MAX_BODY_BYTES) return response(413, "payload too large");

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid payload" }, 400);
  }

  const code = inviteCode(payload?.invite_code);
  if (!code) {
    return jsonResponse({
      error: "邀请码只能包含英文字母、数字、连字符或下划线，长度为 1-100 个字符",
    }, 400);
  }

  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES ('invite_code', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).bind(code, updatedAt).run();

  return jsonResponse({
    invite_code: code,
    signup_url: signupUrl(code),
    updated_at: updatedAt,
  });
}

async function analyticsReport(env, url) {
  const requestedDays = integer(url.searchParams.get("days"), 90);
  const days = DASHBOARD_RANGES.has(requestedDays) ? requestedDays : 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const trendBucket = days === 1
    ? "strftime('%Y-%m-%d %H', created_at, '+8 hours')"
    : "date(created_at, '+8 hours')";

  const statements = [
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS pageviews,
        COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END) AS visitors,
        SUM(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 ELSE 0 END) AS signup_clicks,
        ROUND(AVG(CASE WHEN event_type = 'dwell' THEN CAST(event_value AS INTEGER) END), 0) AS avg_dwell_seconds,
        SUM(CASE WHEN event_type = 'scroll' AND CAST(event_value AS INTEGER) >= 75 THEN 1 ELSE 0 END) AS deep_scrolls
      FROM analytics_events
      WHERE created_at >= ? AND is_bot = 0
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        ${trendBucket} AS day,
        SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS pageviews,
        COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END) AS visitors,
        SUM(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 ELSE 0 END) AS signup_clicks
      FROM analytics_events
      WHERE created_at >= ? AND is_bot = 0
      GROUP BY day
      ORDER BY day
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(traffic_source, ''), 'direct') AS source,
        COALESCE(NULLIF(utm_medium, ''), '-') AS medium,
        COALESCE(NULLIF(utm_campaign, ''), '-') AS campaign,
        SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS pageviews,
        COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END) AS visitors,
        SUM(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 ELSE 0 END) AS signup_clicks
      FROM analytics_events
      WHERE created_at >= ? AND is_bot = 0
      GROUP BY source, medium, campaign
      ORDER BY pageviews DESC, visitors DESC
      LIMIT 20
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(country, ''), 'UNKNOWN') AS country,
        COUNT(*) AS pageviews,
        COUNT(DISTINCT visitor_hash) AS visitors
      FROM analytics_events
      WHERE created_at >= ? AND event_type = 'view' AND is_bot = 0
      GROUP BY country
      ORDER BY pageviews DESC
      LIMIT 15
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(device, ''), 'unknown') AS device,
        COUNT(*) AS pageviews,
        COUNT(DISTINCT visitor_hash) AS visitors
      FROM analytics_events
      WHERE created_at >= ? AND event_type = 'view' AND is_bot = 0
      GROUP BY device
      ORDER BY pageviews DESC
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(browser, ''), 'Other') AS browser,
        COALESCE(NULLIF(os, ''), 'Other') AS os,
        COUNT(*) AS pageviews,
        COUNT(DISTINCT visitor_hash) AS visitors
      FROM analytics_events
      WHERE created_at >= ? AND event_type = 'view' AND is_bot = 0
      GROUP BY browser, os
      ORDER BY pageviews DESC
      LIMIT 12
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(country, ''), 'UNKNOWN') AS country,
        COALESCE(NULLIF(region, ''), '-') AS region,
        COALESCE(NULLIF(city, ''), '-') AS city,
        asn,
        COALESCE(NULLIF(network_name, ''), '-') AS network,
        COUNT(*) AS pageviews,
        COUNT(DISTINCT visitor_hash) AS visitors
      FROM analytics_events
      WHERE created_at >= ? AND event_type = 'view' AND is_bot = 0
      GROUP BY country, region, city, asn, network
      ORDER BY pageviews DESC, visitors DESC
      LIMIT 20
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(invite_code, ''), 'UNKNOWN') AS invite_code,
        SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS pageviews,
        COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END) AS visitors,
        SUM(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 ELSE 0 END) AS signup_clicks
      FROM analytics_events
      WHERE created_at >= ? AND is_bot = 0
      GROUP BY invite_code
      ORDER BY pageviews DESC, signup_clicks DESC
      LIMIT 30
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT value AS invite_code, updated_at
      FROM site_settings
      WHERE key = 'invite_code'
      LIMIT 1
    `),
  ];

  const [summary, daily, sources, countries, devices, browsers, locations, inviteCodes, settings] =
    await env.DB.batch(statements);

  return jsonResponse({
    generated_at: new Date().toISOString(),
    days,
    granularity: days === 1 ? "hour" : "day",
    timezone: "Asia/Shanghai",
    summary: rows(summary)[0] || {},
    daily: rows(daily),
    sources: rows(sources),
    countries: rows(countries),
    devices: rows(devices),
    browsers: rows(browsers),
    locations: rows(locations),
    invite_codes: rows(inviteCodes),
    settings: rows(settings)[0] || { invite_code: DEFAULT_INVITE_CODE, updated_at: null },
  });
}

async function dashboardPage(request, env, url) {
  const assetUrl = new URL("/analytics", url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}

async function adminPage(request, env, url) {
  const assetUrl = new URL("/admin", url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(asset.body, { status: asset.status, headers });
}

async function publicAsset(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self' https://px.ads.linkedin.com; img-src 'self' https://px.ads.linkedin.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://snap.licdn.com; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; upgrade-insecure-requests");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

async function vpnahPageAsset(request, env, url, assetPath, canonicalPath) {
  const assetUrl = new URL(assetPath, url);
  const asset = await publicAsset(new Request(assetUrl, request), env);
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", VPNAH_CONTENT_SECURITY_POLICY);
  headers.set("Link", `<${url.origin}${canonicalPath}>; rel="canonical"`);
  headers.set("X-Robots-Tag", "noindex, follow");
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

function redirectPath(url, pathname) {
  const target = new URL(url);
  target.pathname = pathname;
  return Response.redirect(target, 308);
}

async function inviteLandingPage(request, env, url) {
  const code = inviteCodeFromPath(url.pathname);
  const specialLandingPages = {
    DPG78V: "/dpg78v-page.txt",
    LINKI: "/linki-page.txt",
    USMKT: "/usmkt-page.txt",
    VPNAH: "/vpnah-page.txt",
  };
  const normalizedCode = code.toUpperCase();
  const specialAsset = specialLandingPages[normalizedCode];
  if (normalizedCode === "VPNAH") {
    return vpnahPageAsset(request, env, url, specialAsset, "/VPNAH");
  }
  const assetUrl = new URL(specialAsset || "/", url);
  const asset = await publicAsset(new Request(assetUrl, request), env);
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  if (specialAsset) headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Link", `<${url.origin}${specialAsset ? `/${normalizedCode}` : "/"}>; rel="canonical"`);
  headers.set("X-Robots-Tag", "noindex, follow");
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

async function parsePayload(request, url) {
  if (request.method === "GET") {
    return {
      event: url.searchParams.get("e"),
      invite_code: url.searchParams.get("c"),
      session_id: url.searchParams.get("s"),
      value: url.searchParams.get("d"),
      path: "/",
    };
  }

  const length = integer(request.headers.get("Content-Length"), MAX_BODY_BYTES + 1);
  if (length > MAX_BODY_BYTES) throw new Error("payload_too_large");
  return request.json();
}

async function track(request, env, url) {
  if (!env.IP_HASH_SALT) return response(503, "analytics unavailable");

  if (!sameOrigin(request, url)) return response(403, "forbidden");

  let payload;
  try {
    payload = await parsePayload(request, url);
  } catch (error) {
    return response(error.message === "payload_too_large" ? 413 : 400, "invalid payload");
  }

  const eventType = text(payload.event, 24);
  if (!ALLOWED_EVENTS.has(eventType)) return response(400, "invalid event");

  const now = new Date();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const visitorHash = await stableVisitorHash(ip, env.IP_HASH_SALT);
  const cf = request.cf || {};
  const ua = classifyUserAgent(request.headers.get("User-Agent"));
  const referrerHost = text(payload.referrer_host, 255).toLowerCase();
  const source = text(payload.utm_source, 120) ||
    (referrerHost && referrerHost !== url.hostname ? referrerHost : "direct");

  const statement = env.DB.prepare(`
    INSERT OR IGNORE INTO analytics_events (
      event_id, created_at, client_ts, event_type, event_value, event_label,
      session_id, visitor_hash, path, landing_page, page_title, invite_code,
      traffic_source, referrer_host, utm_source, utm_medium, utm_campaign,
      utm_content, utm_term, country, region, city, colo, asn,
      network_name, device, browser, os, language, timezone,
      screen_width, screen_height, is_bot
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    text(payload.event_id, 80) || crypto.randomUUID(),
    now.toISOString(),
    text(payload.client_ts, 40),
    eventType,
    text(payload.value, 120),
    text(payload.label, 160),
    text(payload.session_id, 100),
    visitorHash,
    text(payload.path, 500) || "/",
    text(payload.landing_page, 500) || "/",
    text(payload.page_title, 200),
    text(payload.invite_code, 100),
    source,
    referrerHost || "direct",
    text(payload.utm_source, 120),
    text(payload.utm_medium, 120),
    text(payload.utm_campaign, 160),
    text(payload.utm_content, 160),
    text(payload.utm_term, 160),
    text(cf.country, 8),
    text(cf.region, 120),
    text(cf.city, 120),
    text(cf.colo, 20),
    integer(cf.asn, 4294967295),
    text(cf.asOrganization, 200),
    text(payload.device, 30) || ua.device,
    text(payload.browser, 40) || ua.browser,
    text(payload.os, 40) || ua.os,
    text(payload.language, 30),
    text(payload.timezone, 80),
    integer(payload.screen_width),
    integer(payload.screen_height),
    ua.isBot,
  );

  try {
    await statement.run();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("analytics insert failed", error);
    return response(500, "analytics error");
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      if (!["GET", "HEAD"].includes(request.method)) return response(405, "method not allowed");
      if (!env.DASHBOARD_PASSWORD) return response(503, "dashboard unavailable");
      if (!(await dashboardAuthorized(request, env))) return unauthorized();
      return adminPage(request, env, url);
    }

    if (url.pathname === "/analytics" || url.pathname === "/analytics.html") {
      if (!["GET", "HEAD"].includes(request.method)) return response(405, "method not allowed");
      if (!env.DASHBOARD_PASSWORD) return response(503, "dashboard unavailable");
      if (!(await dashboardAuthorized(request, env))) return unauthorized();
      return dashboardPage(request, env, url);
    }

    if (url.pathname === "/api/config") {
      if (request.method !== "GET") return response(405, "method not allowed");
      return publicConfig(env);
    }

    if (url.pathname === "/api/admin/settings") {
      if (!["GET", "PUT"].includes(request.method)) return response(405, "method not allowed");
      if (!env.DASHBOARD_PASSWORD) return response(503, "dashboard unavailable");
      if (!(await dashboardAuthorized(request, env))) return unauthorized();
      try {
        return request.method === "GET"
          ? jsonResponse(await currentInviteSetting(env))
          : await updateInviteSetting(request, env, url);
      } catch (error) {
        console.error("settings request failed", error);
        return jsonResponse({ error: "settings unavailable" }, 500);
      }
    }

    if (url.pathname === "/api/analytics") {
      if (request.method !== "GET") return response(405, "method not allowed");
      if (!env.DASHBOARD_PASSWORD) return response(503, "dashboard unavailable");
      if (!(await dashboardAuthorized(request, env))) return unauthorized();
      try {
        return await analyticsReport(env, url);
      } catch (error) {
        console.error("analytics report failed", error);
        return jsonResponse({ error: "report unavailable" }, 500);
      }
    }

    if (url.pathname === "/api/track" || url.pathname === "/api/t") {
      if (!["GET", "POST"].includes(request.method)) return response(405, "method not allowed");
      return track(request, env, url);
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, analytics: Boolean(env.DB && env.IP_HASH_SALT) });
    }

    if (url.pathname === "/linki-page.txt") {
      return Response.redirect(`${url.origin}/LINKI`, 308);
    }

    if (["/VPNAH/tutorial/", "/VPNAH/tutorial.html", "/vpnah-tutorial-page.txt"].includes(url.pathname)) {
      return redirectPath(url, "/VPNAH/tutorial");
    }

    if (url.pathname === "/VPNAH/tutorial") {
      if (!["GET", "HEAD"].includes(request.method)) return response(405, "method not allowed");
      return vpnahPageAsset(request, env, url, "/vpnah-tutorial-page.txt", "/VPNAH/tutorial");
    }

    if (url.pathname === "/vpnah-page.txt") {
      return Response.redirect(`${url.origin}/VPNAH`, 308);
    }

    if (url.pathname === "/dpg78v-page.txt") {
      return Response.redirect(`${url.origin}/DPG78V`, 308);
    }

    if (url.pathname === "/usmkt-page.txt") {
      return Response.redirect(`${url.origin}/USMKT`, 308);
    }

    if (inviteCodeFromPath(url.pathname)) {
      if (!["GET", "HEAD"].includes(request.method)) return response(405, "method not allowed");
      return inviteLandingPage(request, env, url);
    }

  return publicAsset(request, env);
}

function withVersionMetadata(responseValue, env) {
  const versionId = env.WORKER_VERSION?.id;
  if (!versionId) return responseValue;
  const headers = new Headers(responseValue.headers);
  headers.set("X-BIT-Worker-Version", versionId);
  return new Response(responseValue.body, {
    status: responseValue.status,
    statusText: responseValue.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    return withVersionMetadata(await handleRequest(request, env), env);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM analytics_events WHERE created_at < datetime('now', '-180 days')").run(),
    );
  },
};
