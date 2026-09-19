# 移植到 B 站直播（设计 + 实测报告）

> **状态：已实现并实测通过。** 扩展现在同时支持抖音和 B 站（按域名自动识别，无需切换模式），
> 服务端通过房间 key 的 `dy:` / `bili:` 前缀区分平台。本文档既是当初的设计方案，
> 也是落地后的实测报告——§六 的"待确认项"已经全部换成真实数据和结论。
>
> 标注约定：
> - ✅ **已实测确认**
> - ❌ **实测否定的假设**（这类最有价值，避免照着错的前提写代码）
> - ⚠️ **已知限制**
>
> 抖音那一轮的教训：两次凭推理下结论都被实测推翻（"网页版没有在线人数"、"WS 帧是 gzip"）。
> 所以这一轮**先实测再写代码**，结果又抓出两个错误假设（见 §六：心跳人气值是占位值、
> 新版房间页不走 XHR）。

---

## 一、先说结论

### 能复用的部分比想象中多

`server/` 这一层**和平台完全无关**——`samples` 表存的就是
`(room_id, metric, value, source)`，谁采的都一样。所以：

| 文件 | 是否要改 |
|---|---|
| `server/app.py` | **不用改**（只在 `METRIC_LABELS` 加几个键） |
| `server/selftest.py` | 不用改 |
| `server/static/dashboard.html` | 只改指标标签文字 |
| `start_server.cmd` / `start_server.ps1` | 完全不动 |
| `extension/manifest.json` | 1 行（`matches`） |
| `extension/src/inject-hook.js` | **主要工作量，解码器整个换掉** |
| `extension/src/background.js` | 小改（指标映射 + 新增 `ws-popularity`） |
| `extension/src/bridge.js` | 小改（DOM 正则） |

### 但有一个必须先接受的现实

**B 站对普通观众不提供"真实并发在线人数"。** 页面上那几个数是：

| 页面上的数 | 真实含义 | 和抖音的对应关系 |
|---|---|---|
| **人气** | 热度加权值，不是人数 | ❌ 没有对应物（抖音的 `online` 是真人数） |
| **看过** | 累计观看人次 | ≈ 抖音的 `watched` |
| **高能榜在线数** | 参与高能榜的在线用户数（**最接近真人数，但会漏掉潜水观众**） | 近似 `online`，但有系统性低估 |

如果你要的就是抖音那种"当前多少人在看"，B 站没有权威值，只能用代理指标（proxy），
而且代理指标和人数不是线性关系。**详细分析、代理指标排序和验证方法见 §九**——
建议先看完那一节再决定要不要做，以及指标在面板上该叫什么名字。

---

## 二、B 站与抖音的协议差异（核心）

| | 抖音 | B 站 |
|---|---|---|
| WS 帧格式 | `PushFrame` protobuf → gzip → `Response` protobuf | **自定义 16 字节头** + 包体 |
| 包体编码 | 全是 protobuf | 明文 JSON / int32 / zlib / brotli 四种 |
| 需要 protobuf 解码器 | 需要（我手写了 varint） | **不需要**，逻辑反而简单 |
| 房间号 | URL 是 `web_rid`，真 `room_id` 只在接口里 | ✅ **URL path 就是真 room_id** |

房间号这一点是 B 站更省事：抖音那边我踩过"同一个房间被拆成两行数据"（WS 用 web_rid、
enter 接口用 room_id）。B 站直接用 URL 里的数字当 key 即可，不存在双 ID 问题。

---

## 三、B 站弹幕 WS 协议（✅ 帧格式部分有把握）

### 3.1 连接

页面会自己连：`wss://<host>/sub`，`<host>` 从
`GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=<room_id>&type=0`
的 `data.host_list[]` 里取，`data.token` 是认证用的 key。

> 这个接口现在带 WBI 签名（`w_rid`/`wts`）。**我们不需要管签名**——沿用抖音版的原则：
> 只被动读页面已经发出的请求和收到的帧，不自己构造请求。

### 3.2 帧结构

```
偏移  长度  类型     含义
0     4    uint32   封包总长度（含 16 字节头）
4     2    uint16   头部长度（通常 16）
6     2    uint16   协议版本 protover
8     4    uint32   操作码 op
12    4    uint32   序号 sequence（通常 1）
16    ...  bytes    包体
```

⚠️ **字节序必须实测确认**：公开实现里普遍用**大端**（`struct.unpack('>I', ...)`），
但也有小端写法流传。验证方法见 §六 第一条。

