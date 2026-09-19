# 换一台新电脑部署

本文只讲"搬家要准备什么"。协议和指标语义见 `README.md` 与 `docs/BILIBILI-PORT.md`。

打包用 `make_package.cmd`（双击即可，会生成 `live-monitor-package.zip`，自动排除
`.venv`、`server\data`、`__pycache__`）。

---

## 一、目标机器需要什么

| 项 | 必须 | 说明 |
|---|---|---|
| Windows 10 1803+ | ✅ | `make_package.cmd` 依赖系统自带的 `tar.exe`；部署本身不依赖 |
| Python 3.10+ | ✅ | 开发机实测 3.13.9。`.cmd` 会自动找 Anaconda / 官方安装路径，并排除 Microsoft Store 的占位程序 |
| Edge 或 Chrome **≥ 111** | ✅ | 扩展用到 `world: "MAIN"`，111 才有 |
| 端口 8787 空闲 | ✅ | 只绑 `127.0.0.1`，**不会触发 Windows 防火墙弹窗** |
| 能访问 PyPI | ✅ 首次 | 装 `fastapi` / `uvicorn` |
| 能访问 `cdn.jsdelivr.net` | ⚠️ 建议 | 面板的 ECharts 从 CDN 加载。不通也能用，只是没有曲线图（数据接口照常） |
| Node.js | ❌ 可选 | 只有跑单测需要，日常使用不需要 |
| **已登录抖音 / B站** | ✅ 强烈建议 | 见第四节，这条最容易被忽略 |

## 二、拷什么 / 不拷什么

```
🎯 douyin-live-monitor\
   ├─ extension\          ✅ 拷（扩展本体，直接加载，无需构建）
   ├─ server\
   │  ├─ app.py           ✅
   │  ├─ selftest.py      ✅
   │  ├─ requirements.txt ✅
   │  ├─ static\          ✅
   │  └─ data\            ⚠️ 想保留历史曲线就拷，否则自动新建空库
   ├─ docs\               ✅
   ├─ README.md           ✅
   ├─ start_server.cmd    ✅ 主力启动方式
   ├─ start_server.ps1    ✅ 备用
   ├─ make_package.cmd    ✅
   ├─ .venv\              ❌ 绝对不要拷！里面是绝对路径和本机二进制，必须在新机器重建
   └─ __pycache__\        ❌ 不要拷
```

> `.venv` 拷过去会以各种奇怪的方式失败（找不到解释器、路径不存在）。
> `start_server.cmd` 检测不到 `.venv` 时会自动重建，所以直接不拷最省事。

## 三、步骤

1. **解压到纯英文路径**，例如 `C:\dylm\`
   - 说明：开发机上我确实遇到过 venv/pip 在这个含中文的工作区路径下失败，
     但后续排查发现**根因是沙箱 ACL**（换成 ASCII 路径同样失败），所以中文路径
     并**没有**被证实是问题。仍然建议用 ASCII 路径——这类工具链对非 ASCII 路径
     的支持历来不稳，没必要冒这个险。
2. **解除文件锁定**（如果压缩包是微信/邮件/网上下载来的）
   - 右键 zip → 属性 → 勾选"解除锁定" → 确定
   - 已经解压了的话，在解压目录执行：`Unblock-File -Path .\* -Recurse`
   - 不解除的后果：`.cmd` 会弹 SmartScreen"Windows 已保护你的电脑"；`.ps1` 直接被策略拦掉
3. **双击 `start_server.cmd`**
   - 它会依次：找 Python → 建 `.venv` → 装依赖 →（已在跑就只开面板）→ 起服务 → 自动打开面板
   - 该脚本是**纯 ASCII**，不受 PowerShell 执行策略限制
4. **自检**（不用开浏览器）：
   ```powershell
   .\.venv\Scripts\python.exe server\selftest.py
   ```
   看到 `全部通过` 说明 Python 这一端没问题。
5. **加载扩展**：`edge://extensions/` → 开"开发人员模式" → "加载解压缩的扩展" → 选 `extension` 目录
   - 建议把扩展"固定到工具栏"：角标会实时显示人数
   - 如果新机器上**已经装过旧版本**：先点该卡片的"重新加载"，或删掉重新加载
