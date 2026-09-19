/*
 * MV3 service worker：采样节流 + 批量上报 + 断线缓存 + 角标显示。
 *
 * 采样策略（自适应）：
 *   - 同一个 (房间, 指标) 的值没变 → 最快也要 MIN_GAP_MS 才记一条
 *   - 值变化超过 10% → 允许加密到 FAST_GAP_MS
 *   - 无论有没有变化，HEARTBEAT_MS 至少留一条，保证曲线不断档
 * 上报失败时数据进 chrome.storage.local 队列，service worker 被回收也不会丢。
 */
const ENDPOINT = 'http://127.0.0.1:8787/api/samples';
const MIN_GAP_MS = 5000;
const FAST_GAP_MS = 2000;
const HEARTBEAT_MS = 20000;
const MAX_QUEUE = 500;
const QUEUE_KEY = 'dy_pending_queue';
const DIAG_KEY = 'dy_diagnostics';

const lastSent = new Map(); // key -> {ts, value}
let queue = [];
let flushing = false;
let ready = false;

// ------------------------------------------------------------------ 工具
const multiplierOf = (unit) => (unit === '万' ? 1e4 : unit === '亿' ? 1e8 : 1);

function parseCnNumber(text) {
  if (typeof text !== 'string') return null;
  const m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(万|亿)?/);
  if (!m) return null;
  const value = Math.round(parseFloat(m[1]) * multiplierOf(m[2] || ''));
  return Number.isFinite(value) ? value : null;
}

function formatCn(value) {
  if (value == null) return '';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return String(value);
}

function firstNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const parsed = parseCnNumber(v);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function firstText(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// ------------------------------------------------------------- 采样决策
function shouldKeep(roomId, metric, value, ts) {
  const key = `${roomId}|${metric}`;
  const last = lastSent.get(key);
  if (!last) {
    lastSent.set(key, { ts, value });
    return true;
  }
  const delta = ts - last.ts;
  const changed = value !== last.value;
  let gap = MIN_GAP_MS;
  if (changed && last.value) {
    const ratio = Math.abs(value - last.value) / Math.max(1, last.value);
    if (ratio >= 0.1) gap = FAST_GAP_MS;
  }
  if (!changed && delta < HEARTBEAT_MS) return false;
  if (delta < gap) return false;
  lastSent.set(key, { ts, value });
  return true;
}

// ------------------------------------------------------------------ 上报
async function loadQueue() {
  if (ready) return;
  ready = true;
  try {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const arr = stored?.[QUEUE_KEY];
    if (Array.isArray(arr)) queue = arr.slice(-MAX_QUEUE);
  } catch (_) {
    /* 忽略 */
  }
}

async function persistQueue() {
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });
  } catch (_) {
    /* 忽略 */
  }
}

async function diagnose(patch) {
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const diag = { ...(stored?.[DIAG_KEY] || {}), ...patch, at: Date.now() };
    await chrome.storage.local.set({ [DIAG_KEY]: diag });
    void pushDiag();
  } catch (_) {
    /* 忽略 */
  }
}

/**
 * 顺带把自检信息推给本地服务，这样排查时不需要开 devtools 翻 storage
 * （面板和 /api/diagnostics 直接就告诉你三条通道哪条活着）。
 */
let lastDiagPushAt = 0;
async function pushDiag() {
  if (Date.now() - lastDiagPushAt < 8000) return;
  lastDiagPushAt = Date.now();
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 顺带汇报积压队列长度：服务长时间不可用时，这个数字能直接告诉你丢了多少
      body: JSON.stringify({
        samples: [],
        diag: { ...(stored?.[DIAG_KEY] || {}), queueLength: queue.length, at: Date.now() }
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (_) {
    /* 服务没起来时静默，下次再说 */
  }
}

async function flush() {
  await loadQueue();
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.slice(0, 200);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: batch })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    queue = queue.slice(batch.length);
    await persistQueue();
    await diagnose({ endpointOk: true, lastPushAt: Date.now(), serverAccepted: body?.accepted ?? null });
  } catch (e) {
    await diagnose({ endpointOk: false, lastError: String(e && e.message ? e.message : e) });
  } finally {
    flushing = false;
    if (queue.length > 0) setTimeout(() => flush(), 3000);
  }
}