### 3.3 操作码 op（✅ 有把握）

| op | 方向 | 含义 |
|---|---|---|
| 2 | 客户端 → 服务端 | 心跳（约每 30 秒一次） |
| 3 | 服务端 → 客户端 | **心跳回复，包体 = 4 字节人气值** |
| 5 | 服务端 → 客户端 | 普通通知，也就是弹幕/礼物/各种 event |
| 7 | 客户端 → 服务端 | 认证 |
| 8 | 服务端 → 客户端 | 认证回复 |

**关键点：人气值不需要任何解压。** op=3 的包体永远是 4 字节裸 int32，
所以哪怕 brotli 解不开，人气值这条通道也是通的。

### 3.4 协议版本 protover（✅ 有把握）

| protover | 包体含义 | 浏览器原生能否解 |
|---|---|---|
| 0 | 明文 JSON | ✅ 直接 `JSON.parse` |
| 1 | int32 人气值（仅心跳回复） | ✅ `DataView` 读 4 字节 |
| 2 | zlib 压缩，且是**多个完整包首尾相接** | ✅ `DecompressionStream('deflate')` |
| 3 | brotli 压缩，同样多包相接 | ⚠️ 见下 |

两个坑：

1. **`DecompressionStream` 的参数别写错**：B 站用的是 zlib 格式（RFC1950，带 2 字节头），
   对应 `'deflate'`；`'deflate-raw'` 是裸 deflate（RFC1951），**用了会报错**。
2. **brotli 可能没有原生支持**。`Compression Streams` 规范只保证
   `gzip / deflate / deflate-raw`。在页面控制台跑一行确认：

   ```js
   try { new DecompressionStream('brotli'); console.log('支持'); }
   catch (e) { console.log('不支持，需要引 JS 解码器'); }
   ```

   不支持时两条路：
   - 引一个纯 JS brotli 解码器（几十 KB，塞进 MAIN world 脚本）
   - **降级**：只做「人气值（op3）+ 看过（走接口）」，放弃需要解压的那些 event

3. **压缩包里是多条完整帧**，解压后要**递归地再按 16 字节头切包解析**，不能当成一个包。

### 3.5 可能关心的 cmd（⚠️ 全部需实测）

| cmd | 大致内容 | 对应我们的指标 |
|---|---|---|
| `WATCHED_CHANGE` | `data.num` / `data.text_large`（"x.x万人看过"） | `watched` |
| `ONLINE_RANK_COUNT` | 高能榜在线人数 `data.count` | `online_rank` |
| `ROOM_REAL_TIME_MESSAGE_UPDATE` | 粉丝数等 | `fans` |
| `DANMU_MSG` / `SEND_GIFT` | 弹幕 / 礼物 | （可选，做弹幕密度） |
| `LIVE` / `PREPARING` | 开播 / 下播 | 事件检测 |

---

## 四、改造清单（逐文件）

### 4.1 `manifest.json`

```diff
-      "matches": ["https://live.douyin.com/*", "https://www.douyin.com/*"],
+      "matches": ["https://live.bilibili.com/*"],
```

`world: "MAIN"` / `"ISOLATED"` 两个 content script、权限、上报 host 全部不动。

### 4.2 `inject-hook.js`（重写解码层，其余骨架照抄）

保留不动的部分：
- `post()` 消息通道
- fetch / XHR hook 的写法（只换 URL 正则）
- `handleFrame` 的"两层 + 兜底 + 统计"结构（这套调试思路直接复用）
- `wsStats` 那套自检计数（换成 B 站的字段即可）

要删掉的：`iterFields` / `readVarint` / `decodeEnvelope` / `decodePushFrame` /
`decodeRoomUserSeq` / `decodeLikeMessage`（全是抖音专用）

要新增的解码器骨架：

