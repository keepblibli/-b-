简洁流程
1. **下载**：本页 `Code → Download ZIP`，解压到 `C:\dylm\`，
   把解压出来的 `-b--main` 文件夹**改名为 `douyin-live-monitor`**
2. **装 Python**：python.org 下载 3.10+，安装时勾上 **Add to PATH**
3. **起服务**：双击 `C:\dylm\douyin-live-monitor\start_server.cmd`
   （首次会自动建环境、装依赖，然后打开面板 http://127.0.0.1:8787/）
4. **装插件**：Edge 打开 `edge://extensions/` → 开**开发人员模式**
   → **加载解压缩的扩展** → 选 `C:\dylm\douyin-live-monitor\extension`
5. **开直播间**：登录抖音 / B站 → 打开任意直播间 → 等 15 秒，面板里出现曲线

**日常**：每次开机先双击一次 `start_server.cmd`；采集时直播间页面别关。

# 直播间人数采集（抖音 + B站 / Edge 扩展 + Python 本地服务）

用你**已经登录的 Edge** 采集抖音和 B站网页版直播间的人数，落到本地 SQLite，带一个实时曲线面板。
**同一个扩展，按域名自动识别平台，不需要切换模式。**

> 说明：Edge 扩展（Manifest V3）只能用 JS/HTML/CSS 写，浏览器不执行 Python。
> 所以这里是 **JS 采集 + Python 存储/可视化** 的组合。

## ⚠️ 它由「两半」组成

| | 插件 `extension/` | 本地服务 `server/` |
|---|---|---|
| 干什么 | 读直播间页面，把人数 POST 到 `127.0.0.1:8787` | 收数据、去重、落 SQLite、出网页面板 |
| 装在哪 | Edge / Chrome 里（开发人员模式加载） | 电脑上跑（双击 `start_server.cmd`） |
| 少了它 | 数据堆在浏览器本地队列（上限 500 条），**面板打不开** | **没有数据可收** |

**三个常见的误解：**

1. **不能把 zip 直接拖进浏览器。** `edge://extensions` 的"加载解压缩的扩展"是个**文件夹选择框**，只认解压后的目录，不认 zip。
2. **不能只装插件。** 面板是本地服务提供的；服务不跑，就没有面板、也看不到数据。
3. **加载扩展时要选 `extension` 这个子目录**，不是项目根目录——根目录里没有 `manifest.json`，会报 `Manifest file is missing or unreadable`。

**怎么下载**：本仓库是**源码仓库**（不再放二进制包）。
点右上角 `Code → Download ZIP` 下载源码（或 `git clone`），解压到**英文路径**，例如 `C:\dylm\`。
需要打包成可迁移的 zip 时跑 `make_package.cmd`——它会自动排除 `.venv`、数据库和日志。

完整步骤见下面的「三、跑起来」。

## 两个平台的指标不一样

| 指标 | 抖音 | B站 | 语义 |
|---|---|---|---|
| `online` | ✅ 在线观众（**真实人数**） | —— | 并发在线 |
| `room_viewers` | —— | ✅ 房间观众（**最接近真实人数**） | 并发观众，有系统性低估 |
| `watched` | ✅ 人看过 | ✅ 看过 | 累计观看人次 |
| `popularity` | —— | ✅ 人气值 | **热度加权值，不是人数** |
| `likes` | ✅ 本场点赞 | ✅ 点赞 | 点赞 |
| `fans` | —— | ✅ 粉丝数 | 粉丝 |

⚠️ **B站不提供权威的真实并发人数**（2017 年前后把"在线人数"换成了"人气值"）。
`房间观众` 是最接近的公开代理，`人气值` 只能反映热度、跨房间不可比。
详见 `docs/BILIBILI-PORT.md` §九。



## 一、实测结论（2026-09 实测）

### 1. 网页版**有**在线人数，只是藏在榜单入口按钮里

真实房间页面上存在这样一个元素（无障碍名）：

```
@e109 button "在线观众 · 1万"
  StaticText "在线观众"
  StaticText "·"
  StaticText "1万"