function enqueue(sample) {
  queue.push(sample);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  void persistQueue();
  void flush();
}

// ------------------------------------------------------------- 角标显示
const badgeValue = new Map();
// 角标优先显示“最像观众数”的指标：抖音 online > B站 room_viewers > 累计看过 > 人气
const BADGE_METRICS = ['online', 'room_viewers', 'watched', 'popularity'];

function refreshBadge(roomId, metric, value) {
  if (!BADGE_METRICS.includes(metric)) return;
  badgeValue.set(`${roomId}|${metric}`, value);
  let picked = null;
  for (const m of BADGE_METRICS) {
    const hit = [...badgeValue.entries()].filter(([k]) => k.endsWith(`|${m}`)).pop();
    if (hit) {
      picked = hit;
      break;
    }
  }
  const text = picked ? formatCn(picked[1]) : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' }).catch(() => {});
}

// ------------------------------------------------------------- 消息处理
function makeSample(roomId, metric, value, text, source, extra = {}) {
  if (value == null || !Number.isFinite(value)) return null;
  const ts = extra.ts || Date.now();
  if (!shouldKeep(roomId || 'unknown', metric, value, ts)) return null;
  refreshBadge(roomId || 'unknown', metric, value);
  return {
    roomId: roomId || 'unknown',
    ts,
    metric,
    value,
    text: text || formatCn(value),
    source,
    nickname: extra.nickname || null,
    title: extra.title || null,
    webRid: extra.webRid || null,
    status: extra.status ?? null,
    raw: extra.raw ?? null
  };
}

function handleWsSeq(payload) {
  const d = payload.data || {};
  const roomId = canonicalRoomId(payload);
  const out = [];
  const online = makeSample(roomId, 'online', d.online, d.onlineText, 'ws', {
    ts: payload.ts,
    raw: { method: d.method }
  });
  if (online) out.push(online);
  const watched = makeSample(roomId, 'watched', d.watched, d.watchedText, 'ws', {
    ts: payload.ts,
    // 累计观看变化慢，节流由 shouldKeep 统一处理
    raw: { method: d.method }
  });
  if (watched) out.push(watched);
  out.forEach(enqueue);
}

/**
 * 点赞只从 WebSocket 的 LikeMessage.total 取。
 * enter 接口的 stats.like_count 是进房瞬间的快照，实测恒为 0（页面同时显示 72.9万），
 * 所以那条路彻底不用；这里拿到的就是页面右上角“本场点赞”的同一个累计值。
 */
function handleWsLike(payload) {
  const d = payload.data || {};
  const roomId = canonicalRoomId(payload);
  const sample = makeSample(roomId, 'likes', d.total, null, 'ws', {
    ts: payload.ts,
    raw: { method: d.method, delta: d.delta }
  });
  if (sample) enqueue(sample);
}

const WATCHED_KEYS = ['total_user', 'total_user_count', 'watched_count'];
const WATCHED_TEXT_KEYS = ['total_user_str', 'total_user_desp'];
const ONLINE_KEYS = ['user_count', 'display_value', 'online_user_count', 'online_count'];
const ONLINE_TEXT_KEYS = ['user_count_str', 'display_short'];

