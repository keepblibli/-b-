/*
 * B 站弹幕 WS 解码单测（纯 Node，不需要浏览器）：
 *     node extension/test/bili-decode.test.mjs
 *
 * 覆盖：16 字节头拆包、大端/小端自动探测、心跳回复读人气值、
 *      protover=2 (zlib) 解压后递归拆包、JSON cmd 派发。
 * 有了它，改协议解析不用每次都去开浏览器验。
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'src', 'platform-bilibili.js'), 'utf8');

const enc = new TextEncoder();
const posted = [];

// 假的 WebSocket：让脚本的 hook 能挂上 message 监听，我们再手动投喂帧
class FakeWS {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    FakeWS.last = this;
  }
  addEventListener(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  }
  emit(type, ev) {
    (this.handlers[type] || []).forEach((fn) => fn(ev));
  }
}

const win = {
  addEventListener: () => {},
  postMessage: (m) => posted.push(m),
  WebSocket: FakeWS,
  fetch: () => Promise.reject(new Error('no fetch in test')),
  XMLHttpRequest: function () {}
};
const locationShim = { href: 'https://live.bilibili.com/33989', pathname: '/33989', hostname: 'live.bilibili.com' };
const documentShim = { addEventListener: () => {}, querySelectorAll: () => [] };
const xhrShim = win.XMLHttpRequest;
xhrShim.prototype = { open: () => {} };

new Function('window', 'location', 'document', 'XMLHttpRequest', code)(win, locationShim, documentShim, xhrShim);

const collector = win.__biliCollector;
if (!collector) {
  console.error('[x] 脚本没生效（hostname 判断？），无法单测');
  process.exit(1);
}

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`}`);
};

/** 拼一个标准 16 字节头 + 包体 */
function makePacket(op, protover, body, { little = false, headerLen = 16 } = {}) {
  const total = headerLen + body.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, total, little);
  dv.setUint16(4, headerLen, little);
  dv.setUint16(6, protover, little);
  dv.setUint32(8, op, little);
  dv.setUint32(12, 1, little);
  buf.set(body, headerLen);
  return buf;
}

// ------------------------------------------------------------------ 拆包
const one = collector.splitPackets(makePacket(5, 0, enc.encode('{}')));
check('拆出 1 个包', one.length, 1);
check('op=5', one[0].op, 5);
check('protover=0', one[0].protover, 0);
check('headerLen=16', one[0].headerLen, 16);
check('body 原样带出', new TextDecoder().decode(one[0].body), '{}');

const three = collector.splitPackets(
  new Uint8Array([
    ...makePacket(3, 1, new Uint8Array([0x00, 0x00, 0x30, 0x39])),
    ...makePacket(5, 0, enc.encode('{"cmd":"A"}')),
    ...makePacket(5, 0, enc.encode('{"cmd":"B"}'))
  ])
);
check('首尾相接的三包全拆出', three.length, 3);
check('第三包 op', three[2].op, 5);

// ------------------------------------------------------------------ 字节序探测
collector.stats.headerEndian = null;
const leFrames = collector.splitPackets(makePacket(5, 0, enc.encode('{}'), { little: true }));
check('小端帧也能拆出（自动探测）', leFrames.length, 1);
check('探测结果记录为 le', collector.stats.headerEndian, 'le');

collector.stats.headerEndian = null;
collector.splitPackets(makePacket(5, 0, enc.encode('{}')));
check('大端帧探测结果记录为 be', collector.stats.headerEndian, 'be');

// ------------------------------------------------------------------ 心跳回复 → 人气值
const ws = new win.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
check('hook 认出了 /sub 连接', collector.stats.frames, 0); // 还没投喂帧
ws.emit('message', { data: makePacket(3, 1, new Uint8Array([0x00, 0x02, 0x5f, 0x1a])).buffer });
await new Promise((r) => setTimeout(r, 30));
const pop = posted.find((m) => m.kind === 'ws-popularity');
check('心跳回复上报了人气值', pop?.data?.popularity, 155418); // 0x00025f1a = 155418（大端）
// 0x1a5f0200 = 442434048：读反时大了近 3000 倍，这正是 background.js 里
// “取较小的那个正数”这条启发式成立的实测依据
check('同时带上两种读法供对照', [pop?.data?.be, pop?.data?.le], [155418, 442434048]);
check('心跳回复计数', collector.stats.heartbeatReplies, 1);

// ------------------------------------------------------------------ zlib 包 → JSON cmd
// 注意：压缩的是**完整包**（带 16 字节头），不是裸 JSON —— B 站的行为就是
// “把多个完整包首尾相接后再压缩”，所以解压后必须再拆一次包。
const watchedJson = JSON.stringify([{ cmd: 'WATCHED_CHANGE', data: { num: 123456, text_large: '12.3万人看过' } }]);
const innerPacket = makePacket(5, 0, enc.encode(watchedJson));
const zlibBody = deflateSync(Buffer.from(innerPacket));
ws.emit('message', { data: makePacket(5, 2, new Uint8Array(zlibBody)).buffer });
await new Promise((r) => setTimeout(r, 50));
const watched = posted.find((m) => m.kind === 'ws-watched');
check('zlib 包被解开并派发', watched?.data?.num, 123456);
check('zlib 解压成功计数', collector.stats.zlibOk >= 1, true);
check('cmd 计数里有 WATCHED_CHANGE', collector.stats.cmdCounts.WATCHED_CHANGE >= 1, true);
check('留下了 cmd 的 JSON 样本（便于抄字段名）', typeof collector.stats.cmdSamples.WATCHED_CHANGE, 'string');

// 反例：直接把裸 JSON 压缩（不带内层包头）应当解不出发送 —— 说明内层必须再拆包
const rawZlib = deflateSync(Buffer.from(watchedJson));
const postedBefore = posted.length;
ws.emit('message', { data: makePacket(5, 2, new Uint8Array(rawZlib)).buffer });
await new Promise((r) => setTimeout(r, 50));
check('裸 JSON 压缩包不会派发消息（内层必须带包头）', posted.length, postedBefore);

// ------------------------------------------------------------------ 明文 JSON（protover 0）
ws.emit('message', { data: makePacket(5, 0, enc.encode(JSON.stringify({ cmd: 'ONLINE_RANK_COUNT', data: { count: 7582 } }))).buffer });
await new Promise((r) => setTimeout(r, 30));
const rank = posted.find((m) => m.kind === 'ws-online-rank');
check('protover=0 的 JSON 直接派发', rank?.data?.count, 7582);

// ------------------------------------------------------------------ 半包/垃圾数据不能崩
const before = collector.stats.frames;
ws.emit('message', { data: new Uint8Array([1, 2, 3]).buffer });
await new Promise((r) => setTimeout(r, 20));
check('短帧不抛异常，仍计数', collector.stats.frames, before + 1);

console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 条失败。`);
process.exit(failed === 0 ? 0 : 1);
