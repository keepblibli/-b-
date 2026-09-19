"""抖音直播间人数采集 —— 本地服务端。

职责：接收浏览器扩展上报的采样点，落 SQLite，做去重 / 事件检测 / 降采样查询，
并提供一个看一眼就懂的 ECharts 面板。

启动：
    python -m uvicorn app:app --host 127.0.0.1 --port 8787
或：
    python app.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import statistics
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
DB_PATH = DATA_DIR / "douyin_live.db"

# 保留策略：samples/events 超过这个天数就删；删完不 VACUUM 文件不会变小，所以定期 VACUUM 一次。
# 想改就设环境变量，例如：$env:DYLIVE_RETENTION_DAYS=7
RETENTION_DAYS = int(os.environ.get("DYLIVE_RETENTION_DAYS", "30"))
VACUUM_EVERY_DAYS = int(os.environ.get("DYLIVE_VACUUM_EVERY_DAYS", "7"))
CLEANUP_INTERVAL_S = 6 * 3600  # 每 6 小时检查一次（进程内，不依赖外部定时任务）

# 同一个 (房间, 指标) 在这么多毫秒内数值相同则视为重复，只更新 last_seen 不新增行
DEDUPE_WINDOW_MS = 8000
# 相邻两条采样间隔超过这么久，认为中间断档（页面关了/切走了）
GAP_MS = 3 * 60 * 1000

METRIC_LABELS = {
    # 抖音
    "online": "在线观众(抖音)",
    "watched": "累计观看(人看过)",
    "likes": "点赞",
    # B站
    "popularity": "人气值(热度,非人数)",
    "room_viewers": "房间观众(接近真实)",
    "online_rank": "高能榜在线数",
    "fans": "粉丝数",
}

# 指标改名时的兼容映射：老数据里的名字统一折算到新名字
METRIC_ALIASES = {"room_online": "popularity"}

# 指标展示顺序 = 默认选中顺序：越靠前越"像在线人数"。
# 面板的第一个指标按钮就是默认显示的那个，所以 B站房间会默认落在 room_viewers 上，
# 而不是 watched（累计观看）——后者容易让人误以为是当前人数。
METRIC_ORDER = ("online", "room_viewers", "online_rank", "watched", "popularity", "likes", "fans")

# 这些指标表示"当前有多少人"，值得做峰值检测（两个平台的叫法不同）
VIEWER_METRICS = ("online", "room_viewers", "room_online")

PLATFORM_LABELS = {"dy": "抖音", "bili": "B站"}


def platform_of(room_id: str) -> str:
    """房间 key 带平台前缀（dy:xxx / bili:xxx）；早期只有抖音版时写的数据没有前缀。"""
    if ":" in room_id:
        return room_id.split(":", 1)[0]
    return "dy"

# 同名指标可能来自多条通道，实测可靠性差别很大：
#   ws  = RoomUserSeqMessage，同时给出在线人数与累计观看，与页面 UI 一致 —— 最可信
#   dom = 页面文案（"在线观众 · 1万" / "x.x万人看过"），准但依赖渲染
#   api = enter 接口的 stats 文案，粒度粗（实测 total_user_str 与房间页对不上，like_count 恒为 0）
# 混着画会出锯齿，所以默认按优先级取单一来源，并在响应里告诉你取了哪个。
SOURCE_PRIORITY = ("ws", "dom", "api")


def pick_source(conn: sqlite3.Connection, room_id: str, metric: str, start: int) -> str | None:
    rows = conn.execute(
        "SELECT source, COUNT(*) AS n FROM samples WHERE room_id = ? AND metric = ? AND ts >= ?"
        " GROUP BY source",
        (room_id, metric, start),
    ).fetchall()
    present = {r["source"] for r in rows if r["source"]}
    if not present:
        return None
    for src in SOURCE_PRIORITY:
        if src in present:
            return src
    return sorted(present)[0]

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    room_id     TEXT PRIMARY KEY,
    web_rid     TEXT,
    nickname    TEXT,
    title       TEXT,
    status      INTEGER,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id  TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    metric   TEXT NOT NULL,
    value    INTEGER,
    text     TEXT,
    source   TEXT,
    raw      TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_lookup ON samples(room_id, metric, ts);

CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id  TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    kind     TEXT NOT NULL,
    detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, ts);

-- 单行表：扩展每次上报顺带推上来的自检信息（哪条通道活着、WS 上见过什么消息）
CREATE TABLE IF NOT EXISTS diagnostics (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    ts   INTEGER NOT NULL,
    json TEXT NOT NULL
);

-- 极小的键值表，记录上次清理/整理时间
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# --------------------------------------------------------------------- 数据层
def migrate_legacy_room_ids(conn: sqlite3.Connection) -> int:
    """把早期（只有抖音版时）没有平台前缀的 room_id 补成 dy: 前缀。

    不补的话，扩展升级后同一个抖音房间会同时存在 '615189692839' 和 'dy:615189692839'
    两条记录，历史曲线直接分家。
    """
    rows = conn.execute("SELECT room_id FROM rooms WHERE room_id NOT LIKE '%:%'").fetchall()
    moved = 0
    for row in rows:
        old = row["room_id"]
        new = f"dy:{old}"
        if conn.execute("SELECT 1 FROM rooms WHERE room_id = ?", (new,)).fetchone():
            continue  # 已经有新 key 了，跳过，避免主键冲突
        for table in ("samples", "events"):
            conn.execute(f"UPDATE {table} SET room_id = ? WHERE room_id = ?", (new, old))
        conn.execute("UPDATE rooms SET room_id = ? WHERE room_id = ?", (new, old))
        moved += 1
    if moved:
        conn.commit()
    return moved


def migrate_metric_names(conn: sqlite3.Connection) -> int:
    """指标改名后的历史数据折算（如 room_online → popularity）。"""
    moved = 0
    for old, new in METRIC_ALIASES.items():
        moved += conn.execute("UPDATE samples SET metric = ? WHERE metric = ?", (new, old)).rowcount
    if moved:
        conn.commit()
    return moved


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()
        moved = migrate_legacy_room_ids(conn)
        if moved:
            print(f"[migrate] 给 {moved} 个历史房间补上 dy: 平台前缀", flush=True)
        renamed = migrate_metric_names(conn)
        if renamed:
            print(f"[migrate] 折算 {renamed} 条历史指标名（{METRIC_ALIASES}）", flush=True)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield conn
    finally:
        conn.close()


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------- 模型
class SampleIn(BaseModel):
    roomId: str = Field(default="unknown")
    ts: int | None = None
    metric: str
    value: int | None = None
    text: str | None = None
    source: str | None = None
    raw: Any | None = None
    nickname: str | None = None
    title: str | None = None
    webRid: str | None = None
    status: int | None = None


class SamplesIn(BaseModel):
    samples: list[SampleIn] = Field(default_factory=list)
    diag: dict[str, Any] | None = None


# --------------------------------------------------------------------- 写入
def upsert_room(conn: sqlite3.Connection, sample: SampleIn, ts: int) -> None:
    row = conn.execute("SELECT room_id FROM rooms WHERE room_id = ?", (sample.roomId,)).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO rooms (room_id, web_rid, nickname, title, status, first_seen, last_seen)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sample.roomId, sample.webRid, sample.nickname, sample.title, sample.status, ts, ts),
        )
        conn.execute(
            "INSERT INTO events (room_id, ts, kind, detail) VALUES (?, ?, 'first_seen', ?)",
            (sample.roomId, ts, json.dumps({"source": sample.source}, ensure_ascii=False)),
        )
        return

    old = conn.execute(
        "SELECT web_rid, nickname, title, status FROM rooms WHERE room_id = ?", (sample.roomId,)
    ).fetchone()

    new_status = sample.status if sample.status is not None else old["status"]
    conn.execute(
        "UPDATE rooms SET web_rid = COALESCE(?, web_rid), nickname = COALESCE(?, nickname),"
        " title = COALESCE(?, title), status = ?, last_seen = ? WHERE room_id = ?",
        (sample.webRid, sample.nickname, sample.title, new_status, ts, sample.roomId),
    )

    if sample.status is not None and old["status"] is not None and sample.status != old["status"]:
        kind = "live_start" if sample.status == 2 else "live_end" if sample.status == 4 else "status_change"
        conn.execute(
            "INSERT INTO events (room_id, ts, kind, detail) VALUES (?, ?, ?, ?)",
            (sample.roomId, ts, kind, json.dumps({"from": old["status"], "to": sample.status})),
        )


def insert_sample(conn: sqlite3.Connection, sample: SampleIn) -> bool:
    """返回 True 表示真的写入了一行（未被去重丢掉）。"""
    if sample.value is None:
        return False
    ts = sample.ts or now_ms()
    # 指标改名的兼容：老客户端/老代码发的名字在这里统一折算
    metric = METRIC_ALIASES.get(sample.metric or "", sample.metric or "unknown")

    last = conn.execute(
        "SELECT ts, value FROM samples WHERE room_id = ? AND metric = ? ORDER BY ts DESC LIMIT 1",
        (sample.roomId, metric),
    ).fetchone()

    if last is not None and last["value"] == sample.value and ts - last["ts"] < DEDUPE_WINDOW_MS:
        return False

    raw = json.dumps(sample.raw, ensure_ascii=False) if sample.raw is not None else None
    if raw and len(raw) > 4000:
        raw = raw[:4000]
    conn.execute(
        "INSERT INTO samples (room_id, ts, metric, value, text, source, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sample.roomId, ts, metric, sample.value, sample.text, sample.source, raw),
    )

    # 峰值检测对"看人数"的指标都做，不能只认抖音的 online ——
    # B站的 room_viewers 同样是人数型指标，之前写死 online 导致 B站永远没有 spike 事件。
    if metric in VIEWER_METRICS:
        detect_spike(conn, sample.roomId, metric, ts, sample.value)
    return True


def detect_spike(conn: sqlite3.Connection, room_id: str, metric: str, ts: int, value: int) -> None:
    """人数突然远高于近 30 分钟中位数 → 记一条 spike 事件（每分钟最多一条）。"""
    window_start = ts - 30 * 60 * 1000
    rows = conn.execute(
        "SELECT value FROM samples WHERE room_id = ? AND metric = ? AND ts BETWEEN ? AND ?",
        (room_id, metric, window_start, ts),
    ).fetchall()
    values = [r["value"] for r in rows if r["value"] is not None]
    if len(values) < 10:
        return
    median = statistics.median(values)
    if median <= 0 or value < max(median * 2, median + 100):
        return

    recent = conn.execute(
        "SELECT ts FROM events WHERE room_id = ? AND kind = 'spike' ORDER BY ts DESC LIMIT 1",
        (room_id,),
    ).fetchone()
    if recent is not None and ts - recent["ts"] < 60_000:
        return
    conn.execute(
        "INSERT INTO events (room_id, ts, kind, detail) VALUES (?, ?, 'spike', ?)",
        (room_id, ts, json.dumps({"metric": metric, "value": value, "median": median}, ensure_ascii=False)),
    )


# --------------------------------------------------------------------- 清理
def meta_get(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def meta_set(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def db_size_bytes() -> int:
    total = 0
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(DB_PATH) + suffix)
        if p.exists():
            total += p.stat().st_size
    return total


def prune(days: int | None = None, vacuum: bool | None = None) -> dict[str, Any]:
    """删除超过保留期的采样与事件；必要时 VACUUM 让文件真正变小。"""
    days = RETENTION_DAYS if days is None else days
    cutoff = now_ms() - days * 86400 * 1000
    before = db_size_bytes()
    with connect() as conn:
        deleted_samples = conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff,)).rowcount
        deleted_events = conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,)).rowcount
        # 顺手清掉既过期、又没有采样残留的房间行，免得面板里堆一堆已经没有数据的死房间
        deleted_rooms = conn.execute(
            "DELETE FROM rooms WHERE last_seen < ?"
            " AND room_id NOT IN (SELECT DISTINCT room_id FROM samples)",
            (cutoff,),
        ).rowcount
        conn.commit()

        last_vacuum = meta_get(conn, "last_vacuum_ms")
        should_vacuum = vacuum
        if should_vacuum is None:
            should_vacuum = last_vacuum is None or now_ms() - int(last_vacuum) >= VACUUM_EVERY_DAYS * 86400 * 1000

        vacuumed = False
        if should_vacuum:
            try:
                # VACUUM 不能在事务里跑，上面已经 commit；并发请求时可能失败，下次循环再试
                conn.execute("VACUUM")
                meta_set(conn, "last_vacuum_ms", now_ms())
                conn.commit()
                vacuumed = True
            except sqlite3.Error:
                vacuumed = False

        meta_set(conn, "last_prune_ms", now_ms())
        conn.commit()

    after = db_size_bytes()
    return {
        "retentionDays": days,
        "cutoff": cutoff,
        "deletedSamples": deleted_samples,
        "deletedEvents": deleted_events,
        "deletedRooms": deleted_rooms,
        "vacuumed": vacuumed,
        "dbBytesBefore": before,
        "dbBytesAfter": after,
        "freedBytes": max(0, before - after),
    }


async def maintenance_loop() -> None:
    """启动时立刻清一次，之后每 6 小时一次。"""
    while True:
        try:
            result = await asyncio.to_thread(prune)
            if result["deletedSamples"] or result["deletedEvents"] or result["deletedRooms"] or result["vacuumed"]:
                print(
                    f"[retention] 删除采样 {result['deletedSamples']} 条 / 事件 {result['deletedEvents']} 条"
                    f" / 房间 {result['deletedRooms']} 个，VACUUM={'是' if result['vacuumed'] else '否'}，"
                    f"释放 {result['freedBytes'] / 1024:.0f} KB",
                    flush=True,
                )
        except Exception as exc:  # 清理失败绝不能拖垮服务
            print(f"[retention] 清理失败：{exc}", flush=True)
        await asyncio.sleep(CLEANUP_INTERVAL_S)


# --------------------------------------------------------------------- 应用
@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    task = asyncio.create_task(maintenance_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="抖音直播间人数采集", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    with connect() as conn:
        samples = conn.execute("SELECT COUNT(*) AS c FROM samples").fetchone()["c"]
        last = conn.execute("SELECT MAX(ts) AS t FROM samples").fetchone()["t"]
        oldest = conn.execute("SELECT MIN(ts) AS t FROM samples").fetchone()["t"]
        last_prune = meta_get(conn, "last_prune_ms")
        last_vacuum = meta_get(conn, "last_vacuum_ms")
    return {
        "ok": True,
        "samples": samples,
        "lastSampleAt": last,
        "lastSampleAgeMs": (now_ms() - last) if last else None,
        "oldestSampleAt": oldest,
        "db": str(DB_PATH),
        "dbBytes": db_size_bytes(),
        "retention": {
            "days": RETENTION_DAYS,
            "vacuumEveryDays": VACUUM_EVERY_DAYS,
            "lastPruneAt": int(last_prune) if last_prune else None,
            "lastVacuumAt": int(last_vacuum) if last_vacuum else None,
        },
    }


@app.post("/api/maintenance/prune")
def run_prune(
    days: int | None = Query(default=None, ge=1, le=3650, description="不传则用服务端配置的天数"),
    vacuum: bool = Query(default=True),
) -> dict[str, Any]:
    """手动触发一次清理（面板/脚本都能调）。"""
    return {"ok": True, **prune(days=days, vacuum=vacuum)}


@app.post("/api/samples")
def post_samples(payload: SamplesIn) -> dict[str, Any]:
    accepted = 0
    rooms: set[str] = set()
    with connect() as conn:
        for sample in payload.samples:
            ts = sample.ts or now_ms()
            sample.ts = ts
            upsert_room(conn, sample, ts)
            if insert_sample(conn, sample):
                accepted += 1
            rooms.add(sample.roomId)
        if payload.diag:
            conn.execute(
                "INSERT INTO diagnostics (id, ts, json) VALUES (1, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, json = excluded.json",
                (now_ms(), json.dumps(payload.diag, ensure_ascii=False)),
            )
        conn.commit()
    return {"ok": True, "accepted": accepted, "received": len(payload.samples), "rooms": sorted(rooms)}


@app.get("/api/diagnostics")
def get_diagnostics() -> dict[str, Any]:
    """把扩展推上来的自检信息翻译成"哪条通道活着"，方便一眼判断该不该调字段。"""
    with connect() as conn:
        row = conn.execute("SELECT ts, json FROM diagnostics WHERE id = 1").fetchone()
    if row is None:
        return {
            "ts": None,
            "diag": None,
            "channels": {"hook": False, "ws": False, "wsSeq": False, "enterApi": False, "endpoint": False},
            "hint": "还没收到扩展的任何上报：确认服务已启动、扩展已加载，并打开了一个抖音直播间页面。",
        }

    diag = json.loads(row["json"])
    methods = diag.get("wsMethods") or []
    channels = {
        "hook": bool(diag.get("lastHookReadyAt")),
        "ws": bool(diag.get("lastWsOpenAt")),
        "wsSeq": any("RoomUserSeq" in str(m) for m in methods),
        "enterApi": bool(diag.get("lastEnterApiAt")),
        "endpoint": bool(diag.get("endpointOk")),
    }

    if not channels["hook"]:
        hint = "MAIN world 注入失败：检查扩展有没有报错、页面是否在 live.douyin.com 域下。"
    elif not channels["ws"]:
        hint = (
            "没抓到 /webcast/im/push/ 的 WebSocket —— 很可能这条长连接跑在 Web Worker 里。"
            "此时拿不到真·在线人数，只能靠 enter 接口 + DOM 的累计观看人数。"
        )
    elif not channels["wsSeq"]:
        hint = "WS 已抓到，但还没见到 WebcastRoomUserSeqMessage：多等 30 秒，或该直播间不推这个包。"
    else:
        hint = "在线人数通道正常，RoomUserSeqMessage 已经在推送。"
    return {"ts": row["ts"], "diag": diag, "channels": channels, "hint": hint}


@app.get("/api/rooms")
def list_rooms() -> dict[str, Any]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT r.room_id, r.web_rid, r.nickname, r.title, r.status, r.first_seen, r.last_seen,
                   (SELECT value FROM samples s WHERE s.room_id = r.room_id AND s.metric = 'online'
                     ORDER BY ts DESC LIMIT 1) AS online,
                   (SELECT value FROM samples s WHERE s.room_id = r.room_id AND s.metric = 'room_viewers'
                     ORDER BY ts DESC LIMIT 1) AS room_viewers,
                   (SELECT value FROM samples s WHERE s.room_id = r.room_id AND s.metric = 'watched'
                     ORDER BY ts DESC LIMIT 1) AS watched,
                   (SELECT value FROM samples s WHERE s.room_id = r.room_id AND s.metric = 'popularity'
                     ORDER BY ts DESC LIMIT 1) AS popularity,
                   (SELECT COUNT(*) FROM samples s WHERE s.room_id = r.room_id) AS sample_count
            FROM rooms r ORDER BY r.last_seen DESC
            """
        ).fetchall()
    rooms = []
    for row in rows:
        item = dict(row)
        plat = platform_of(item["room_id"])
        item["platform"] = plat
        item["platformLabel"] = PLATFORM_LABELS.get(plat, plat)
        rooms.append(item)
    return {"rooms": rooms, "metricLabels": METRIC_LABELS, "platformLabels": PLATFORM_LABELS}