function handleEnterApi(payload) {
  const room = payload.data?.room;
  if (!room) return;
  // stats 与 room_view_stats 字段名不同，合并后一起找；两者同名字段时以 stats 为准
  const fields = { ...(room.viewStats || {}), ...(room.stats || {}) };
  const meta = {
    nickname: room.nickname,
    title: room.title,
    webRid: room.webRid,
    status: room.status,
    raw: { realRoomId: room.roomId, stats: room.stats, viewStats: room.viewStats, roomKeys: room.roomKeys }
  };
  // 统一用 URL 的 web_rid 做 key，真实 room_id 只留档在 raw.realRoomId
  const roomId = canonicalRoomId(payload, room.roomId);

  const watchedText = firstText(fields, WATCHED_TEXT_KEYS);
  const watched = firstNumber(fields, WATCHED_KEYS) ?? parseCnNumber(watchedText);
  const onlineText = firstText(fields, ONLINE_TEXT_KEYS);
  // 注意：绝不能用 watchedText 给 online 兜底——那是累计观看，不是在线人数
  const online = firstNumber(fields, ONLINE_KEYS) ?? parseCnNumber(onlineText);

  const samples = [
    makeSample(roomId, 'watched', watched, watchedText, 'api', { ...meta, ts: payload.ts }),
    makeSample(roomId, 'online', online, onlineText, 'api', { ...meta, ts: payload.ts })
    // 故意不产出 likes：这条路上的 stats.like_count 实测恒为 0（页面同时显示 72.9万）。
    // 点赞改由 WS 的 LikeMessage.total 提供，见 handleWsLike()。
  ].filter(Boolean);

  samples.forEach(enqueue);
  void diagnose({
    lastEnterApiAt: Date.now(),
    enterApiKeys: Object.keys(fields).slice(0, 80),
    enterRoomKeys: room.roomKeys
  });
}

function handleDom(payload) {
  const d = payload.data || {};
  const roomId = canonicalRoomId(payload, d.roomId);
  const sample = makeSample(roomId, d.metric, d.value, d.text, 'dom', { ts: payload.ts });
  if (sample) enqueue(sample);
}

/**
 * 房间的唯一 key。
 *
 * 抖音：URL 里的是 web_rid，真实 room_id 只在接口里 —— 统一用 URL 那个，
 *       否则 WS 和接口会各建一行。
 * B站：URL path 就是真 room_id（如 live.bilibili.com/33989），直接用。
 *
 * 两个平台的数字 ID 完全可能撞车，所以统一加平台前缀：dy:xxxx / bili:xxxx。
 */