```js
const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 };

/** 把一个完整包切成 [header, body] 列表（压缩包解压后可能含多条） */
function splitPackets(buf) {
  const out = [];
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset + offset);
    // ⚠️ 字节序待实测：先按大端，确认错了再改成 true
    const total = dv.getUint32(0, false);
    const headerLen = dv.getUint16(4, false);
    const protover = dv.getUint16(6, false);
    const op = dv.getUint32(8, false);
    if (total < 16 || offset + total > buf.length) break;   // 半包，丢弃等下次
    out.push({ op, protover, body: buf.subarray(offset + headerLen, offset + total) });
    offset += total;
  }
  return out;
}

async function handleFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  wsStats.frames += 1;
  for (const pkt of splitPackets(bytes)) {
    if (pkt.op === OP.HEARTBEAT_REPLY) {
      // 人气值：4 字节 int32，无压缩
      const dv = new DataView(pkt.body.buffer, pkt.body.byteOffset, pkt.body.byteLength);
      const popularity = dv.getInt32(0, false);
      wsStats.heartbeatReplies += 1;
      post('ws-popularity', { popularity, raw: [...pkt.body] });
      continue;
    }
    if (pkt.protover === 2) {
      const plain = await inflate(pkt.body, 'deflate');       // zlib
      for (const inner of splitPackets(plain)) dispatch(inner);
    } else if (pkt.protover === 3) {
      // 见 §3.4：brotli 可能不支持，失败就只记统计不报错
      try {
        const plain = await inflate(pkt.body, 'brotli');
        for (const inner of splitPackets(plain)) dispatch(inner);
      } catch (e) {
        wsStats.brotliFail += 1;
      }
    } else {
      dispatch(pkt);   // protover 0/1
    }
  }
  reportMethods();
}

function dispatch(pkt) {
  if (pkt.op !== OP.MESSAGE) return;
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(pkt.body));
  } catch { return; }
  // 注意：一个包里可能是单个对象，也可能是数组
  for (const msg of Array.isArray(json) ? json : [json]) {
    methodSeen.set(msg.cmd, (methodSeen.get(msg.cmd) || 0) + 1);
    if (msg.cmd === 'WATCHED_CHANGE') {
      post('ws-watched', { num: msg.data?.num, text: msg.data?.text_large });
    } else if (msg.cmd === 'ONLINE_RANK_COUNT') {
      post('ws-online-rank', { count: msg.data?.count });
    }
  }
}
```

WS 连接的匹配正则从 `/\/webcast\/im\/push\//` 换成 `/\/sub(\?|$)/`。

### 4.3 `background.js`

- `roomIdFromHref`：先试 `live.bilibili.com/(\d+)`，逻辑比抖音简单（没有 web_rid/room_id 之分）
- 新增 `case 'ws-popularity'` / `'ws-watched'` / `'ws-online-rank'`
- 指标名建议：`popularity`（人气）、`watched`（看过）、`online_rank`（高能榜）
- `handleEnterApi` 的字段映射换成 `room_info.popularity` / `watched_show.num`（⚠️ 待实测）
- **点赞**：抖音的教训是 `like_count` 可能恒为 0。B 站先别急着接，实测确认它和页面一致再开

### 4.4 `bridge.js`

DOM 兜底正则换成 B 站的文案（⚠️ 文案需实测，下面是猜测）：

```js
const POPULARITY_RE = /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人气/;
const WATCHED_RE   = /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人看过/;
```

### 4.5 `app.py`

只加标签：

```python
METRIC_LABELS = {
    "popularity": "人气值",
    "watched": "看过(累计)",
    "online_rank": "高能榜在线数",
    "fans": "粉丝数",
}
```

`SOURCE_PRIORITY = ("ws", "dom", "api")` 保持不变——B 站同样是 WS 最准。

---

## 五、指标映射总表

| 我们的 metric | B 站来源（首选 → 兜底） | 说明 |
|---|---|---|
| `popularity` | WS op3 心跳 → `room_info.popularity` | ✅ 无需解压，最稳；**是热度值不是人数** |
| `watched` | `WATCHED_CHANGE` → `watched_show.num` | 累计观看 |
| `online_rank` | `ONLINE_RANK_COUNT` | 高能榜在线数，**≠ 并发观众数** |
| `fans` | `ROOM_REAL_TIME_MESSAGE_UPDATE` → `anchor_info` | 粉丝数 |
| ~~`online`~~ | **无对应** | B 站不公开真实并发在线人数 |

---

## 六、实测结论（已在真实直播间完成，2026-09-17）

实测对象：泛式直播间 `live.bilibili.com/33989`（在线直播中）。诊断数据全部来自扩展自带的探针
（`/api/diagnostics` 的 `bili` 字段），不是推断。

