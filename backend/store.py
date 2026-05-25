"""Storage backends: SQLite (persistent) and Memory (fallback)."""
import asyncio
import time
from collections import defaultdict


# ── Shared pub/sub mixin ────────────────────────────────────────────
class _PubSubMixin:
    """In-process pub/sub for single-server use."""

    def _init_subs(self):
        self._subs: list[asyncio.Queue] = []

    async def publish(self, channel: str, message: str) -> None:
        for q in list(self._subs):
            await q.put((channel, message))

    def pubsub(self):
        return _PubSub(self)


class _PubSub:
    def __init__(self, store) -> None:
        self._s = store
        self._q: asyncio.Queue = asyncio.Queue()

    async def psubscribe(self, _pattern: str) -> None:
        self._s._subs.append(self._q)

    async def punsubscribe(self) -> None:
        try:
            self._s._subs.remove(self._q)
        except ValueError:
            pass

    async def aclose(self) -> None:
        await self.punsubscribe()

    async def listen(self):
        try:
            while True:
                channel, data = await self._q.get()
                yield {"type": "pmessage", "channel": channel, "data": data}
        except asyncio.CancelledError:
            pass


# ── SQLite store ────────────────────────────────────────────────────
class SQLiteStore(_PubSubMixin):
    def __init__(self, db_path: str = "timealigner.db") -> None:
        self._path = db_path
        self._db = None
        self._init_subs()

    async def _conn(self):
        if self._db is None:
            import aiosqlite
            self._db = await aiosqlite.connect(self._path)
            await self._db.executescript("""
                CREATE TABLE IF NOT EXISTS kvhash (
                    bucket TEXT NOT NULL,
                    field  TEXT NOT NULL,
                    value  TEXT NOT NULL,
                    PRIMARY KEY (bucket, field)
                );
                CREATE TABLE IF NOT EXISTS expiry (
                    bucket     TEXT PRIMARY KEY,
                    expires_at REAL NOT NULL
                );
            """)
            await self._db.commit()
        return self._db

    async def _expired(self, db, name: str) -> bool:
        async with db.execute(
            "SELECT expires_at FROM expiry WHERE bucket=?", (name,)
        ) as cur:
            row = await cur.fetchone()
        if row and time.time() > row[0]:
            await db.execute("DELETE FROM kvhash WHERE bucket=?", (name,))
            await db.execute("DELETE FROM expiry WHERE bucket=?", (name,))
            await db.commit()
            return True
        return False

    async def hset(self, name, key=None, value=None, mapping=None):
        db = await self._conn()
        await self._expired(db, name)
        if mapping:
            await db.executemany(
                "INSERT OR REPLACE INTO kvhash VALUES (?,?,?)",
                [(name, k, v) for k, v in mapping.items()],
            )
        elif key is not None:
            await db.execute("INSERT OR REPLACE INTO kvhash VALUES (?,?,?)", (name, key, value))
        await db.commit()

    async def hgetall(self, name) -> dict:
        db = await self._conn()
        if await self._expired(db, name):
            return {}
        async with db.execute("SELECT field, value FROM kvhash WHERE bucket=?", (name,)) as cur:
            rows = await cur.fetchall()
        return {r[0]: r[1] for r in rows}

    async def hexists(self, name, key) -> bool:
        db = await self._conn()
        if await self._expired(db, name):
            return False
        async with db.execute(
            "SELECT 1 FROM kvhash WHERE bucket=? AND field=?", (name, key)
        ) as cur:
            return await cur.fetchone() is not None

    async def hdel(self, name, *keys):
        db = await self._conn()
        if await self._expired(db, name):
            return
        ph = ",".join("?" * len(keys))
        await db.execute(f"DELETE FROM kvhash WHERE bucket=? AND field IN ({ph})", (name, *keys))
        await db.commit()

    async def hlen(self, name) -> int:
        db = await self._conn()
        if await self._expired(db, name):
            return 0
        async with db.execute("SELECT COUNT(*) FROM kvhash WHERE bucket=?", (name,)) as cur:
            row = await cur.fetchone()
        return row[0] if row else 0

    async def expire(self, name, seconds) -> None:
        db = await self._conn()
        await db.execute(
            "INSERT OR REPLACE INTO expiry VALUES (?,?)", (name, time.time() + seconds)
        )
        await db.commit()

    def pipeline(self):
        return _Pipeline(self)

    async def ping(self) -> bool:
        return True

    async def aclose(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None


# ── In-memory store ─────────────────────────────────────────────────
class MemoryStore(_PubSubMixin):
    def __init__(self) -> None:
        self._data: dict[str, dict] = defaultdict(dict)
        self._ttl: dict[str, float] = {}
        self._init_subs()

    def _live(self, key: str) -> bool:
        exp = self._ttl.get(key)
        if exp and time.monotonic() > exp:
            self._data.pop(key, None)
            self._ttl.pop(key, None)
            return False
        return True

    async def hset(self, name, key=None, value=None, mapping=None):
        if not self._live(name):
            pass
        if mapping:
            self._data[name].update(mapping)
        elif key is not None:
            self._data[name][key] = value

    async def hgetall(self, name) -> dict:
        return dict(self._data[name]) if self._live(name) else {}

    async def hexists(self, name, key) -> bool:
        return self._live(name) and key in self._data[name]

    async def hdel(self, name, *keys):
        if self._live(name):
            for k in keys:
                self._data[name].pop(k, None)

    async def hlen(self, name) -> int:
        return len(self._data[name]) if self._live(name) else 0

    async def expire(self, name, seconds) -> None:
        self._ttl[name] = time.monotonic() + seconds

    def pipeline(self):
        return _Pipeline(self)

    async def ping(self) -> bool:
        return True

    async def aclose(self) -> None:
        pass


# ── Pipeline ─────────────────────────────────────────────────────────
class _Pipeline:
    def __init__(self, store) -> None:
        self._s = store
        self._ops: list = []

    def hset(self, name, key=None, value=None, mapping=None):
        self._ops.append(("hset", name, key, value, mapping))
        return self

    def hdel(self, name, *keys):
        self._ops.append(("hdel", name, *keys))
        return self

    def expire(self, name, seconds):
        self._ops.append(("expire", name, seconds))
        return self

    async def execute(self):
        for op in self._ops:
            if op[0] == "hset":
                await self._s.hset(op[1], key=op[2], value=op[3], mapping=op[4])
            elif op[0] == "hdel":
                await self._s.hdel(op[1], *op[2:])
            elif op[0] == "expire":
                await self._s.expire(op[1], op[2])