```

这就是**并发在线人数**，而且与直播广场卡片上的数字一致（同一房间卡片也显示 `1万`）。
注意文案里**没有**"人在线"三个字，所以拿 `\d+人在线` 去匹配必然失败，必须匹配 `在线观众\s*[·:：]?\s*(\d+万?)`。

> **纠错**：第一轮实测我曾断言"全页 HTML 搜 `在线` 零匹配、网页版没有在线人数"。
> 那是取样偏差——当时抓的是**广场页**的 HTML，榜单面板还没渲染进 DOM。
> 后续在真实房间页渲染完成后抓到了上面的元素，结论正好相反。
> 教训：判定"页面没有某数据"必须用渲染完成后的房间页，不能用首页或中间态 HTML。

### 2. 三种数据源实测对照（同一房间、同一时刻）

| 来源 | 实测取到的值 | 可靠性 |
|---|---|---|
| DOM `在线观众 · 1万` | `1万` | 准，但依赖 UI 渲染 |
| enter 接口 `stats.user_count_str` | `"1万"` | 准，**这就是并发在线人数** |
| enter 接口 `stats.total_user_str` | `"10万"` | 累计观看（人看过），与在线是两个量 |
| enter 接口 `stats.like_count` | `0` | **不准**：进房瞬间的快照，页面实际显示 `72.9万本场点赞` |
| WS `RoomUserSeqMessage.total` | 帧是 gzip，需 inflate | 理论上最准 |
| WS `LikeMessage.total` | 实测页面显示 `72.9万本场点赞` | **本场累计点赞的正主**，点赞只认这里 |

实测到的 enter 响应里 `stats` 只有 4 个字段：`total_user_desp`、`total_user_str`、`user_count_str`、`like_count`；
另有 `room_view_stats`（广场卡片用的那份）需要一并采集。

### 3. WebSocket 在主线程，且帧带 gzip

抓到的是：

```
wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?...&compress=gzip&...
```

好消息：它**没有**跑在 Web Worker 里，MAIN world 的 hook 能拦到。
坏消息：帧是**两层**结构，直接按 `Response` 解会一条都解不出来（我第一版就是这么错的，149 帧全部解析为 0）：

```
PushFrame { seqid=1, logid=2, service=3, method=4, headers=5,
            payload_encoding=6, payload_type=7, payload=8(bytes) }
   └─ payload (field 8) 通常 gzip → inflate → Response { repeated Message messages = 1 }
```

抓到的真实首帧前 24 字节（可以据此对照确认协议没变）：

```
08 01 10 dd e9 ee a2 a9 f5 9e 8d 13 18 b8 45 20 08 2a 15 0a 0d "com..."
 │     │                                │     │  └ f5=HeadersList → "compress=gzip"
 │     │                                │     └ f4=method=8
 │     │                                └ f3=service
 │     └ f2=logid
 └ f1=seqid=1