| 待确认项 | 实测结果 |
|---|---|
| **头部字节序** | ✅ **大端**。首帧 `00 00 00 1a \| 00 10 \| 00 01 \| 00 00 00 08 \| 00 00 00 01 \| {"code":0}` —— total=26、headerLen=16、protover=1、op=8(认证回复)、body=`{"code":0}`，完全对得上 |
| **op 分布**（189 帧） | `op=3`(心跳回复) ×2、`op=5`(通知) ×186、`op=8`(认证回复) ×1。没看到 op=2 是因为那是客户端发的 |
| **protover 分布** | `0`×2、`1`×3、**`3`(brotli)×184** —— 绝大多数是 brotli |
| **brotli 支持性** | ❌ **浏览器不支持**。`new DecompressionStream('brotli')` 抛 `Unsupported compression format: 'brotli'` → **184 个通知包全部解不开** |
| **心跳回复的"人气值"** | ❌ **是占位值，不可用**。body 恒为 `00 00 00 01`（大端 1 / 小端 16777216）。B 站早已废弃这个字段 |
| **`getInfoByRoom`** | ❌ **新版房间页根本不调用它**。宽口径抓了所有 `api.live.bilibili.com` 响应，递归搜 `popularity`/`watched_show`/`fans` 全为空 |
| **数据真实来源** | ✅ **SSR 内联在页面里**，全局变量 `window.__NEPTUNE_IS_MY_WAIFU__`，里面有 `watched_show` / `room_info` / `anchor_info` / `popularity` |
| **`live_status`** | ✅ `1` = 直播中（公开接口 `Room/get_info` 同时确认） |
| **点赞可信度** | ✅ DOM 文案与页面一致（26.1万 → 26.7万 递增），**不是**抖音那种恒 0 的坑 |
| **`room_info.online` 是什么** | ⚠️ **是热度人气值，不是人数**。实测 SSR 给 `267605`，公开接口 `Room/get_info` 给 `263356`（同量级），而房间观众只有 7239、看过 12.58万 |
| **URL 房间号** | ✅ 与 `room_info.room_id` 一致（`/33989`），没有短号歧义 |
| **广场卡片上的数字是什么** | ✅ **是"看过"（累计），不是人气**。两次独立吻合：卡片 `3.4万` ↔ 采集 `watched=34274`；卡片 `13.7万` ↔ `watched=137931` |
| **从广场点卡片进房间（SPA 跳转）** | ✅ 端到端复验通过：页面 `翁法罗斯3.7 - 胡桃Usa` ↔ 采集 `昵称=胡桃Usa`、`标题=翁法罗斯3.7`、`likes=99000`、`room_viewers=3328`、`watched=34274`，全部一致 |
| **上报延迟** | ✅ `lastSampleAgeMs` 稳定在 1 秒内 |

### 端到端复验记录（2026-09-19，扩展重载后）

| 检查项 | 结果 |
|---|---|
| DOM 通道（房间观众、点赞） | ✅ 与页面逐秒一致：页面 `房间观众(1220)` ↔ 采集 `room_viewers=1220`；点赞同步递增 |
| SSR 通道（昵称/标题/看过/粉丝） | ✅ 整页加载与站内跳转两条路径都正确归属 |
| 错位防错 `biliSsrStale` | 本次未触发——SSR 是新鲜的，防错作为兜底待命 |
| 新版 SW 是否生效 | ✅ 诊断里出现 `queueLength` 字段（只有新版 `pushDiag` 会带） |

> **修掉的历史 bug**：站内跳转后 SSR 全局可能还是上一页的数据，照着当前 URL 去挂会**凭空造房间**
> （实测：同一场 ig-vs-tes 被记成 `bili:6` / `bili:26808337` / `bili:31934797` 三个房间，
> 数据一模一样，房间列表就是这样被塞满的）。现已加防错：SSR 的 `room_id` 与 URL 不一致就丢弃，
> 只记 `biliSsrStale`。
>
> **另一处修复**：MV3 的 SW 只在有事件时醒，服务长时间不可用时积压的采样会永远发不出去
> （实测踩到过：服务恢复后 44 小时一条都没补发）。现在加了每分钟一次的 `chrome.alarms` 定时补发，
> 并在诊断里汇报 `queueLength`。

### 由此确定的三个指标语义（重要）

| 页面上的数 | 实测值 | 语义 | 能不能当"在线人数" |
|---|---|---|---|
| **房间观众(x)** | 7239 | 房间内的观众数 | **最接近，推荐用它**（但有系统性低估） |
| **看过** | 12.58万 | 累计观看人次 | 不能（是累计） |
| **人气 / `online` 字段** | 26.8万 | 热度加权值 | **不能**，与人数非线性 |