function roomIdFromHref(href, platform) {
  if (!href) return '';
  const text = String(href);
  try {
    const url = new URL(text);
    if (platform === 'bilibili' || /(^|\.)bilibili\.com$/i.test(url.hostname)) {
      const m = url.pathname.match(/^\/(\d+)/);
      if (m) return m[1];
      return '';
    }
    const byPath = url.pathname.match(/^\/(\d{6,})/);
    if (byPath) return byPath[1];
    const byQuery = url.searchParams.get('live_web_rid') || url.searchParams.get('web_rid');
    if (byQuery && /^\d{6,}$/.test(byQuery)) return byQuery;
  } catch (_) {
    /* 非法 URL，走下面的兜底 */
  }
  const any = text.match(/\/(\d{6,})(?:[/?#]|$)/);
  return any ? any[1] : '';
}

function canonicalRoomId(payload, fallback) {
  const platform = payload?.platform === 'bilibili' ? 'bilibili' : 'douyin';
  const raw = roomIdFromHref(payload?.href, platform) || fallback || 'unknown';
  const prefix = platform === 'bilibili' ? 'bili' : 'dy';
  return `${prefix}:${raw}`;
}

// ------------------------------------------------------------- B 站专用处理
/**
 * B 站人气值 —— 实测结论：**心跳回复里那个 4 字节不是真实人气值**。
 *
 * 实测数据：泛式直播间（房间页显示 12 万人气）的心跳回复 body 恒为 `00 00 00 01`，
 * 大端读出 1、小端读出 16777216。B 站早就把心跳里这个字段废弃成占位值了，
 * 所以这条通道直接不用，人气改由接口/页面 DOM 提供。
 */
function handleWsPopularity(payload) {
  const d = payload.data || {};
  // 只做诊断记录，不入库
  void diagnose({
    biliHeartbeatPopularity: { be: d.be, le: d.le, bodyLen: d.bodyLen, at: Date.now() },
    biliHeartbeatNote: '心跳里的人气值是占位值，不可用；人气请走接口/DOM'
  });
}

/**
 * 在任意接口响应里递归找某个字段 —— 新版房间页不用 getInfoByRoom 了，
 * 我们不知道数据藏在哪个接口，所以不写死路径。
 */
function findByKey(obj, key, depth = 6) {
  if (depth < 0 || !obj || typeof obj !== 'object') return undefined;
  if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const value of Object.values(obj)) {
    const hit = findByKey(value, key, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function handleWsWatched(payload) {
  const d = payload.data || {};
  const roomId = canonicalRoomId(payload);
  const value = Number.isFinite(d.num) ? d.num : parseCnNumber(d.text);
  const sample = makeSample(roomId, 'watched', value, d.text, 'ws', { ts: payload.ts });
  if (sample) enqueue(sample);
}

function handleWsOnlineRank(payload) {
  const d = payload.data || {};
  const roomId = canonicalRoomId(payload);
  const sample = makeSample(roomId, 'online_rank', d.count, null, 'ws', { ts: payload.ts });
  if (sample) enqueue(sample);
}

/** B 站房间接口：不写死接口名与字段路径，递归找我们认识的字段 */
function handleRoomApi(payload) {
  const json = payload.data?.json;
  const url = payload.data?.url || '';
  if (!json) return;

  // 新版房间页不用 getInfoByRoom，数据可能散在任意接口里 —— 递归找
  const watchedShow = findByKey(json, 'watched_show') || findByKey(json, 'watchedShow') || {};
  // ⚠️ B 站的字段名叫 online，但它**是热度人气值、不是人数**（实测：SSR 给 267605，
  // 公开接口 Room/get_info 给 263356，同量级；而房间观众只有 7239、看过 12.5万）。
  // 所以这里映射成 popularity，别把它当 online 用。
  const popularityRaw = findByKey(json, 'popularity') ?? findByKey(json, 'online');
  // 实测：SSR 里这个字段经常是 0（不是缺失，就是 0）。直播中人气为 0 不可能，
  // 所以 0 一律当"没拿到"，否则会在曲线上打出一个假的谷底。
  const popularity = Number.isFinite(popularityRaw) && popularityRaw > 0 ? popularityRaw : null;
  const fansCount = findByKey(json, 'attention') ?? findByKey(json, 'fans_count') ?? findByKey(json, 'fans');
  const roomIdRaw = findByKey(json, 'room_id');
  const liveStatus = findByKey(json, 'live_status');
  const title = findByKey(json, 'title');
  const uname = findByKey(json, 'uname');

  const roomId = canonicalRoomId(payload, roomIdRaw ? String(roomIdRaw) : '');
  const meta = {
    nickname: typeof uname === 'string' ? uname : null,
    title: typeof title === 'string' ? title : null,
    status: Number.isFinite(liveStatus) ? liveStatus : null,
    raw: {
      url,
      foundKeys: Object.keys(json).slice(0, 40),
      watchedShow,
      popularity: Number.isFinite(popularity) ? popularity : null
    }
  };

  const samples = [
    makeSample(
      roomId,
      'watched',
      Number.isFinite(watchedShow?.num) ? watchedShow.num : parseCnNumber(watchedShow?.text_large),
      watchedShow?.text_large || null,
      'api',
      { ...meta, ts: payload.ts }
    ),
    makeSample(roomId, 'popularity', Number.isFinite(popularity) ? popularity : null, null, 'api', { ...meta, ts: payload.ts }),
    makeSample(roomId, 'fans', Number.isFinite(fansCount) ? fansCount : null, null, 'api', { ...meta, ts: payload.ts })
  ].filter(Boolean);

  samples.forEach(enqueue);
  void diagnose({
    lastRoomApiAt: Date.now(),
    roomApiUrl: url,
    roomApiRoomId: roomIdRaw ?? null,
    roomApiLiveStatus: liveStatus ?? null,
    roomApiFound: {
      popularity: Number.isFinite(popularity) ? popularity : null,
      watched: watchedShow?.num ?? null,
      watchedText: watchedShow?.text_large ?? null,
      fans: Number.isFinite(fansCount) ? fansCount : null
    },
    roomApiTopKeys: Object.keys(json).slice(0, 40)
  });
}

/**
 * B 站 SSR 全局状态里捞出来的房间信息（新版房间页不走 XHR，数据内联在页面里）。
 * 结构与 handleRoomApi 一致，直接复用同一套字段查找逻辑。
 */
function handleSsrState(payload) {
  const d = payload.data || {};
  if (!d.data || !d.found?.length) return;
  handleRoomApi({ ...payload, data: { url: `ssr:${d.globalName}`, json: d.data } });
  void diagnose({
    biliSsrGlobal: d.globalName,
    biliSsrFound: d.found,
    biliSsrAt: payload.ts
  });
}

/** B 站 WS 诊断：op/protover 分布、cmd 计数与首个样本、字节序探测结果 */function handleBiliStats(payload) {
  const s = payload.data?.stats || {};
  const cmds = Object.keys(s.cmdCounts || {});
  const hint = !s.headerEndian
    ? '还没收到可解析的帧'
    : s.brotliSupported === false
      ? 'brotli 不被浏览器支持：只靠心跳人气值 + 接口'
      : `头部字节序=${s.headerEndian}，已解出 ${s.jsonMessages || 0} 条 JSON 通知`;

  void diagnose({
    biliStatsAt: payload.ts,
    bili: {
      frames: s.frames,
      headerEndian: s.headerEndian,
      opSeen: s.opSeen,
      protoverSeen: s.protoverSeen,
      heartbeatReplies: s.heartbeatReplies,
      popularityProbe: s.popularityProbe,
      zlibOk: s.zlibOk,
      zlibFail: s.zlibFail,
      brotliSupported: s.brotliSupported,
      brotliOk: s.brotliOk,
      brotliFail: s.brotliFail,
      jsonMessages: s.jsonMessages,
      cmdCounts: s.cmdCounts,
      cmdSamples: s.cmdSamples,
      firstFrameHex: s.firstFrameHex,
      lastError: s.lastError
    },
    biliCmdList: cmds,
    biliHint: hint
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'dy-sample') return false;
  const payload = msg.payload || {};
  try {
    switch (payload.kind) {
      case 'ws-seq':
        handleWsSeq(payload);
        break;
      case 'ws-like':
        handleWsLike(payload);
        break;
      case 'ws-popularity':
        handleWsPopularity(payload);
        break;
      case 'ws-watched':
        handleWsWatched(payload);
        break;
      case 'ws-online-rank':
        handleWsOnlineRank(payload);
        break;
      case 'room-api':
        handleRoomApi(payload);
        break;
      case 'ssr-state':
        handleSsrState(payload);
        break;
      case 'ssr-stale':
        // SSR 全局还是上一页的数据（SPA 跳转），丢掉，只记诊断
        void diagnose({
          biliSsrStale: payload.data,
          biliSsrStaleAt: payload.ts,
          biliSsrStaleNote: 'URL 与 SSR 的 room_id 不一致，已丢弃，避免凭空造房间'
        });
        break;
      case 'ws-stats':
        handleBiliStats(payload);
        break;
      case 'enter-api':
        handleEnterApi(payload);
        break;
      case 'dom':
        handleDom(payload);
        break;
      case 'ws-open':
        void diagnose({ lastWsOpenAt: payload.ts, wsUrl: payload.data?.url });
        break;
      case 'ws-methods':
        void diagnose({
          wsMethods: payload.data?.methods,
          wsStats: payload.data?.stats,
          wsMethodsAt: payload.ts
        });
        break;
      case 'hook-ready':
        void diagnose({ lastHookReadyAt: payload.ts, hookHref: payload.href });
        break;
      case 'error':
        void diagnose({ lastHookError: payload.data });
        break;
      default:
        break;
    }
  } catch (e) {
    void diagnose({ lastHandlerError: String(e) });
  }
  sendResponse({ ok: true });
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#fe2c55' }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => void flush());

/*
 * 定时补发（每分钟一次）。
 * 为什么必须有：MV3 的 service worker 只在"有事件"时才醒（页面消息、onStartup、alarms）。
 * 如果服务长时间不可用 → 采样积压在 chrome.storage.local → 之后用户没开直播间页面、
 * 也没重启浏览器，就**没有任何事件能唤醒 SW**，积压永远发不出去。
 * 实测踩到过：服务恢复后 44 小时一条都没补发。
 */
const FLUSH_ALARM = 'dy-flush';
try {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flush();
  });
} catch (_) {
  /* 没有 alarms 权限时不影响主流程 */
}