```

这条链路有单测兜底，改完代码先跑它：

```powershell
node extension\test\ws-decode.test.mjs
```

它会构造一条 `PushFrame → gzip → Response → RoomUserSeqMessage` 的假帧并断言能解出
`total=12800`，还会断言"把 Response 直接当 PushFrame 解时取不到 payload"——正是第一版的 bug。

`RoomUserSeqMessage` 的字段定义可参考社区维护的 proto（[DouyinBarrageGrab/proto/message.proto](https://raw.githubusercontent.com/ape-byte/DouyinBarrageGrab/master/BarrageGrab/proto/message.proto)）：
`total=3`、`totalUser=7`、`totalUserStr=8`、`totalStr=9`、`onlineUserForAnchor=10`。

4. 所以本方案做成**三通道同时采**，取到哪个算哪个，面板上标明数据来源，互相对照：

```
通道 A（主） MAIN world hook WebSocket → 手写 varint 解析 protobuf → online / watched
通道 B      MAIN world hook fetch/XHR → /webcast/room/web/enter/ 的 stats + room_view_stats
通道 C      DOM 定时扫描 → "在线观众 · x" / "x.x万人看过"（叶子节点 + 浅容器节点）
```

> 抖音会随时间改字段、改协议。为了不让你瞎猜，服务端有一个 `/api/rooms/{id}/summary` 的
> `observedRawKeys` 字段，会把**接口里真实出现过的所有 key** 列在面板右侧。改版时照着改映射即可。

---

## 二、目录结构

```
douyin-live-monitor/
├─ extension/                        # Edge/Chrome MV3 扩展（抖音 + B站）
│  ├─ manifest.json                  # 同时匹配两个域名
│  ├─ src/
│  │  ├─ inject-hook.js              # MAIN world：抖音（PushFrame + protobuf + gzip）
│  │  ├─ platform-bilibili.js        # MAIN world：B站（16字节头 + zlib + SSR 全局扫描）
│  │  ├─ bridge.js                   # ISOLATED world：转发消息 + 按平台的 DOM 兜底
│  │  └─ background.js               # service worker：采样/上报/角标 + 平台 key 前缀
│  └─ test/
│     ├─ ws-decode.test.mjs          # 抖音解码单测（16 项断言）
│     └─ bili-decode.test.mjs        # B站解码单测（21 项断言）
├─ server/                           # Python 端（与平台无关）
│  ├─ app.py                         # FastAPI + SQLite（去重/事件/降采样/CSV/保留策略）
│  ├─ selftest.py                    # 不开浏览器就能验证整条链路
│  ├─ requirements.txt
│  └─ static/dashboard.html          # ECharts 实时面板（指标按房间动态生成）
├─ docs/
│  ├─ BILIBILI-PORT.md               # B站协议设计 + **实测报告**（含两个被推翻的假设）
│  └─ DEPLOY.md                      # 换新电脑的部署清单（该装的、该拷的、该登录的）
├─ start_server.cmd                  # 一键启动（批处理，不受 PowerShell 执行策略限制，推荐）
├─ start_server.ps1                  # 同上，PowerShell 版
├─ make_package.cmd                  # 打包成迁移 zip（自动排除 .venv / 数据库）
└─ README.md
```

> **B 站相关的坑与实测数据**都在 `docs/BILIBILI-PORT.md`：协议帧格式、被推翻的假设
> （心跳人气值是占位值、新版房间页不走 XHR）、以及 brotli 这个已知限制。

---

## 三、跑起来

### 1) 启动 Python 服务

**推荐：双击 `start_server.cmd`**（或在命令行里跑 `start_server.cmd`）。

它是纯批处理，**不受 PowerShell 执行策略限制**，也不经过 PowerShell：
没有 `.venv` 就自己找 Python 建环境装依赖，已经在跑就只帮你打开面板，最后自动开浏览器到
<http://127.0.0.1:8787/>。

> 这个文件是**故意全 ASCII** 的。cmd.exe 读批处理时按字节偏移推进，文件里混入 UTF-8 中文会让它
> 解析错位（实测会直接去裸跑 `python.exe`，一句 echo 都执行不到）。想加注释请用英文，
> 中文说明放 README。

**PowerShell 版**（功能一样，脚本更易读）：

```powershell
cd douyin-live-monitor
powershell -ExecutionPolicy Bypass -File .\start_server.ps1
```

脚本会自己找 Python（`PATH` 里的 `python`、`C:\ProgramData\Anaconda3`、`%USERPROFILE%\anaconda3`、官方安装路径……），
建好 `.venv` 后装依赖并起服务。

**完全手动**：

```powershell
C:\ProgramData\Anaconda3\python.exe -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8787 --app-dir server
```

#### 被 Windows 拦住脚本运行？

报错长这样：

```
无法加载文件 ...\start_server.ps1，因为在此系统上禁止运行脚本。
```

原因是 Windows 客户端默认执行策略就是 `Restricted`（`Get-ExecutionPolicy` 可确认）。
三种解法，按推荐顺序：

| 做法 | 命令 | 影响范围 |
|---|---|---|
| **改用批处理**（推荐） | 跑 `start_server.cmd` | 不改任何系统设置 |
| 只对这一次放行 | `powershell -ExecutionPolicy Bypass -File .\start_server.ps1` | 仅本次进程 |
| 永久放开当前用户 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` | 只改你自己的账户，**不需要管理员**；且只放行本地脚本，网上下载的仍需签名 |

如果报的是"文件来自网络被阻止"而不是"脚本被禁止"，先解除锁定：

```powershell
Unblock-File .\start_server.ps1
```

（`Get-Item .\start_server.ps1 -Stream *` 里能看到是否存在 `Zone.Identifier` 流。）

打开 <http://127.0.0.1:8787/> 应该能看到面板（此时还是空的）。

### 1.5) 先自检（不用开浏览器）

```powershell
.\.venv\Scripts\python.exe server\selftest.py
```

它会灌一批模拟数据进本地服务并回读校验，看到 `全部通过` 就说明 Python 这一端没问题：

```
[1/4] 服务在线，现有采样 0 条 ...
[2/4] 上报 48 条，落库 48 条（其余为去重丢弃）
[3/4] 房间：火影忍者手游情报君 / 7686045327061355279  最新 online=15986 watched=290403
[4/4] summary：online 峰值 ... series：40 条 → 6 点
全部通过。打开面板： http://127.0.0.1:8787/
```

> 自检脚本里显式禁用了系统代理：有些 Windows 机器配了代理后，Python 发往 `127.0.0.1`
> 的请求会被代理吞掉并返回 404（浏览器不会，Chromium 默认绕过 localhost）。

### 2) 在 Edge 里加载扩展

