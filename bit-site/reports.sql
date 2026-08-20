-- 过去 7 天核心指标
SELECT
  COUNT(CASE WHEN event_type = 'view' THEN 1 END) AS pageviews,
  COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END) AS unique_visitors,
  COUNT(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 END) AS signup_clicks,
  ROUND(100.0 * COUNT(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 END) /
    NULLIF(COUNT(CASE WHEN event_type = 'view' THEN 1 END), 0), 2) AS click_rate_pct
FROM analytics_events
WHERE created_at >= datetime('now', '-7 days') AND is_bot = 0;

-- 来源、媒介和活动表现
SELECT traffic_source, utm_medium, utm_campaign,
  COUNT(CASE WHEN event_type = 'view' THEN 1 END) AS pageviews,
  COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END) AS visitors,
  COUNT(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 END) AS signup_clicks
FROM analytics_events
WHERE created_at >= datetime('now', '-30 days') AND is_bot = 0
GROUP BY traffic_source, utm_medium, utm_campaign
ORDER BY pageviews DESC;

-- 地域与网络（不含原始 IP）
SELECT country, region, city, asn, network_name,
  COUNT(DISTINCT visitor_hash) AS visitors,
  COUNT(*) AS events
FROM analytics_events
WHERE created_at >= datetime('now', '-30 days') AND is_bot = 0
GROUP BY country, region, city, asn, network_name
ORDER BY visitors DESC;

-- 设备、浏览器和系统
SELECT device, browser, os,
  COUNT(DISTINCT visitor_hash) AS visitors,
  COUNT(CASE WHEN event_type = 'click' AND event_value = 'signup' THEN 1 END) AS signup_clicks
FROM analytics_events
WHERE created_at >= datetime('now', '-30 days') AND is_bot = 0
GROUP BY device, browser, os
ORDER BY visitors DESC;
