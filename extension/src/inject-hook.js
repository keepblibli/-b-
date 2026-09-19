/*
 * MAIN world hook —— 运行在页面自身的 JS 环境里，因此可以改写 fetch / XHR / WebSocket。
 *
 * 三条数据来源：
 *   1. WebSocket  /webcast/im/push/  →  protobuf 里的 RoomUserSeqMessage.total = 当前在线人数
 *   2. fetch/XHR  /webcast/room/web/enter/  →  房间 JSON，stats 里有累计观看 / 点赞等
 *   3. （交由 bridge.js 做 DOM 兜底）
 *
 * 采集到的数据统一用 window.postMessage 抛给 ISOLATED world 的 bridge.js。
 * 这里刻意不引入 protobuf 库：只解析我们需要的几个字段，手写 varint 解析 ≈ 60 行。
 */
(() => {
  'use strict';

  // 只在抖音域生效：manifest 现在同时匹配 B 站，那边的采集由 platform-bilibili.js 负责
  if (!/(^|\.)douyin\.com$/i.test(location.hostname)) return;

  const CHANNEL = 'dy-live-collector';
  if (window.__dyLiveCollectorInstalled) return;
  window.__dyLiveCollectorInstalled = true;

  const post = (kind, data) => {
    try {
      window.postMessage({ __ch: CHANNEL, kind, ts: Date.now(), href: location.href, data }, '*');
    } catch (_) {
      /* 页面被销毁时忽略 */
    }
  };

  // ---------------------------------------------------------------- protobuf
  // 只实现 wire type 0/1/2/5，足够解析抖音直播的下行消息。
  function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((b & 0x80) === 0) return [result, pos];
      if (shift > 63) return null;
    }
    return null;
  }

  function* iterFields(buf) {
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      if (!tag) return;
      const field = Math.floor(tag[0] / 8);
      const wire = tag[0] & 7;
      pos = tag[1];

      if (wire === 0) {
        const v = readVarint(buf, pos);
        if (!v) return;
        yield [field, wire, v[0]];
        pos = v[1];
      } else if (wire === 1) {
        yield [field, wire, buf.subarray(pos, pos + 8)];
        pos += 8;
      } else if (wire === 2) {
        const len = readVarint(buf, pos);
        if (!len) return;
        const start = len[1];
        const end = start + len[0];
        if (end > buf.length) return;
        yield [field, wire, buf.subarray(start, end)];
        pos = end;
      } else if (wire === 5) {
        yield [field, wire, buf.subarray(pos, pos + 4)];
        pos += 4;
      } else {
        return; // 不认识的 wire type，放弃这一帧
      }
    }
  }

  const utf8 = (bytes) => {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (_) {
      return '';
    }
  };

  /** Response { repeated Message messages = 1 } → [{method, msgType, payload}] */
  function decodeEnvelope(buf) {
    const out = [];
    for (const [field, wire, value] of iterFields(buf)) {
      if (field !== 1 || wire !== 2) continue;
      let method = '';
      let msgType = 0;
      let payload = null;
      for (const [f, w, v] of iterFields(value)) {
        if (f === 1 && w === 2) method = utf8(v);
        else if (f === 2 && w === 2) payload = v;
        else if (f === 4 && w === 0) msgType = v;
      }
      if (payload && payload.length) out.push({ method, msgType, payload });
    }
    return out;
  }

  /** RoomUserSeqMessage：total=当前在线人数, totalUser=累计观看, totalStr/totalUserStr=展示文案 */
  function decodeRoomUserSeq(buf) {
    const r = { total: null, totalUser: null, totalUserStr: '', totalStr: '', popStr: '' };
    for (const [field, wire, value] of iterFields(buf)) {
      if (field === 3 && wire === 0) r.total = value;
      else if (field === 7 && wire === 0) r.totalUser = value;
      else if (field === 8 && wire === 2) r.totalUserStr = utf8(value);
      else if (field === 9 && wire === 2) r.totalStr = utf8(value);
      else if (field === 4 && wire === 2) r.popStr = utf8(value);
    }
    return r;
  }

  /**
   * LikeMessage：count=本次点赞数, total=本场累计点赞数。
   * 这才是页面右上角“x.x万本场点赞”的真身——enter 接口里的 stats.like_count
   * 是进房瞬间的快照，实测恒为 0，所以点赞只认这里。
   */
  function decodeLikeMessage(buf) {
    const r = { count: null, total: null };
    for (const [field, wire, value] of iterFields(buf)) {
      if (field === 3 && wire === 0) r.total = value;
      else if (field === 2 && wire === 0) r.count = value;
    }
    return r;
  }

  // ------------------------------------------------------------- WebSocket
  const NativeWS = window.WebSocket;
  const methodSeen = new Map(); // method -> count（用于诊断)
  let methodReportAt = 0;
  const wsStats = {
    frames: 0,
    pushFrames: 0,
    gunzipOk: 0,
    gunzipFail: 0,
    envelopeMsgs: 0,
    decodeFail: 0,
    firstFrameHex: '',
    frameSample: '',
    lastError: ''
  };

  const hex = (u8, n = 24) =>
    Array.from(u8.slice(0, n))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');

  function reportMethods(force) {
    const now = Date.now();
    if (!force && now - methodReportAt < 5000) return;
    if (wsStats.frames === 0 && methodSeen.size === 0) return;
    methodReportAt = now;
    post('ws-methods', {
      methods: [...methodSeen.entries()].map(([m, n]) => `${m || '(空方法名)'}×${n}`),
      stats: { ...wsStats }
    });
    methodSeen.clear();
  }

  /*
   * 抖音的下行帧是两层：
   *   PushFrame { seqid=1, logid=2, service=3, method=4, headers=5,
   *               payload_encoding=6, payload_type=7, payload=8(bytes) }
   *   payload（field 8）通常是 gzip，解开后才是 Response { repeated Message messages = 1 }
   * 抓到的头几字节长这样，可以据此确认：
   *   08 01 10 dd e9 ee a2 a9 f5 9e 8d 13 18 b8 45 20 08 2a 15 0a 0d "com..."
   *   即 f1=1(seqid) f2=logid f3=service f4=method f5=HeadersList(compress=gzip)
   * 所以必须先从 field 8 取 payload 并 inflate，直接按 Response 解会一条都解析不出来。
   */
  function decodePushFrame(u8) {
    let payload = null;
    let encoding = '';
    for (const [field, wire, value] of iterFields(u8)) {
      if (field === 8 && wire === 2) payload = value;
      else if (field === 6 && wire === 2) encoding = utf8(value);
    }
    return { payload, encoding };
  }

  async function inflateIfNeeded(bytes, encoding) {
    const looksGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    const claimsGzip = /gzip/i.test(encoding || '');
    if ((!looksGzip && !claimsGzip) || typeof DecompressionStream !== 'function') return bytes;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const plain = new Uint8Array(await new Response(stream).arrayBuffer());
      wsStats.gunzipOk += 1;
      return plain;
    } catch (e) {
      // 号称 gzip 但实际不是（或半包），退回原始字节，交给上层再试
      wsStats.gunzipFail += 1;
      wsStats.lastError = 'gunzip: ' + String(e && e.message ? e.message : e);
      return bytes;
    }
  }

  /** 解析 Response 信封，返回解出的消息条数。 */
  async function parseResponse(u8) {
    let messages;
    try {
      messages = decodeEnvelope(u8);
    } catch (e) {
      wsStats.decodeFail += 1;
      wsStats.lastError = 'decode: ' + String(e && e.message ? e.message : e);
      return 0;
    }
    wsStats.envelopeMsgs += messages.length;

    for (const msg of messages) {
      const label = msg.method || '';
      methodSeen.set(label, (methodSeen.get(label) || 0) + 1);

      if (/RoomUserSeq/i.test(label)) {
        // 少数版本连单条消息的 payload 也单独压缩
        const payload = await inflateIfNeeded(msg.payload, '');
        const seq = decodeRoomUserSeq(payload);
        if (seq.total != null || seq.totalUser != null) {
          post('ws-seq', {
            method: label,
            online: seq.total,            // 当前在线人数
            watched: seq.totalUser,       // 累计观看人数
            onlineText: seq.popStr || (seq.total != null ? String(seq.total) : ''),
            watchedText: seq.totalUserStr || seq.totalStr || ''
          });
        }
      } else if (/LikeMessage/i.test(label)) {
        const payload = await inflateIfNeeded(msg.payload, '');
        const like = decodeLikeMessage(payload);
        if (like.total != null) {
          post('ws-like', { method: label, total: like.total, delta: like.count });
        }
      }
    }
    return messages.length;
  }

  async function handleFrame(buffer) {
    const bytes = new Uint8Array(buffer);
    wsStats.frames += 1;
    if (!wsStats.firstFrameHex) wsStats.firstFrameHex = hex(bytes);
    try {
      const frame = decodePushFrame(bytes);
      if (!wsStats.frameSample) {
        wsStats.frameSample = `pushPayload=${frame.payload ? frame.payload.length : 0} enc=${frame.encoding || '-'}`;
      }
      let parsed = 0;
      if (frame.payload && frame.payload.length) {
        wsStats.pushFrames += 1;
        const body = await inflateIfNeeded(frame.payload, frame.encoding);
        parsed = await parseResponse(body);
      }
      // 兜底：有些实现直接推未封装的 Response
      if (parsed === 0) parsed = await parseResponse(bytes);
      if (parsed === 0 && !wsStats.lastError) wsStats.lastError = '帧解析不出消息';
    } catch (e) {
      wsStats.decodeFail += 1;
      wsStats.lastError = 'frame: ' + String(e && e.message ? e.message : e);
    }
    reportMethods();
  }

  function hookedWebSocket(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    if (typeof url === 'string' && /\/webcast\/im\/push\//.test(url)) {
      post('ws-open', { url: url.slice(0, 200) });
      ws.addEventListener('message', (ev) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          handleFrame(data).catch(() => {});
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          data
            .arrayBuffer()
            .then((buf) => handleFrame(buf))
            .catch(() => {});
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
    post('error', { where: 'websocket', message: String(e) });
  }

  // ------------------------------------------------------------ 接口响应
  const ENTER_API = /\/webcast\/room\/web\/enter\//;

  /** 把 enter 接口的响应压成我们关心的形状，避免把上百 KB 的全量 JSON 传给后台。 */
  function extractRoom(json) {
    const root = json && json.data ? json.data : json;
    if (!root) return null;
    const list = Array.isArray(root.data) ? root.data : null;
    const room = (list && list[0]) || root.room || null;
    if (!room || typeof room !== 'object') return null;
    const owner = room.owner || {};
    return {
      roomId: String(room.id_str || room.id || ''),
      webRid: String(owner.web_rid || room.web_rid || ''),
      nickname: owner.nickname || '',
      title: room.title || '',
      status: typeof room.status === 'number' ? room.status : null,
      // 两份统计对象的字段名不一样，都带上，由服务端/后台决定信哪个
      stats: room.stats || null,
      viewStats: room.room_view_stats || null,
      roomKeys: Object.keys(room).slice(0, 80)
    };
  }

  function emitEnter(url, json) {
    try {
      const room = extractRoom(json);
      if (room) post('enter-api', { url: String(url).slice(0, 200), room });
    } catch (_) {
      /* 忽略结构变化 */
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (ENTER_API.test(url)) {
          promise
            .then((res) => {
              res.clone().json().then((j) => emitEnter(url, j)).catch(() => {});
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
      if (ENTER_API.test(target)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === 'json') {
              emitEnter(target, this.response);
            } else if (this.responseType === '' || this.responseType === 'text') {
              const text = this.responseText;
              if (text && text.length < 3_000_000) emitEnter(target, JSON.parse(text));
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

  /* 方便在浏览器控制台或 Node 单测里单独验证解析逻辑，不影响采集 */
  window.__dyLiveCollector = { iterFields, decodeEnvelope, decodePushFrame, decodeRoomUserSeq, decodeLikeMessage };

  post('hook-ready', { url: location.href });
})();