1. 地址栏输入 `edge://extensions/`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择 `douyin-live-monitor\extension` 目录
4. 建议在扩展详情里把 **固定到工具栏** 打开——工具栏角标会实时显示人数

> 一个扩展同时管两个平台，**按域名自动识别**，不需要切换模式。
> 改过代码后记得点一次该扩展卡片的 **重新加载**（`edge://` 页面无法被自动化，只能手点）。

### 3) 验证

**抖音**：打开任意直播间（如 <https://live.douyin.com/95245259671>），等 10~20 秒，
面板里会出现 `[抖音] 房间`，指标是 `online` / `watched` / `likes`，来源都应是 `ws`。

**B站**：打开任意直播间（如 <https://live.bilibili.com/33989>），等 15~30 秒，
面板里会出现 `[B站] 房间`，预期指标：

| 指标 | 预期来源 | 说明 |
|---|---|---|
| `room_viewers` | `dom` | 房间观众，每 4 秒扫一次 |
| `likes` | `dom` | 点赞 |
| `watched` | `api` | 看过（来自页面 SSR 全局） |
| `popularity` | `api` | 人气值（**热度，不是人数**） |

B站**不会**有 `online` 指标，这是正常的——B站不公开真实并发人数，用 `room_viewers` 代替。

### 4) 排查（扩展侧）

`edge://extensions/` → 本扩展 → **服务工作进程** 点开，控制台里执行：

```js
chrome.storage.local.get('dy_diagnostics', console.log)
```

会看到：

| 字段 | 说明 |
|---|---|
| `lastHookReadyAt` | MAIN world hook 是否注入成功 |
| `lastWsOpenAt` / `wsUrl` | **有没有抓到 `/webcast/im/push/` 的 WebSocket**（这是能否拿到在线人数的关键） |
| `wsMethods` | WS 上最近出现过哪些消息类型；**看到 `WebcastRoomUserSeqMessage` 就说明在线人数这条通道是通的** |
| `lastEnterApiAt` / `enterApiKeys` | enter 接口是否抓到、里面有哪些字段 |
| `endpointOk` / `lastError` | 与本地服务通信是否正常 |

同时看页面控制台有没有 `[dylive-collector]` 相关报错。

---

## 四、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/samples` | 扩展上报入口，body `{"samples":[{roomId,ts,metric,value,text,source,raw,...}]}` |
| GET | `/api/health` | 存活 + 最后一条采样距今多久 + 数据库体积 + 保留策略状态 |
| POST | `/api/maintenance/prune?days=30&vacuum=true` | 手动清理过期数据（默认 30 天） |
| GET | `/api/rooms` | 房间列表 + 最新 online/watched |
| GET | `/api/rooms/{id}/series?metric=online&minutes=60&max_points=600&source=ws` | 降采样后的时间序列；`source` 不传则按 `ws > dom > api` 自动挑 |
| GET | `/api/rooms/{id}/summary?hours=24` | 当前值 / 峰值 / 均值 / 事件 / 出现过的 raw key |
| GET | `/api/rooms/{id}/export.csv?metric=online` | 导出 CSV |

指标名：`online`（在线人数）、`watched`（累计观看）、`likes`（本场点赞）。

---

## 五、采样与去重策略

- 数值没变：最快 5 秒一条，且最多 20 秒必留一条心跳，曲线不会断
- 数值变化 ≥10%：放宽到 2 秒一条（人数暴涨时自动加密）
- 服务端再做一层：同值且间隔 <8 秒直接丢弃
- 事件：`live_start` / `live_end`（靠 `room.status` 2=直播中、4=已结束）、`spike`（超过近 30 分钟中位数 2 倍）
- 上报失败自动进 `chrome.storage.local` 队列（上限 500 条），服务起来后自动补发

### 同名指标的多来源优先级（ws > dom > api）

三条通道都会给"在线人数 / 累计观看"，但可靠性并不一样，**混着画会出锯齿**（实测同一房间
WS 给 `288112`，enter 接口的 `total_user_str` 给 `"10万+"`）。所以服务端默认只取优先级最高的一路：

| 来源 | 实测表现 |
|---|---|
| `ws` | `RoomUserSeqMessage` 同时给在线人数(`total`)与累计观看(`totalUser`)；`LikeMessage.total` 给本场累计点赞——首选 |
| `dom` | 页面文案（`在线观众 · 1万` / `x.x万人看过` / `72.9万 本场点赞`），准但依赖渲染 |
| `api` | enter 接口 `stats` 文案，粒度粗：`total_user_str` 与房间页对不上，`like_count` 恒为 0 |

