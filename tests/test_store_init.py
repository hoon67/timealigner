import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import redis_client  # noqa: E402


class StoreInitializationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._old_redis_url = os.environ.get("REDIS_URL")
        self._old_db_path = os.environ.get("DB_PATH")
        self._old_require_redis = os.environ.get("REQUIRE_REDIS")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["REDIS_URL"] = "redis://127.0.0.1:6390"
        os.environ["DB_PATH"] = str(Path(self._tmp.name) / "timealigner-test.db")
        os.environ.pop("REQUIRE_REDIS", None)
        await redis_client.close_redis()

    async def asyncTearDown(self):
        await redis_client.close_redis()
        if self._old_redis_url is None:
            os.environ.pop("REDIS_URL", None)
        else:
            os.environ["REDIS_URL"] = self._old_redis_url
        if self._old_db_path is None:
            os.environ.pop("DB_PATH", None)
        else:
            os.environ["DB_PATH"] = self._old_db_path
        if self._old_require_redis is None:
            os.environ.pop("REQUIRE_REDIS", None)
        else:
            os.environ["REQUIRE_REDIS"] = self._old_require_redis
        self._tmp.cleanup()

    async def test_concurrent_get_redis_returns_single_store_instance(self):
        stores = await asyncio.gather(*(redis_client.get_redis() for _ in range(8)))

        first = stores[0]
        self.assertTrue(all(store is first for store in stores))

    async def test_require_redis_rejects_fallback_store(self):
        os.environ["REQUIRE_REDIS"] = "true"

        with self.assertRaises(RuntimeError):
            await redis_client.get_redis()


if __name__ == "__main__":
    unittest.main()
