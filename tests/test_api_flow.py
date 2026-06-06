import asyncio
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from algorithm import SLOTS  # noqa: E402
from models import RoomCreate  # noqa: E402
from store import MemoryStore  # noqa: E402


def slots(*ranges):
    result = [0] * SLOTS
    for start, end in ranges:
        for idx in range(start, end):
            result[idx] = 1
    return result


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = messages
        self.sent = []
        self.accepted = False
        self.closed = None

    async def accept(self):
        self.accepted = True

    async def send_json(self, message):
        self.sent.append(message)

    async def close(self, code=1000, reason=""):
        self.closed = {"code": code, "reason": reason}

    def iter_json(self):
        async def gen():
            for message in self.messages:
                yield message
                await asyncio.sleep(0)

        return gen()


class ApiFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = MemoryStore()

        async def fake_get_redis():
            return self.store

        async def fake_close_redis():
            await self.store.aclose()

        self._old_get_redis = main.get_redis
        self._old_close_redis = main.close_redis
        self._old_manager = main.manager
        main.get_redis = fake_get_redis
        main.close_redis = fake_close_redis
        main.manager = main.ConnectionManager()

    async def asyncTearDown(self):
        main.get_redis = self._old_get_redis
        main.close_redis = self._old_close_redis
        main.manager = self._old_manager

    async def create_room(self, **overrides):
        payload = {
            "max_participants": 5,
            "meeting_duration_minutes": 60,
            "timezone": "Asia/Seoul",
            **overrides,
        }
        result = await main.create_room(RoomCreate(**payload))
        return result["room_id"]

    async def start_listener(self):
        listener = asyncio.create_task(main._pubsub_listener())
        for _ in range(20):
            if self.store._subs:
                return listener
            await asyncio.sleep(0)
        return listener

    async def test_create_room_returns_state_with_submission_and_finalized_fields(self):
        room_id = await self.create_room(meeting_duration_minutes=90)

        data = await main.get_room(room_id)

        self.assertEqual(data["meta"]["meeting_duration_minutes"], "90")
        self.assertEqual(data["submission_status"]["total_count"], 0)
        self.assertIsNone(data["finalized_slot"])
        self.assertEqual(data["recommended_slots"], [])

    async def test_websocket_updates_recommendations_reasons_and_finalized_slot(self):
        room_id = await self.create_room(meeting_duration_minutes=60)
        target = (date.today() + timedelta(days=1)).isoformat()
        await self.store.hset(f"room:{room_id}:names", mapping={"u2": "Lee"})

        ws = FakeWebSocket([
            {"type": "update_slots", "date": target, "slots": slots((20, 24))},
            {"type": "finalize_slot", "date": target, "start_slot": 20, "end_slot": 24},
            {"type": "clear_finalized_slot"},
        ])
        listener = await self.start_listener()
        try:
            await main.ws_endpoint(ws, room_id, "u1", "Kim")
            await asyncio.sleep(0)
        finally:
            listener.cancel()
            try:
                await listener
            except asyncio.CancelledError:
                pass

        self.assertTrue(ws.accepted)
        init = ws.sent[0]
        self.assertEqual(init["type"], "init")
        self.assertEqual(init["submission_status"]["pending_names"], ["Kim", "Lee"])

        state_update = next(msg for msg in ws.sent if msg.get("type") == "state_update")
        self.assertEqual(state_update["submission_status"]["submitted_names"], ["Kim"])
        self.assertEqual(state_update["submission_status"]["pending_names"], ["Lee"])
        self.assertEqual(len(state_update["recommended_slots"]), 1)
        rec = state_update["recommended_slots"][0]
        self.assertEqual(rec["available_names"], ["Kim"])
        self.assertEqual(rec["unavailable_names"], ["Lee"])
        self.assertEqual(rec["pending_names"], ["Lee"])

        finalized_updates = [msg for msg in ws.sent if msg.get("type") == "finalized_slot_update"]
        self.assertEqual(len(finalized_updates), 2)
        finalized = finalized_updates[0]["finalized_slot"]
        self.assertEqual(finalized["date"], target)
        self.assertEqual(finalized["available_names"], ["Kim"])
        self.assertEqual(finalized["unavailable_names"], ["Lee"])
        self.assertEqual(finalized["finalized_by_name"], "Kim")
        self.assertIsNone(finalized_updates[1]["finalized_slot"])


if __name__ == "__main__":
    unittest.main()
