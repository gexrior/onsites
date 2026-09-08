(function () {
  'use strict';

  function canonicalPath(pathname) {
    var path = pathname.replace(/\/+$/, '').toUpperCase();
    if (path === '/LINKI') return '/LINKI';
    if (path === '/VPNAH') return '/VPNAH';
    if (path === '/VPNAH/TUTORIAL') return '/VPNAH/tutorial';
    return '';
  }

  var path = canonicalPath(location.pathname);
  if (!path || window.__bitChannelAnalyticsLoaded) return;
  window.__bitChannelAnalyticsLoaded = true;

  var channel = path === '/LINKI' ? 'LINKI' : 'VPNAH';
  var params = new URLSearchParams(location.search);
  var utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var sid = '';

  function eventId() {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  try {
    sid = sessionStorage.getItem('_bsid');
    if (!sid) {
      sid = eventId();
      sessionStorage.setItem('_bsid', sid);
    }
  } catch (_) {}
  if (!sid) sid = eventId();

  var referrer = null;
  try {
    if (document.referrer) referrer = new URL(document.referrer);
  } catch (_) {}
  var attribution = {
    landing_page: path,
    referrer_host: referrer ? referrer.hostname : 'direct'
  };
  utmKeys.forEach(function (key) { attribution[key] = params.get(key) || ''; });

  if (channel === 'VPNAH') {
    var attributionKey = '_bchannel:VPNAH';
    var previousPath = referrer ? canonicalPath(referrer.pathname) : '';
    var sameChannelReferrer = referrer && referrer.origin === location.origin &&
      (previousPath === '/VPNAH' || previousPath === '/VPNAH/tutorial');
    var hasCampaign = utmKeys.some(function (key) { return params.has(key); });
    try {
      // Direct visits start fresh; only navigation within this channel inherits its campaign.
      if (sameChannelReferrer && !hasCampaign) {
        var stored = JSON.parse(sessionStorage.getItem(attributionKey) || 'null');
        if (stored && (stored.landing_page === '/VPNAH' || stored.landing_page === '/VPNAH/tutorial')) {
          attribution.landing_page = stored.landing_page;
          attribution.referrer_host = typeof stored.referrer_host === 'string' ? stored.referrer_host : 'direct';
          utmKeys.forEach(function (key) {
            attribution[key] = typeof stored[key] === 'string' ? stored[key] : '';
          });
        }
      }
      sessionStorage.setItem(attributionKey, JSON.stringify(attribution));
    } catch (_) {}
  } else {
    // LINKI's existing inline tracker remains the owner of its session landing page.
    try { attribution.landing_page = sessionStorage.getItem('_blanding') || path; } catch (_) {}
  }

  var ua = navigator.userAgent || '';
  var uaData = navigator.userAgentData || {};
  var device = uaData.mobile || /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop';
  var browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  var os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  var timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}

  function track(event, value, label) {
    var payload = {
      event_id: eventId(), event: event, value: value == null ? '' : String(value), label: label || '',
      session_id: sid, invite_code: channel, path: path, landing_page: attribution.landing_page,
      page_title: document.title, referrer_host: attribution.referrer_host,
      device: device, browser: browser, os: os, language: navigator.language || '', timezone: timezone,
      screen_width: window.screen ? window.screen.width || 0 : 0,
      screen_height: window.screen ? window.screen.height || 0 : 0,
      client_ts: new Date().toISOString()
    };
    utmKeys.forEach(function (key) { payload[key] = attribution[key]; });
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }))) return;
    } catch (_) {}
    try {
      fetch('/api/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
        keepalive: true, credentials: 'same-origin'
      }).catch(function () {});
    } catch (_) {}
  }

  function downloadLabel(anchor, url) {
    var storePath = channel === 'LINKI' ? '/eeWZn' : '/fUeJX';
    var apkPath = channel === 'LINKI'
      ? '/matrixport-official-master-19-25_234bclet.apk'
      : '/matrixport-official-master-19-25_23e214yv.apk';
    if (url.hostname === 'download.onsites.me' && url.pathname === apkPath) return 'android-apk';
    if (channel === 'VPNAH' && url.hostname === 'testflight.apple.com' && url.pathname === '/join/fDcUTACO') return 'testflight';
    if (url.hostname !== 'bit.go.link' || url.pathname !== storePath) return '';
    var label = anchor.getAttribute('data-download-link');
    if (label === 'app-store' || label === 'google-play') return label;
    if (anchor.classList.contains('ios')) return 'app-store';
    if (anchor.classList.contains('gp')) return 'google-play';
    return '';
  }

  document.addEventListener('click', function (event) {
    var anchor = event.target;
    while (anchor && anchor !== document && !(anchor.tagName === 'A' && anchor.hasAttribute('href'))) {
      anchor = anchor.parentNode;
    }
    if (!anchor || anchor === document) return;
    var url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    var label = downloadLabel(anchor, url);
    if (label) {
      track('click', 'download', label);
    } else if (url.origin === location.origin &&
      url.pathname.replace(/\/+$/, '').toUpperCase() === '/' + channel + '/TUTORIAL') {
      track('click', 'tutorial', (anchor.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'tutorial');
    }
  }, true);

  // LINKI already reports view, signup, scroll and dwell in its unchanged inline tracker.
  if (channel === 'LINKI') return;

  track('view');
  var marks = { 25: false, 50: false, 75: false, 100: false };
  window.addEventListener('scroll', function () {
    var scrollTop = window.scrollY || document.documentElement.scrollTop;
    var height = document.documentElement.scrollHeight - window.innerHeight;
    var percent = height > 0 ? Math.round(scrollTop / height * 100) : 100;
    [25, 50, 75, 100].forEach(function (mark) {
      if (percent >= mark && !marks[mark]) {
        marks[mark] = true;
        track('scroll', mark);
      }
    });
  }, { passive: true });

  var startedAt = Date.now();
  var dwellSent = false;
  function dwell() {
    if (dwellSent) return;
    dwellSent = true;
    track('dwell', Math.round((Date.now() - startedAt) / 1000));
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') dwell();
  });
  window.addEventListener('pagehide', dwell);
})();
