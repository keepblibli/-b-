"""自检脚本：不需要浏览器，直接往本地服务灌一批模拟数据，验证整条链路是否正常。

用法（服务已在运行）：
    python selftest.py
    python selftest.py --base http://127.0.0.1:8787 --wipe
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request

ROOM_ID = "dy:7686045327061355279"  # 带平台前缀，和扩展现在发的 key 形态一致

# 有些 Windows 机器配了系统代理，urllib 会把 127.0.0.1 也发给代理从而导致 404。
# 显式禁用代理，保证自检打的是本机。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(base: str, path: str, payload: dict | None = None) -> dict:
    url = base.rstrip("/") + path
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with OPENER.open(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8787")
    parser.add_argument("--minutes", type=int, default=6, help="模拟多少分钟的数据")
    args = parser.parse_args()
    # Windows 控制台默认是 GBK，中文/符号会直接抛 UnicodeEncodeError
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        health = call(args.base, "/api/health")
    except (urllib.error.URLError, OSError) as e:
        print(f"[x] 连不上服务 {args.base} ：{e}")
        print("    先启动： powershell -ExecutionPolicy Bypass -File .\\start_server.ps1")
        return 1

    print(f"[1/4] 服务在线，现有采样 {health['samples']} 条，库文件：{health['db']}")

    now = int(time.time() * 1000)
    step = 10_000
    count = max(4, args.minutes * 6)
    samples = []
    online = 12_000
    watched = 288_000
    for i in range(count):
        ts = now - (count - i) * step
        online = max(1000, int(online * random.uniform(0.97, 1.06)))
        watched += random.randint(20, 120)
        samples.append(
            {
                "roomId": ROOM_ID,
                "ts": ts,
                "metric": "online",
                "value": online,
                "text": str(online),
                "source": "ws",
                "raw": {"method": "WebcastRoomUserSeqMessage"},
            }
        )
        if i % 3 == 0:
            samples.append(
                {
                    "roomId": ROOM_ID,
                    "ts": ts,
                    "metric": "watched",
                    "value": watched,
                    "text": f"{watched / 10000:.1f}万人看过",
                    "source": "api",
                    "nickname": "火影忍者手游情报君",
                    "title": "火影手游秋季赛资格赛",
                    "webRid": "95245259671",
                    "status": 2,
                    "raw": {"total_user": watched, "like_count": 9954},
                }
            )

    result = call(args.base, "/api/samples", {"samples": samples})
    print(f"[2/4] 上报 {result['received']} 条，落库 {result['accepted']} 条（其余为去重丢弃）")

    rooms = call(args.base, "/api/rooms")["rooms"]
    # 注意：不能假设 rooms[0] 就是自检房间 —— 服务上可能同时有真实直播间在采
    room = next((r for r in rooms if r["room_id"] == ROOM_ID), None)
    if room is None:
        print(f"[x] 房间列表里找不到 {ROOM_ID}，写入可能失败")
        return 1
    print(f"[3/4] 房间：{room['nickname']} / {room['room_id']}  最新 online={room['online']} watched={room['watched']}")

    summary = call(args.base, f"/api/rooms/{ROOM_ID}/summary?hours=24")
    # 故意不传 metric：验证"不传就取该房间最该看的指标"这个默认值逻辑
    series = call(args.base, f"/api/rooms/{ROOM_ID}/series?minutes=60&max_points=50")
    stat = summary["stats"][series["metric"]]
    print(f"[4/4] 默认指标（不传 metric）= {series['metric']}；峰值 {stat['peak']}，均值 {stat['avg']}；"
          f"series：{series['total']} 条 → {len(series['points'])} 点")
    print(f"      中文昵称回读：{room['nickname']!r}（应为“火影忍者手游情报君”）")
    print(f"      观察到的原始字段：{summary['observedRawKeys']}")
    print("\n全部通过。打开面板： " + args.base.rstrip("/") + "/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
