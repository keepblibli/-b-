# -b-
用于采集直播人数等数据，可将其增涨曲线可视化，可以采集直播间人数显示上限后的真实人数
1.解压 zip 到英文路径，比如 C:\dylm\
2.如果 zip 是下载来的：右键 → 属性 → 勾"解除锁定"
3.装 Python 3.10+
4.双击 C:\dylm\douyin-live-monitor\start_server.cmd（自动建环境、装依赖、起服务、开面板）
5.edge://extensions/ → 开开发人员模式
6.点加载解压缩的扩展 → 选 C:\dylm\douyin-live-monitor\extension 这个子目录
 ⚠️ 别选项目根目录——根目录里没有 manifest.json，会报 Manifest file is missing or unreadable
7。登录抖音和 B站
8.打开一个直播间，等 15~30 秒，面板里出现 [抖音] / [B站] 房间
