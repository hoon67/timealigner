import asyncio
import json
import re
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from algorithm import SLOTS, find_best_day_time
from models import RoomCreate
from redis_client import close_redis, get_redis

ROOM_TTL = 60 * 60 * 24 * 90  # 90 days
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ConnectionManager:
    def __init__(self) -> None:
        self.rooms: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, room_id: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self.rooms.setdefault(room_id, set()).add(ws)

    async def disconnect(self, room_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self.rooms.get(room_id, set()).discard(ws)

    async def broadcast_local(self, room_id: str, message: dict) -> None:
        conns = set(self.rooms.get(room_id, set()))
        dead: set[WebSocket] = set()
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        if dead:
            async with self._lock:
                self.rooms.get(room_id, set()).difference_update(dead)


manager = ConnectionManager()
_pubsub_task: asyncio.Task | None = None


async def _pubsub_listener() -> None:
    r = await get_redis()
    sub = r.pubsub()
    await sub.psubscribe("room:*:updates")
    try:
        async for msg in sub.listen():
            if msg["type"] != "pmessage":
                continue
            try:
                room_id = msg["channel"].split(":")[1]
                await manager.broadcast_local(room_id, json.loads(msg["data"]))
            except Exception:
                pass
    except asyncio.CancelledError:
        await sub.punsubscribe()
        await sub.aclose()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pubsub_task
    _pubsub_task = asyncio.create_task(_pubsub_listener())
    yield
    if _pubsub_task:
        _pubsub_task.cancel()
        try:
            await _pubsub_task
        except asyncio.CancelledError:
            pass
    await close_redis()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


async def _load_participants(r, room_id: str) -> dict[str, dict[str, list[int]]]:
    raw = await r.hgetall(f"room:{room_id}:participants")
    return {k: json.loads(v) for k, v in raw.items()}


async def _build_state(r, room_id: str) -> dict:
    participants = await _load_participants(r, room_id)
    names = await r.hgetall(f"room:{room_id}:names")
    return {
        "participants": participants,
        "names": names,
        "recommended_slots": find_best_day_time(participants),
    }


async def _remove_participant(r, room_id: str, user_id: str) -> dict:
    pipe = r.pipeline()
    pipe.hdel(f"room:{room_id}:participants", user_id)
    pipe.hdel(f"room:{room_id}:names", user_id)
    await pipe.execute()
    return await _build_state(r, room_id)


@app.post("/api/rooms")
async def create_room(data: RoomCreate):
    r = await get_redis()
    room_id = secrets.token_urlsafe(9)
    meta = {
        "timezone": data.timezone,
        "max_participants": str(data.max_participants),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    pipe = r.pipeline()
    pipe.hset(f"room:{room_id}:meta", mapping=meta)
    pipe.expire(f"room:{room_id}:meta", ROOM_TTL)
    await pipe.execute()
    return {"room_id": room_id, "meta": meta}


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    r = await get_redis()
    meta = await r.hgetall(f"room:{room_id}:meta")
    if not meta:
        raise HTTPException(404, "Room not found")
    state = await _build_state(r, room_id)
    return {"room_id": room_id, "meta": meta, **state}


@app.delete("/api/rooms/{room_id}/participants/{user_id}")
async def leave_room(room_id: str, user_id: str):
    """Reliable HTTP-based leave — removes participant data and notifies others."""
    r = await get_redis()
    meta = await r.hgetall(f"room:{room_id}:meta")
    if not meta:
        raise HTTPException(404, "Room not found")
    state = await _remove_participant(r, room_id, user_id)
    await r.publish(
        f"room:{room_id}:updates",
        json.dumps({"type": "participant_left", "user_id": user_id, **state}),
    )
    return {"ok": True}


@app.websocket("/ws/{room_id}/{user_id}")
async def ws_endpoint(ws: WebSocket, room_id: str, user_id: str, name: str = ""):
    r = await get_redis()
    meta = await r.hgetall(f"room:{room_id}:meta")
    if not meta:
        await ws.close(code=4004, reason="Room not found")
        return

    max_p = int(meta.get("max_participants", 50))
    count = await r.hlen(f"room:{room_id}:names")
    exists = await r.hexists(f"room:{room_id}:names", user_id)
    if not exists and count >= max_p:
        await ws.close(code=4003, reason="Room full")
        return

    display_name = name.strip() or user_id[:8]
    pipe = r.pipeline()
    pipe.hset(f"room:{room_id}:names", user_id, display_name)
    pipe.expire(f"room:{room_id}:names", ROOM_TTL)
    await pipe.execute()

    await manager.connect(room_id, ws)

    try:
        state = await _build_state(r, room_id)
        await ws.send_json({"type": "init", "meta": meta, **state})

        async for msg in ws.iter_json():
            msg_type = msg.get("type")

            if msg_type == "update_slots":
                date_str = msg.get("date", "")
                slots = msg.get("slots", [])

                if not _ISO_RE.match(date_str):
                    await ws.send_json({"type": "error", "message": "Invalid date (expected YYYY-MM-DD)"})
                    continue
                if len(slots) != SLOTS or not all(v in (0, 1) for v in slots):
                    await ws.send_json({"type": "error", "message": f"Invalid slots: {SLOTS}-element binary array"})
                    continue

                existing_raw = await r.hgetall(f"room:{room_id}:participants")
                user_data = json.loads(existing_raw.get(user_id, "{}"))
                user_data[date_str] = slots

                pipe = r.pipeline()
                pipe.hset(f"room:{room_id}:participants", user_id, json.dumps(user_data))
                pipe.expire(f"room:{room_id}:participants", ROOM_TTL)
                await pipe.execute()

                state = await _build_state(r, room_id)
                await r.publish(
                    f"room:{room_id}:updates",
                    json.dumps({"type": "state_update", "updated_by": user_id, **state}),
                )

            elif msg_type == "leave":
                # Soft leave: keep slot data, drop name
                await r.hdel(f"room:{room_id}:names", user_id)
                state = await _build_state(r, room_id)
                await r.publish(
                    f"room:{room_id}:updates",
                    json.dumps({"type": "participant_left", "user_id": user_id, **state}),
                )
                break

    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(room_id, ws)


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