### 当前实现状态

| 通道 | 状态 | 说明 |
|---|---|---|
| DOM | ✅ 可用 | `room_viewers`（房间观众）、`likes`（点赞） |
| SSR 全局 | ✅ 可用 | `watched`（看过）、`popularity`（人气）、`fans`（粉丝） |
| WS 心跳 | ⚠️ 弃用 | 人气值是占位值，已改成只记诊断不入库 |
| WS 通知 | ❌ 被 brotli 卡住 | 184/186 包解不开；`WATCHED_CHANGE`、`ONLINE_RANK_COUNT`、弹幕都在里面 |
| HTTP 接口 | ⚠️ 死路 | 新版页面不走 XHR 取房间信息 |

**唯一没解决的：brotli。** 影响的是"更实时的推送"和弹幕/高能榜，**不影响房间观众和看过**
（前者 DOM 每 4 秒扫一次，后者 SSR 进房时取一次）。若要解锁，需要往扩展里内置一个
纯 JS brotli 解码器（约几十 KB，属第三方代码，需锁版本），属可选增强。

> 踩坑记录：我第一版把心跳里那个 4 字节当人气值存进了库（值=1），诊断一跑就暴露了，
> 已清掉并改成只记诊断。这正是"先实测再写代码"的价值。

## 七、风险与合规

1. **别把"人气"当"在线人数"** 对外汇报。两者不是线性关系，跨房间比较更没有意义。
2. **brotli 依赖**：如果引入第三方 JS 解码器，注意它是**运行在直播间页面里的第三方代码**，
   建议只在必要时引入、并锁定版本。
3. **登录/风控**：B 站 WS 认证要 `uid + buvid + token`；延续"只读页面已发包"的原则，
   不做签名破解、不伪造请求头。
4. **别改成主动轮询**：抖音版特意没有主动请求接口（避开了 `a_bogus`/`msToken` 签名和风控）。
   B 站同理——主动轮询 `getInfoByRoom` 要处理 WBI 签名，且更容易被限流。
5. **保留策略/存储**：B 站人气值变动比抖音在线人数频繁得多，实测采样速率后可能要调
   `MIN_GAP_MS`（当前 5 秒）；`samples` 的每行成本约 80 字节，估算方式见 README 第六章。

---

## 八、工作量估计

| 阶段 | 内容 | 估计 |
|---|---|---|
| 实测 | §六 清单跑一遍 | 0.5~1 小时 |
| 解码器 | §4.2 那套（splitPackets + 三种 protover + dispatch） | 半天 |
| 适配 | manifest / background / bridge / 标签 | 1~2 小时 |
| 验证 | 复用 `selftest.py` + 单测思路（用假包测 splitPackets 和人气值读取） | 1 小时 |

**建议**：先把 §六 的实测做完再动手。抖音那轮不实测的代价是三次返工
（"网页版没有在线人数"结论错误、WS 帧结构判断错误、点赞来源错误）。

---

## 九、关于"B 站真实在线人数"

### 9.1 结论：观众侧拿不到权威值，这是产品决定，不是技术难题

B 站在 2017 年前后把页面上公开的**在线人数**换成了**人气值**，后来又主推**看过**。
动机很直白：避免主播之间直接攀比在线人数、也为了压制刷人气。所以对普通观众而言，
**不存在一个权威的并发在线数**——不管你用接口、WS 还是 DOM，拿到的都只是代理指标。

### 9.2 三个代理指标，按"接近真实人数"排序

| 代理指标 | 来源 | 接近程度 | 系统性偏差 |
|---|---|---|---|
| **高能榜在线数** | WS `ONLINE_RANK_COUNT.count`<br>接口 `getOnlineGoldRank` 的 `data.onlineNum` | **最接近**，第三方统计工具基本都用它 | **只统计进入高能榜的用户，漏掉纯潜水观众**；房间越小偏差越大 |
| `room_info.online` | `getInfoByRoom` → `data.room_info.online` | 个别房间给真实值 | 大量房间**恒为 1**（占位值），必须逐房间实测才知道能不能用 |
| 人气值 | WS `op=3` 心跳 / `room_info.popularity` | 只能反映热度 | 加权算法、各分区权重不同、**跨房间不可比**，与人数非线性 |

