/*
 * B 站直播采集（MAIN world）。
 *
 * 与抖音版的关系：两条独立的注入脚本，各自判断域名后决定是否生效，共用同一条
 * postMessage 通道（__ch = 'dy-live-collector'，带 platform 字段）。等 B 站协议
 * 在真实页面上验证通过后，再做 platform-*.js 适配器层的合并重构。
 *
 * B 站弹幕 WS 协议（与抖音的 protobuf 完全不同）：
 *   16 字节头：totalLen(4) headerLen(2) protover(2) op(4) seq(4)
 *   op: 2=心跳 3=心跳回复(包体=4字节人气值) 5=通知 7=认证 8=认证回复
 *   protover: 0=明文JSON 1=int32人气 2=zlib(多包相接) 3=brotli(多包相接)
 *
 * 本文件第一版是**带诊断的探针**：把 op/protover 分布、字节序两种读法、每个 cmd 的
 * 首个 JSON 样本全部上报到服务端（/api/diagnostics），用一次重载把待确认项全部问清楚。
 */
(() => {
  'use strict';

  if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return;
  if (window.__biliCollectorInstalled) return;
  window.__biliCollectorInstalled = true;

  const CHANNEL = 'dy-live-collector';
  const PLATFORM = 'bilibili';

  const post = (kind, data) => {
    try {
      window.postMessage(
        { __ch: CHANNEL, kind, platform: PLATFORM, ts: Date.now(), href: location.href, data },
        '*'
      );
    } catch (_) {
      /* 页面销毁时忽略 */
    }
  };

  const hex = (u8, n = 32) =>
    Array.from(u8.slice(0, n))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');

  // ------------------------------------------------------------------ 诊断统计
  const stats = {
    frames: 0,
    opSeen: {},
    protoverSeen: {},
    headerEndian: null, // 'be' | 'le'，自动探测结果
    heartbeatReplies: 0,
    zlibOk: 0,
    zlibFail: 0,
    brotliOk: 0,
    brotliFail: 0,
    brotliSupported: null,
    jsonMessages: 0,
    cmdCounts: {},
    cmdSamples: {}, // cmd -> 首个 JSON 样本（截断），用来抄字段名
    popularityProbe: null, // { bodyHex, be, le }
    firstFrameHex: '',
    lastError: ''
  };

  const bump = (obj, key) => {
    const k = key === undefined || key === null || key === '' ? '(空)' : String(key);
    obj[k] = (obj[k] || 0) + 1;
  };

  // brotli 支持性只探一次
  try {
    new DecompressionStream('brotli');
    stats.brotliSupported = true;
  } catch (_) {
    stats.brotliSupported = false;
  }

  // ------------------------------------------------------------------ 拆包
  function readHeader(bytes, offset, little) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset);
    return {
      total: dv.getUint32(0, little),
      headerLen: dv.getUint16(4, little),
      protover: dv.getUint16(6, little),
      op: dv.getUint32(8, little),
      seq: dv.getUint32(12, little)
    };
  }

  /** 头长度合理 + 总长不超过剩余字节数，才算解析成功 */
  const plausible = (h, remaining) =>
    h.headerLen >= 16 && h.headerLen <= 64 && h.total >= h.headerLen && h.total <= remaining;

  /** 自动探测大端/小端：先按大端，不合理就换小端，结果缓存 */
  function splitPackets(bytes) {
    const out = [];
    let offset = 0;
    while (offset + 16 <= bytes.length) {
      const remaining = bytes.length - offset;
      let little = stats.headerEndian === 'le';
      let header = readHeader(bytes, offset, little);

      if (!plausible(header, remaining)) {
        const other = readHeader(bytes, offset, !little);
        if (plausible(other, remaining)) {
          little = !little;
          header = other;
          stats.headerEndian = little ? 'le' : 'be';
        } else {
          stats.lastError = `头部两种字节序都不合理 @${offset}: be=${JSON.stringify(readHeader(bytes, offset, false))} le=${JSON.stringify(readHeader(bytes, offset, true))}`;
          break;
        }
      } else if (stats.headerEndian === null) {
        stats.headerEndian = little ? 'le' : 'be';
      }

      bump(stats.opSeen, header.op);
      bump(stats.protoverSeen, header.protover);

      const body = bytes.subarray(offset + header.headerLen, offset + header.total);
      out.push({ ...header, body });
      offset += header.total;
    }
    return out;
  }

  // ------------------------------------------------------------------ 解压
  async function inflate(bytes, format) {
    if (typeof DecompressionStream !== 'function') throw new Error('no DecompressionStream');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ------------------------------------------------------------------ 派发
  const KNOWN_WATCHED = /WATCHED_CHANGE/i;
  const KNOWN_ONLINE_RANK = /ONLINE_RANK_COUNT/i;
  const KNOWN_ROOM_UPDATE = /ROOM_REAL_TIME_MESSAGE_UPDATE/i;

  function dispatchJson(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      stats.lastError = 'JSON: ' + String(e && e.message ? e.message : e);
      return;
    }
    const list = Array.isArray(json) ? json : [json];
    for (const msg of list) {
      if (!msg || typeof msg !== 'object') continue;
      const cmd = msg.cmd || '';
      stats.jsonMessages += 1;
      bump(stats.cmdCounts, cmd);
      if (!stats.cmdSamples[cmd]) {
        // 只留第一个样本，够抄字段名了；同时避免把 stats 撑爆
        try {
          stats.cmdSamples[cmd] = JSON.stringify(msg).slice(0, 400);
        } catch (_) {
          stats.cmdSamples[cmd] = '(无法序列化)';
        }
      }

      if (KNOWN_WATCHED.test(cmd)) {
        post('ws-watched', { num: msg.data?.num ?? null, text: msg.data?.text_large || msg.data?.text_small || '' });
      } else if (KNOWN_ONLINE_RANK.test(cmd)) {
        post('ws-online-rank', { count: msg.data?.count ?? null });
      } else if (KNOWN_ROOM_UPDATE.test(cmd)) {
        post('ws-room-update', { data: msg.data || null });
      }
    }
  }

  async function handlePacket(pkt) {
    if (pkt.op === 3) {
      // 心跳回复：4 字节人气值。字节序未知，两种读法都上报，由数据决定
      stats.heartbeatReplies += 1;
      if (pkt.body.length >= 4) {
        const dv = new DataView(pkt.body.buffer, pkt.body.byteOffset, pkt.body.byteLength);
        const be = dv.getInt32(0, false);
        const le = dv.getInt32(0, true);
        if (!stats.popularityProbe) {
          stats.popularityProbe = { bodyHex: hex(pkt.body, 8), be, le, len: pkt.body.length };
        }
        // 先用大端（公开实现普遍如此），服务端会按“看起来合理”的那个存
        const value = be > 0 ? be : le;
        post('ws-popularity', { popularity: value, be, le, bodyLen: pkt.body.length });
      }
      return;
    }
    if (pkt.op !== 5) return;

    if (pkt.protover === 2) {
      try {
        const plain = await inflate(pkt.body, 'deflate'); // zlib(RFC1950) → 'deflate'
        stats.zlibOk += 1;
        for (const inner of splitPackets(plain)) await handlePacket(inner);
      } catch (e) {
        stats.zlibFail += 1;
        stats.lastError = 'zlib: ' + String(e && e.message ? e.message : e);
      }
    } else if (pkt.protover === 3) {
      try {
        const plain = await inflate(pkt.body, 'brotli');
        stats.brotliOk += 1;
        for (const inner of splitPackets(plain)) await handlePacket(inner);
      } catch (e) {
        stats.brotliFail += 1;
        stats.lastError = 'brotli: ' + String(e && e.message ? e.message : e);
      }
    } else {
      dispatchJson(new TextDecoder('utf-8', { fatal: false }).decode(pkt.body));
    }
  }

  async function handleFrame(buffer) {
    const bytes = new Uint8Array(buffer);
    stats.frames += 1;
    if (!stats.firstFrameHex) stats.firstFrameHex = hex(bytes);
    try {
      const packets = splitPackets(bytes);
      for (const pkt of packets) await handlePacket(pkt);
      if (packets.length === 0 && !stats.lastError) stats.lastError = '拆不出包';
    } catch (e) {
      stats.lastError = 'frame: ' + String(e && e.message ? e.message : e);
    }
    reportStats();
  }

  let reportAt = 0;
  function reportStats(force) {
    const now = Date.now();
    if (!force && now - reportAt < 5000) return;
    if (stats.frames === 0) return;
    reportAt = now;
    post('ws-stats', { stats: { ...stats, cmdSamples: { ...stats.cmdSamples } } });
  }

  // ------------------------------------------------------------------ WS hook
  const NativeWS = window.WebSocket;
  function hookedWebSocket(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    if (typeof url === 'string' && /\/sub(\?|$)/.test(url)) {
      post('ws-open', { url: url.slice(0, 200) });
      ws.addEventListener('message', (ev) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer) handleFrame(data).catch(() => {});
        else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          data.arrayBuffer().then((buf) => handleFrame(buf)).catch(() => {});
        }
      });
    }
    return ws;
  }
  try {
    Object.setPrototypeOf(hookedWebSocket, NativeWS);
    hookedWebSocket.prototype = NativeWS.prototype;
    window.WebSocket = hookedWebSocket;
  } catch (e) {
    stats.lastError = 'websocket hook: ' + String(e);
  }

  // ------------------------------------------------------------------ 接口 hook
  // 新版房间页已经不用 getInfoByRoom 了，数据藏在哪个接口里事先不知道，
  // 所以先宽口径抓 api.live.bilibili.com 的所有 JSON，由 service worker 递归找字段。
  const API_RE = /api\.live\.bilibili\.com\//;
  const MAX_BODY = 300_000; // 超过这个长度的响应直接放弃，避免把大 JSON 塞进消息通道
  const lastSeenPath = new Map();
  const REPEAT_GAP_MS = 30_000;

  function throttled(url) {
    let path = url;
    try {
      path = new URL(url, location.href).pathname;
    } catch (_) {
      /* 用原串兜底 */
    }
    const now = Date.now();
    const prev = lastSeenPath.get(path) || 0;
    if (now - prev < REPEAT_GAP_MS) return true;
    lastSeenPath.set(path, now);
    return false;
  }

  function emitApi(url, json) {
    try {
      post('room-api', { url: String(url).slice(0, 200), json });
    } catch (_) {
      /* 忽略 */
    }
  }

  function emitApiText(url, text) {
    if (!text || text.length > MAX_BODY) return;
    if (throttled(String(url))) return;
    try {
      emitApi(url, JSON.parse(text));
    } catch (_) {
      /* 不是 JSON 就算了 */
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (API_RE.test(url) && !throttled(url)) {
          promise
            .then((res) => {
              res.clone().text().then((t) => emitApiText(url, t)).catch(() => {});
              return res;
            })
            .catch(() => {});
        }
      } catch (_) {
        /* 忽略 */
      }
      return promise;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      const target = String(url || '');
      if (API_RE.test(target)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === 'json') {
              if (!throttled(target)) emitApi(target, this.response);
            } else if (this.responseType === '' || this.responseType === 'text') {
              emitApiText(target, this.responseText);
            }
          } catch (_) {
            /* 忽略 */
          }
        });
      }
    } catch (_) {
      /* 忽略 */
    }
    return nativeOpen.call(this, method, url, ...rest);
  };

  // 调试出口：控制台里可直接调用 window.__biliCollector.stats
  window.__biliCollector = { stats, splitPackets };

  // ------------------------------------------------------------------ SSR 全局状态
  /*
   * 实测结论：新版房间页**不通过 XHR 取房间信息**（宽口径抓了所有
   * api.live.bilibili.com 的响应，递归搜 popularity / watched_show / fans 全为空），
   * 说明数据是 SSR 内联在页面里的。B 站直播间的 SSR 全局是 __NEPTUNE_IS_MY_WAIFU__
   * （页面里的 addWaifu("neptune") 标记就是它）。
   * 直接从全局取，只挑我们认识的那几个子树，避免把整个状态树塞进消息通道。
   */
  function findByKeyLocal(obj, key, depth = 6) {
    if (depth < 0 || !obj || typeof obj !== 'object') return undefined;
    if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const value of Object.values(obj)) {
      const hit = findByKeyLocal(value, key, depth - 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  const SSR_GLOBALS = ['__NEPTUNE_IS_MY_WAIFU__', '__INITIAL_STATE__', 'BilibiliLive'];
  const ssrTried = new Set();
  let ssrHref = '';

  function currentUrlRoomId() {
    const m = location.pathname.match(/^\/(\d+)/);
    return m ? m[1] : '';
  }

  function scanPageGlobals() {
    // SPA 站内跳转时 URL 会变，但 SSR 全局不会重新赋值 —— URL 一变就重新判定
    if (location.href !== ssrHref) {
      ssrHref = location.href;
      ssrTried.clear();
    }
    const urlRoomId = currentUrlRoomId();

    for (const name of SSR_GLOBALS) {
      if (ssrTried.has(name)) continue;
      const root = window[name];
      if (!root || typeof root !== 'object') continue;
      ssrTried.add(name);

      // 从多个可能的挂载点找，SSR 结构各版本不一样，都试一遍
      const picked = {
        watched_show: findByKeyLocal(root, 'watched_show'),
        popularity: findByKeyLocal(root, 'popularity'),
        room_info: findByKeyLocal(root, 'room_info'),
        anchor_info: findByKeyLocal(root, 'anchor_info'),
        room_view_stats: findByKeyLocal(root, 'room_view_stats')
      };
      const found = Object.entries(picked).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (!found.length) continue;

      /*
       * 关键防错：SSR 里的 room_id 和这份数据是一体的。
       * B站站内跳转是 SPA，URL 变了但 SSR 全局还是**上一页**的数据；
       * 照着当前 URL 去挂，就会凭空造出房间。实测踩到过：同一场 ig-vs-tes 被记成
       * bili:6 / bili:26808337 / bili:31934797 三个房间，数据一模一样 ——
       * 房间列表就是这样被塞满的。
       */
      const ssrRoomId = String(picked.room_info?.room_id ?? '');
      if (urlRoomId && ssrRoomId && urlRoomId !== ssrRoomId) {
        post('ssr-stale', { globalName: name, urlRoomId, ssrRoomId });
        continue;
      }

      post('ssr-state', { globalName: name, found, data: picked });
    }
  }

  try {
    setTimeout(scanPageGlobals, 3000);
    setTimeout(scanPageGlobals, 10000); // SSR 脚本可能晚一步执行
    setInterval(scanPageGlobals, 5000); // SPA 跳转后重新判定
  } catch (_) {
    /* 忽略 */
  }

  post('hook-ready', { url: location.href });
})();