def preferred_metric(conn: sqlite3.Connection, room_id: str) -> str:
    """这个房间"最该看"的指标（按 METRIC_ORDER）。

    接口的 metric 默认值不能写死成 online —— B站房间没有 online，
    不传参就会拿到空序列，看着像"没数据"。
    """
    present = {
        r["metric"]
        for r in conn.execute("SELECT DISTINCT metric FROM samples WHERE room_id = ?", (room_id,)).fetchall()
    }
    for m in METRIC_ORDER:
        if m in present:
            return m
    return next(iter(sorted(present)), "online")


@app.get("/api/rooms/{room_id}/series")
def room_series(
    room_id: str,
    metric: str | None = Query(default=None, description="不传则取该房间最该看的指标"),
    minutes: int = Query(default=60, ge=1, le=60 * 24 * 30),
    max_points: int = Query(default=600, ge=10, le=5000),
    source: str | None = Query(default=None, description="不传则按 ws > dom > api 自动挑"),
) -> dict[str, Any]:
    end = now_ms()
    start = end - minutes * 60 * 1000
    with connect() as conn:
        metric = metric or preferred_metric(conn, room_id)
        chosen = source or pick_source(conn, room_id, metric, start)
        if chosen:
            rows = conn.execute(
                "SELECT ts, value, text, source FROM samples WHERE room_id = ? AND metric = ?"
                " AND ts >= ? AND source = ? ORDER BY ts ASC",
                (room_id, metric, start, chosen),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT ts, value, text, source FROM samples WHERE room_id = ? AND metric = ?"
                " AND ts >= ? ORDER BY ts ASC",
                (room_id, metric, start),
            ).fetchall()

    if not rows:
        return {"roomId": room_id, "metric": metric, "source": chosen, "points": [], "total": 0, "bucketMs": 0}

    bucket_ms = max(1000, int(minutes * 60 * 1000 / max_points))
    buckets: dict[int, list[sqlite3.Row]] = {}
    for row in rows:
        buckets.setdefault(row["ts"] // bucket_ms, []).append(row)

    points = []
    for key in sorted(buckets):
        group = buckets[key]
        values = [r["value"] for r in group if r["value"] is not None]
        if not values:
            continue
        points.append(
            {
                "ts": group[-1]["ts"],
                "value": int(round(sum(values) / len(values))),
                "min": min(values),
                "max": max(values),
                "n": len(values),
                "text": group[-1]["text"],
                "source": group[-1]["source"],
            }
        )
    return {
        "roomId": room_id,
        "metric": metric,
        "source": chosen,
        "bucketMs": bucket_ms,
        "total": len(rows),
        "points": points,
    }


def collect_keys(obj: Any, prefix: str = "", depth: int = 3, out: set[str] | None = None) -> set[str]:
    """递归收集 JSON 里出现过的字段名（带路径），抖音改版时靠这个反推映射。"""
    if out is None:
        out = set()
    if depth < 0:
        return out
    if isinstance(obj, dict):
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, (dict, list)):
                collect_keys(value, path, depth - 1, out)
            else:
                out.add(path)
    elif isinstance(obj, list):
        for item in obj[:3]:
            collect_keys(item, prefix, depth - 1, out)
    return out


