/*
 * 抖音 WS 下行帧解码单测（纯 Node，不需要浏览器）：
 *     node extension/test/ws-decode.test.mjs
 *
 * 复现真实抓到的结构：PushFrame 外壳 → field 8 payload(gzip) → Response → Message → RoomUserSeqMessage
 * 抓到的真实首帧字节：
 *   08 01 10 dd e9 ee a2 a9 f5 9e 8d 13 18 b8 45 20 08 2a 15 0a 0d "compress=gzip"
 * 这条测试保证：以后抖音再变结构时，先跑它就知道是解析写错了还是协议变了。
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'src', 'inject-hook.js'), 'utf8');

// ---------------------------------------------------------------- protobuf 构造
const enc = new TextEncoder();
const cat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const varint = (n) => {
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Uint8Array.from(out);
};
const tag = (field, wire) => varint(field * 8 + wire);
const vField = (field, value) => cat(tag(field, 0), varint(value));
const sField = (field, text) => {
  const bytes = enc.encode(text);
  return cat(tag(field, 2), varint(bytes.length), bytes);
};
const bField = (field, bytes) => cat(tag(field, 2), varint(bytes.length), bytes);

// ---------------------------------------------------------------- Node 垫片
const posted = [];
const win = {
  addEventListener: () => {},
  postMessage: (m) => posted.push(m),
  WebSocket: function () {},
  fetch: () => Promise.reject(new Error('no fetch in test')),
  XMLHttpRequest: function () {}
};
win.WebSocket.prototype = {};
const locationShim = {
  href: 'https://live.douyin.com/594976188049',
  pathname: '/594976188049',
  hostname: 'live.douyin.com' // inject-hook.js 现在会按域名判断是否生效
};
const documentShim = { addEventListener: () => {}, querySelectorAll: () => [] };
const xhrShim = win.XMLHttpRequest;
xhrShim.prototype = { open: () => {} };

new Function('window', 'location', 'document', 'XMLHttpRequest', code)(
  win,
  locationShim,
  documentShim,
  xhrShim
);

const api = win.__dyLiveCollector;
if (!api) {
  console.error('[x] hook 没有导出 __dyLiveCollector，无法单测');
  process.exit(1);
}

// ---------------------------------------------------------------- 用例
let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`}`);
};

// 1) 构造一条 RoomUserSeqMessage
const seqPayload = cat(
  vField(3, 12800), // total   = 当前在线人数
  vField(7, 100000), // totalUser = 累计观看
  sField(8, '10万'),
  sField(4, '1.3万')
);
const seqDecoded = api.decodeRoomUserSeq(seqPayload);
check('RoomUserSeqMessage.total', seqDecoded.total, 12800);
check('RoomUserSeqMessage.totalUser', seqDecoded.totalUser, 100000);
check('RoomUserSeqMessage.totalUserStr', seqDecoded.totalUserStr, '10万');
check('RoomUserSeqMessage.popStr', seqDecoded.popStr, '1.3万');

// 2) Message + Response 信封
const message = cat(sField(1, 'WebcastRoomUserSeqMessage'), bField(2, seqPayload), vField(4, 3));
const response = bField(1, message);
const env = api.decodeEnvelope(response);
check('Response 解出消息条数', env.length, 1);
check('Response 解出 method', env[0].method, 'WebcastRoomUserSeqMessage');
check('Response 解出 payload 长度', env[0].payload.length, seqPayload.length);

// 3) PushFrame 外壳 + gzip payload（真实结构）
const headers = cat(sField(1, 'compress'), sField(2, 'gzip'));
const pushFrame = cat(
  vField(1, 1),
  bField(5, headers),
  sField(6, 'gzip'),
  bField(8, gzipSync(Buffer.from(response)))
);
const frame = api.decodePushFrame(pushFrame);
check('PushFrame.payload_encoding', frame.encoding, 'gzip');
check('PushFrame 取到 payload', frame.payload !== null, true);
check('PushFrame payload 是 gzip 魔数', [frame.payload[0], frame.payload[1]], [0x1f, 0x8b]);

// 4) 解 gzip 后仍能还原出同一条消息
const plain = new Uint8Array(
  await new Response(
    new Blob([frame.payload]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).arrayBuffer()
);
const fromGzip = api.decodeEnvelope(plain);
check('gzip 解开后 method', fromGzip[0].method, 'WebcastRoomUserSeqMessage');
check('gzip 解开后 online', api.decodeRoomUserSeq(fromGzip[0].payload).total, 12800);

// 5) 反例：把 Response 当 PushFrame 解，应当取不到 payload（说明第一版为什么全解不出来）
check('Response 直接当 PushFrame 解：无 payload', api.decodePushFrame(response).payload, null);

// 6) LikeMessage：count=本次点赞, total=本场累计点赞（页面右上角那个数）
const likePayload = cat(
  sField(1, 'ignored-common'),
  vField(2, 15), // count 本次
  vField(3, 729000) // total 本场累计
);
const like = api.decodeLikeMessage(likePayload);
check('LikeMessage.total（本场累计点赞）', like.total, 729000);
check('LikeMessage.count（本次点赞）', like.count, 15);
check('LikeMessage 不会把 RoomUserSeq 的 totalUser(field 7) 当成点赞', api.decodeLikeMessage(seqPayload).count, null);

console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 条失败。`);
process.exit(failed === 0 ? 0 : 1);