响应里会返回实际采用的 `source`，面板上也会标出来；想强制看某一路可以传参：
`/api/rooms/{id}/series?metric=online&source=dom`。

> **关于点赞**：`enter` 接口那条路上的 `like_count` 恒为 0，所以扩展**不从它取点赞**，
> 改由 WS 的 `LikeMessage.total`（本场累计）提供——就是页面右上角"x.x万本场点赞"的同一个值；
> DOM 里有 `72.9万 本场点赞` 文案时也能兜底。

---

## 六、存储与自动清理

数据分两处，**扩展侧几乎不占地方，大头在 Python 侧的 SQLite**。

**扩展侧**（`chrome.storage.local`，两项）：

| key | 内容 | 上限 |
|---|---|---|
| `dy_pending_queue` | 上报失败的待发队列（只在服务没起/断网时积压） | 硬限 500 条 ≈ 50~100 KB |
| `dy_diagnostics` | 通道自检信息 | 几 KB |

没有 IndexedDB、不缓存 WS 原始帧、不存历史曲线，正常情况下就是几 KB。

**服务端**（`server/data/douyin_live.db`，WAL 模式）：只有 `samples` 会持续增长。实测每行成本：

| 来源 | 每行 | 说明 |
|---|---|---|
| `ws` | 约 **80 字节** | raw 只存 `{"method":"..."}` |
| `api` | 约 **1,180 字节** | raw 存整份 `stats`+`room_view_stats`，但**每次进房才写一次** |

实测采样速率约 **7 条/分钟/房间**（值和上次相同的话 20 秒才留一条心跳）。换算：

- 单房间连播 24h ≈ 1 万行 ≈ **0.8 MB**
- 每天播 6h ≈ 0.2 MB/天 → **一年约 70 MB**
- 7×24 不间断 → **一年约 290 MB**

### 自动保留策略（默认 30 天）

服务启动时立刻清一次，之后每 6 小时检查一次，删除超过 `RETENTION_DAYS` 的
`samples` / `events`，以及**已经过期且没有采样残留的房间行**；每 7 天顺带 `VACUUM` 一次
（不 VACUUM 的话删了行文件也不会变小）。

想改天数用环境变量：

```powershell
$env:DYLIVE_RETENTION_DAYS = "7"      # 只留 7 天
$env:DYLIVE_VACUUM_EVERY_DAYS = "3"   # 每 3 天整理一次
.\start_server.ps1
```

也可以随时手动清一次（面板不提供按钮，用命令行）：

```powershell
curl.exe -X POST "http://127.0.0.1:8787/api/maintenance/prune?days=7&vacuum=true"
```

`/api/health` 会报告 `dbBytes`、`oldestSampleAt`、`retention.lastPruneAt/lastVacuumAt`——
面板顶部也会实时显示"数据库 60.0 KB · 采样 150 条 · 保留 30 天后自动清理"。

---

## 七、已知限制 / 注意

- **WS 可能在 Worker 里**：抖音部分版本把弹幕长连接放在 Web Worker，那样 MAIN world 的 hook 就抓不到，只能靠 enter 接口 + DOM。看诊断里的 `lastWsOpenAt` 是否为空即可判断。
- **数字可能被打码/放大**：抖音对部分直播间的人数做过处理，`total` 未必等于真实人头数。
- **protobuf 结构会变**：`decodeRoomUserSeq` 只按字段号取值，抖音改了字段号就得同步改 `inject-hook.js`。
- **DOM 选择器很脆**：本方案尽量用文本正则（`xx.x万人看过`）而不是 class（抖音的 class 是构建哈希，每次发版都变），但仍可能失效。
- **接口签名**：本项目**不主动请求抖音接口**，只被动读取你自己浏览器已经发出的请求，因此不涉及 `a_bogus`/`msToken` 签名，也不会因为高频请求触发风控。请不要改成主动轮询。
- **合规**：仅用于个人对公开直播数据的观察记录。别做批量扫站、别用于商业采集，遵守抖音用户协议与 robots/平台规则。
- 数据默认落在 `server/data/douyin_live.db`（SQLite WAL）。
- **B站的弹幕/部分通知走 brotli 压缩**，浏览器原生解不开，那部分 WS 推送拿不到；`房间观众` 和 `看过` 不受影响（分别走 DOM 和 SSR）。详见 `docs/BILIBILI-PORT.md` §六。
- **必须保持直播间页面开着**：扩展只读页面已经产生的请求，不主动轮询；页面一关就没数据。
- **每次开机后要重新运行 `start_server.cmd`**：服务是本地进程，不会开机自启。想自启就把它放进"启动"文件夹，或用任务计划程序。