⚠️ `ONLINE_RANK_COUNT` 和 `getOnlineGoldRank` 的字段名需要实测确认（见 §六）。
另外 `getOnlineGoldRank` 是**打开高能榜面板时才请求**的，如果你不点那个面板，就只能靠 WS 推送；
若某房间没开高能榜，可能两者都拿不到。

### 9.3 怎么验证哪个代理能用（可执行步骤）

1. 打开目标直播间，手工记下当时页面上的「看过」和「人气」
2. 让 hook 抓 `ONLINE_RANK_COUNT`（WS 推送）和 `getOnlineGoldRank`（点开高能榜面板触发）
3. **连续采样 30 分钟**，把三组曲线和「弹幕条数/分钟」放一起看：
   哪个代理的变化趋势和弹幕活跃度相关性最高，哪个就更可信
4. 拿一个已知量级的大房间做校准（例如官方赛事直播间，观众数以万计）：
   如果代理值比常识低一个数量级，说明它只统计了互动用户
5. 把结论写进面板标签。**建议直接叫「高能榜在线数（代理）」**，不要对外叫「在线人数」——
   抖音那边 `online` 是真人数的语义，两个平台同名不同义，混淆的代价比改个标签大得多

### 9.4 如果一定要"真值"，只有两条路

- **主播端后台**：B 站给主播的直播中心里有准确实时在线人数（含潜水用户）。
  这是观众侧无论如何拿不到的，除非你自己就是主播、或有主播授权。
- **官方/商业数据服务**：需要授权或付费的开放平台接口、第三方数据平台（多为估算）。

弹幕频率、进房消息频率这类可以推算「活跃趋势」，但**不能当人数用**——
一个不说话的房间可能有一万人在看。

---

## 十、双平台共存（一个扩展同时跑抖音 + B 站）

**可以，而且不难。** 关键是把「平台差异」收敛成一层适配器，而不是写两套扩展。

### 10.1 目标文件结构

```
extension/
├─ manifest.json                     # matches 同时包含两个域名
└─ src/
   ├─ platform-douyin.js             # 抖音适配器（现有解码逻辑搬进来）
   ├─ platform-bilibili.js           # B 站适配器（§四 的解码器）
   ├─ inject-hook.js                 # 通用骨架：hook 时机、消息通道、自检统计
   ├─ bridge.js                      # 通用转发 + 各平台 DOM 正则
   └─ background.js                  # 通用采样/上报 + 指标映射
```

多个 content script 文件是**按数组顺序注入同一个世界**的，共享全局作用域，所以可以这样注册：

```js
// platform-douyin.js —— 必须排在 inject-hook.js 前面
window.__liveCollectorPlatforms = window.__liveCollectorPlatforms || {};
window.__liveCollectorPlatforms.douyin = {
  id: 'douyin',
  match: (host) => /(^|\.)douyin\.com$/.test(host),
  wsPattern: /\/webcast\/im\/push\//,
  apiPatterns: [/\/webcast\/room\/web\/enter\//],
  decodeFrame: async (bytes, emit) => { /* PushFrame → gzip → Response */ },
  extractApi: (url, json) => ({ /* stats + room_view_stats */ }),
  domRules: [{ metric: 'watched', re: /(\d+(?:\.\d+)?)\s*(万|亿)?\s*人看过/ }]
};
```

`inject-hook.js` 只做选平台和分发：

```js
const platform = Object.values(window.__liveCollectorPlatforms || {})
  .find((p) => p.match(location.hostname));
if (!platform) return;
```

`manifest.json` 里 `js` 数组写成 `["src/platform-douyin.js", "src/platform-bilibili.js", "src/inject-hook.js"]`，
两个平台文件各自判断 `match`，只让命中的那个生效。

### 10.2 必须做的三件"防串台"的事

1. **房间 key 加平台前缀**：`dy:95245259671` / `bili:21452505`。
   两个平台的数字 ID 完全可能撞车，不加前缀会串成同一个房间。
   改 `background.js` 的 `canonicalRoomId()` 即可。
2. **`bridge.js` 是 ISOLATED world，看不到 `window.__liveCollectorPlatforms`**（不同 world）。
   所以 DOM 正则要么在 bridge 里再写一份平台分支，要么由 `window.postMessage` 把规则传过去。
   前者更简单，正则也就几行。
3. **服务端加一列 `platform`**：`rooms` 表加 `platform TEXT`，上报时带上。
   面板的房间下拉就能显示 `[抖音] xxx` / `[B站] xxx`，也方便按平台过滤。

