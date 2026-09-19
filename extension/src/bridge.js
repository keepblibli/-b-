/*
 * ISOLATED world content script（抖音 + B站共用）。
 * 职责只有两件：把 MAIN world 抛出的消息转给 service worker；DOM 文本兜底。
 *
 * 注意：这里是 ISOLATED world，看不到 MAIN world 的 window.__liveCollectorPlatforms，
 * 所以平台判断与 DOM 规则在本文件里各写一份（就几行正则，不值得为它搞跨 world 通信）。
 */
(() => {
  'use strict';

  const CHANNEL = 'dy-live-collector';
  const DOM_SCAN_MS = 4000;
  const MULTIPLIER = { 万: 1e4, 亿: 1e8, '': 1 };

  // ------------------------------------------------------------- 平台判定
  const PLATFORM = /(^|\.)bilibili\.com$/i.test(location.hostname) ? 'bilibili' : 'douyin';

  // 房间 key 统一规则（与 background.js 的 canonicalRoomId 保持一致）
  const roomIdFromUrl = () => {
    if (PLATFORM === 'bilibili') {
      const m = location.pathname.match(/^\/(\d+)/);
      return m ? m[1] : '';
    }
    const byPath = location.pathname.match(/^\/(\d{6,})/);
    if (byPath) return byPath[1];
    const byQuery = new URLSearchParams(location.search).get('live_web_rid');
    if (byQuery && /^\d{6,}$/.test(byQuery)) return byQuery;
    return '';
  };

  // ------------------------------------------------------------- DOM 规则
  const RULES = {
    douyin: [
      // 房间页真实的在线人数文案是“在线观众 · 1万”（榜单入口按钮），不是“x人在线”
      { metric: 'online', re: /在线观众\s*[·:：]?\s*(\d+(?:\.\d+)?)\s*(万|亿)?/ },
      { metric: 'online', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人在线/ },
      { metric: 'watched', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人看过/ },
      // 点赞文案是“72.9万 本场点赞”，数字在标签前面
      { metric: 'likes', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*本场点赞/ }
    ],
    bilibili: [
      // 侧栏表头“房间观众(7582)”——B 站最接近真实并发观众的数
      { metric: 'room_viewers', re: /房间观众\s*[（(]?\s*(\d+(?:\.\d+)?)\s*(万|亿)?/ },
      // 主播名旁边的“25.9 万点赞”
      { metric: 'likes', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*点赞/ },
      // 累计观看（B 站部分版式会显示）
      { metric: 'watched', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人看过/ },
      // 人气值（房间页不一定有，广场卡片上有）
      { metric: 'popularity', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人气/ }
    ]
  }[PLATFORM];

  const send = (type, payload) => {
    try {
      chrome.runtime.sendMessage({ type, payload }).catch(() => {});
    } catch (_) {
      /* service worker 正在重启时忽略 */
    }
  };

  // ---------------------------------------------------------- 转发页面消息
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__ch !== CHANNEL) return;
    if (!data.platform) data.platform = PLATFORM;
    send('dy-sample', data);
  });

  // ------------------------------------------------------------- DOM 兜底
  function scanOne(rule) {
    const nodes = document.querySelectorAll('span,div,p,b,strong,button,a');
    for (const el of nodes) {
      const text = el.textContent || '';
      if (text.length === 0 || text.length > 30) continue;
      // 叶子节点随便匹配；容器节点只允许很浅很小（例如“在线观众 · 1万”这种按钮）
      const kids = el.children.length;
      if (kids > 3 || (kids > 0 && text.length > 20)) continue;
      const m = text.match(rule.re);
      if (!m) continue;
      const value = Math.round(parseFloat(m[1]) * MULTIPLIER[m[2] || '']);
      if (!Number.isFinite(value)) continue;
      send('dy-sample', {
        __ch: CHANNEL,
        kind: 'dom',
        platform: PLATFORM,
        ts: Date.now(),
        href: location.href,
        data: { metric: rule.metric, value, text: m[0], roomId: roomIdFromUrl() }
      });
      return true;
    }
    return false;
  }

  function scanDom() {
    for (const rule of RULES) scanOne(rule);
  }

  try {
    setInterval(scanDom, DOM_SCAN_MS);
    setTimeout(scanDom, 1500);
  } catch (_) {
    /* 忽略 */
  }
})();
