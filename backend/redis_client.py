import asyncio
import os
from store import MemoryStore, SQLiteStore

_store = None
_store_lock = asyncio.Lock()


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


async def get_redis():
    global _store
    if _store is not None:
        return _store

    async with _store_lock:
        if _store is not None:
            return _store

        # 1) Redis
        url = os.getenv("REDIS_URL", "redis://localhost:6379")
        try:
            import redis.asyncio as aioredis
            client = aioredis.from_url(url, decode_responses=True, socket_connect_timeout=2)
            await client.ping()
            _store = client
            print(f"[store] Redis: {url}")
            return _store
        except Exception as exc:
            if _env_truthy("REQUIRE_REDIS"):
                raise RuntimeError(f"Redis is required but unavailable: {url}") from exc

        # 2) SQLite (persistent)
        try:
            import aiosqlite  # noqa: F401
            db_path = os.getenv("DB_PATH", "timealigner.db")
            s = SQLiteStore(db_path)
            await s._conn()
            _store = s
            print(f"[store] SQLite: {db_path} (single-process pub/sub; use Redis for multi-instance)")
            return _store
        except Exception:
            pass

        # 3) In-memory fallback
        _store = MemoryStore()
        print("[store] In-memory (data lost on restart)")
        return _store


async def close_redis() -> None:
    global _store
    async with _store_lock:
        if _store:
            await _store.aclose()
            _store = None