### 10.3 指标命名：同名同义，异义分开

| metric | 抖音 | B 站 | 语义是否一致 |
|---|---|---|---|
| `online` | 在线观众（**真人**） | ❌ 无 | —— |
| `popularity` | ❌ 无 | 人气值 | B 站独有 |
| `online_rank` | ❌ 无 | 高能榜在线数（代理） | B 站独有 |
| `watched` | 人看过 | 看过 | ✅ 一致，可以共用一个标签 |
| `likes` | 本场点赞（WS `LikeMessage.total`） | 点赞（待验证） | ⚠️ 语义相近但口径可能不同 |
| `fans` | ❌ 无 | 粉丝数 | B 站独有 |

**不要把 B 站的 `popularity` 直接映射成 `online`。** 面板上宁可多一个指标，
也不要让两个平台的同名指标含义不同——抖音那轮我已经因为语义混淆（`user_count_str` 到底是
在线还是累计）返工过一次。

### 10.4 服务端要改的地方（总共约 20 行）

- `rooms` 表加 `platform` 列（启动时用 `PRAGMA table_info` 判断后 `ALTER TABLE`，兼容老库）
- `METRIC_LABELS` 补 `popularity` / `online_rank` / `fans`
- `/api/rooms` 返回 `platform`，面板下拉加前缀
- 其余（去重、事件检测、降采样、CSV、保留策略、来源优先级、通道状态灯）**一行都不用改**

### 10.5 工作量

| 阶段 | 估计 |
|---|---|
| 把现有抖音解码逻辑抽成 `platform-douyin.js`（纯搬家 + 回归测试） | 半天 |
| 实现 `platform-bilibili.js`（§四） | 半天 |
| 房间 key 前缀 + 服务端 platform 列 + 面板标签 | 2~3 小时 |
| 双平台回归验证（抖音不能因此坏掉） | 2 小时 |

**建议顺序**：先按 §四 + §六 把 B 站单独跑通，**再**做双平台合并。
一上来就重构适配器层，会在「B 站协议还没验证」和「重构引入回归」两件事上同时踩坑，
出问题时分不清是哪边引起的。

### 10.6 为什么是"自动识别"，不是"插件里调模式"

**结论：自动识别，不做模式开关。** 这段是设计取舍，写下来免得以后有人又加个开关。

**1. 平台是页面的客观属性，不是用户偏好。**
`live.douyin.com` 和 `live.bilibili.com` 不可能有歧义，用 hostname 判断是**确定性**的。
凡是能自动推断的东西，就不该交给用户去填。

**2. 模式是"状态"，状态会不一致。**
用户忘了切、两个平台的标签页同时开着、切错了——每一种都会导致
「把抖音页面的 URL 当 B 站房间号上报」这类污染，而且**很难发现**：
数据看起来完全正常，只是房间号是错的、指标是空的。

**3. 成本差一个数量级。**

| 方案 | 成本 |
|---|---|
| 自动识别 | **3 行代码，0 个 UI** |
| 模式开关 | manifest 加 `default_popup` + popup.html/js + 状态存储 + service worker 读取 + 角标提示 + 文档 + 所有"选错模式"的兜底路径 |

**4. 指标集合本身随平台变，靠用户选模式解决不了。**
B 站没有 `online`，抖音没有 `popularity` / `online_rank`。这个差异**必须由面板按 `platform`
自适应**（B 站房间就不该显示那个永远是空的"在线人数"）。

自动识别的全部逻辑就这么点：

```js
const platforms = Object.values(window.__liveCollectorPlatforms || {});
const platform = platforms.find((p) => p.match(location.hostname));
if (!platform) return;   // 不认识的站，什么都不做
```

**那"模式"这个概念什么时候才值得做？**

- **不是"平台模式"，而是策略偏好**：采样密度、是否记录弹幕、保留天数、上报地址——
  这些才是真正的用户偏好，适合做 options page。
- **兜底逃生口**：万一将来域名变了导致自动识别失败，再加"强制指定平台"的高级开关。
  等真遇到再加，别提前做。

**想让用户知道认对了没有，正确做法是"展示"而不是"提问"：**

- 诊断信息带 `platform`，面板「采集通道」区显示 `[抖音]` / `[B站]`
- 工具栏角标的 `title` 写明平台，角标数字仍是当前房间的人数

一句话：**能推断的状态不要问用户，要展示给用户。**