6. **登录抖音和 B站**（重要，见第四节）
7. **验证**：打开一个抖音直播间和一个 B站直播间，各等 15~30 秒，看面板里是否出现
   `[抖音]` 和 `[B站]` 两个房间、曲线是否开始长点

## 四、为什么必须登录（最容易被忽略的一条）

扩展的设计是「**只读页面自己发出的请求，不自己发请求**」。所以有没有数据，取决于
**页面自己**能不能正常跑起来：

| 平台 | 未登录会怎样 | 影响 |
|---|---|---|
| 抖音 | 直播间常常直接要求登录，页面不进入直播状态 | 完全没有数据 |
| B站 | 房间页通常能打开，`房间观众 / 看过 / 人气` 来自页面 SSR，一般可见；但**弹幕 WS 认证需要 `uid + buvid + token`**，未登录时连接可能建立不了 | DOM/SSR 通道可能还有，但 WS 通道空 |

> 诚实标注：开发机实测时两个站都处于登录状态，所以"未登录具体缺哪几块"**没有实测数据**，
> 上表是按协议预期写的。新机器上先登录，能省掉一轮排查。

## 五、常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| "在此系统上禁止运行脚本" | Windows 默认执行策略 `Restricted` | 用 `start_server.cmd`；或 `powershell -ExecutionPolicy Bypass -File .\start_server.ps1` |
| `.cmd` 被 SmartScreen 拦 | 压缩包带了 Mark-of-the-Web | 属性 → 解除锁定（或 `Unblock-File`） |
| 双击后窗口一闪而过 | 缺 Python / 依赖装不上 | 在 cmd 里手动运行 `start_server.cmd` 看报错 |
| 面板打不开 | 服务没起 / 端口被占 | `.cmd` 会检测端口占用，占用时只帮你开面板 |
| 面板能开但没曲线 | 没登录 / 没打开直播间页面 | 见第四节 |
| 曲线图区域空白，但数字在动 | 加载不到 jsdelivr CDN | 把 `echarts.min.js` 下载到 `server\static\` 并改 `dashboard.html` 的 `<script src>` 为本地路径 |
| Python 请求 `127.0.0.1` 报 404 | 系统代理没有绕过 localhost | `selftest.py` 已显式禁用代理；浏览器默认绕过 localhost，不受影响 |
| 找错 Python | PATH 里是 Microsoft Store 占位程序 | `.cmd` 已排除 `WindowsApps`；装 python.org 版本最稳 |

## 六、历史数据怎么搬

- **不拷** `server\data\`：新机器从空库开始，什么都不用管
- **拷** `server\data\douyin_live.db`：历史曲线完整保留

搬过去后**不需要手工改数据库**——服务启动时会自动跑迁移：

```
[migrate] 给 N 个历史房间补上 dy: 平台前缀        # 早期只有抖音版时的老 key
[migrate] 折算 N 条历史指标名（{'room_online': 'popularity'}）
```

三张表（`rooms` / `samples` / `events`）都不依赖机器，SQLite 文件直接可用。
数据库是唯一有状态的东西，扩展侧只有几 KB 的 `chrome.storage.local`（待发队列 + 自检信息），
换机器不用管。

## 七、最小准备清单（照着做就行）

1. ☐ 装 **Python 3.10+**（python.org 版本，勾选 Add to PATH）
2. ☐ 拷项目到 **`C:\dylm\`**（**不含 `.venv`**；想要历史就带上 `server\data\`）
3. ☐ 压缩包/文件**解除锁定**
4. ☐ 双击 **`start_server.cmd`**，等它建好环境并打开面板
5. ☐ 跑 **`server\selftest.py`**，确认"全部通过"
6. ☐ `edge://extensions/` **加载 `extension` 目录** + 固定到工具栏
7. ☐ **登录抖音和 B站**
8. ☐ 各开一个直播间，面板里看到 `[抖音]` / `[B站]` 两组曲线

做完这 8 步就有数据了。整个过程除了第 1、7 步，其他都是双击。