@app.get("/api/rooms/{room_id}/summary")
def room_summary(room_id: str, hours: int = Query(default=24, ge=1, le=24 * 30)) -> dict[str, Any]:
    start = now_ms() - hours * 3600 * 1000
    with connect() as conn:
        room = conn.execute("SELECT * FROM rooms WHERE room_id = ?", (room_id,)).fetchone()
        # 指标不能写死：抖音是 online/watched/likes，B站是 room_viewers/watched/popularity/…
        # 面板的指标按钮就是按这里的 key 动态生成的，写死会导致整个平台的指标看不见。
        rows = conn.execute(
            "SELECT DISTINCT metric FROM samples WHERE room_id = ?", (room_id,)
        ).fetchall()
        present = {r["metric"] for r in rows}
        ordered = [m for m in METRIC_ORDER if m in present]              # 已知指标按偏好顺序
        ordered += sorted(m for m in present if m not in METRIC_ORDER)   # 未知指标排后面
        stats: dict[str, Any] = {}
        for metric in ordered:
            chosen = pick_source(conn, room_id, metric, start)
            if chosen:
                row = conn.execute(
                    "SELECT COUNT(*) AS n, MAX(value) AS peak, MIN(value) AS low, AVG(value) AS avg,"
                    " MAX(ts) AS last_ts FROM samples WHERE room_id = ? AND metric = ? AND ts >= ?"
                    " AND source = ?",
                    (room_id, metric, start, chosen),
                ).fetchone()
                last = conn.execute(
                    "SELECT value, text, source, ts FROM samples WHERE room_id = ? AND metric = ?"
                    " AND source = ? ORDER BY ts DESC LIMIT 1",
                    (room_id, metric, chosen),
                ).fetchone()
            else:
                row = None
                last = None
            stats[metric] = {
                "label": METRIC_LABELS.get(metric, metric),
                "source": chosen,
                "samples": row["n"] if row else 0,
                "peak": row["peak"] if row else None,
                "low": row["low"] if row else None,
                "avg": round(row["avg"], 1) if row and row["avg"] is not None else None,
                "current": last["value"] if last else None,
                "currentText": last["text"] if last else None,
                "currentSource": last["source"] if last else None,
                "currentAt": last["ts"] if last else None,
            }
        events = conn.execute(
            "SELECT ts, kind, detail FROM events WHERE room_id = ? ORDER BY ts DESC LIMIT 50", (room_id,)
        ).fetchall()
        keys = set()
        for row in conn.execute(
            "SELECT raw FROM samples WHERE room_id = ? AND raw IS NOT NULL ORDER BY ts DESC LIMIT 40",
            (room_id,),
        ).fetchall():
            try:
                parsed = json.loads(row["raw"])
            except (TypeError, ValueError):
                continue
            if isinstance(parsed, dict):
                collect_keys(parsed, out=keys)
    return {
        "room": dict(room) if room else None,
        "stats": stats,
        "events": [dict(e) for e in events],
        "observedRawKeys": sorted(keys),
    }


@app.get("/api/rooms/{room_id}/export.csv")
def export_csv(room_id: str, metric: str | None = Query(default=None)) -> Any:
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["ts", "iso_time", "room_id", "metric", "value", "text", "source"])
    with connect() as conn:
        metric = metric or preferred_metric(conn, room_id)
        rows = conn.execute(
            "SELECT ts, room_id, metric, value, text, source FROM samples WHERE room_id = ? AND metric = ?"
            " ORDER BY ts ASC",
            (room_id, metric),
        ).fetchall()
    for row in rows:
        writer.writerow(
            [
                row["ts"],
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(row["ts"] / 1000)),
                row["room_id"],
                row["metric"],
                row["value"],
                row["text"],
                row["source"],
            ]
        )
    return JSONResponse(
        content={"csv": buf.getvalue()},
        headers={"content-disposition": f'attachment; filename="{room_id}_{metric}.csv"'},
    )


@app.get("/")
def dashboard() -> Any:
    index = STATIC_DIR / "dashboard.html"
    if not index.exists():
        return JSONResponse({"error": "dashboard.html 缺失"}, status_code=500)
    return FileResponse(index)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
