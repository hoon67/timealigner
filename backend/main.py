import asyncio
import json
import re
import secrets
from contextlib import asynccontextmanager
from datetime import date as _date, datetime, timezone
from pathlib import Path

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from algorithm import SLOT_MINUTES, SLOTS, date_label, find_best_day_time, slot_to_time
from models import RoomCreate
from redis_client import close_redis, get_redis

ROOM_TTL = 60 * 60 * 24 * 90  # 90 days
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_MEETING_DURATION_MINUTES = 60


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


def _meeting_duration_slots(meta: dict) -> int:
    try:
        minutes = int(meta.get("meeting_duration_minutes", DEFAULT_MEETING_DURATION_MINUTES))
    except (TypeError, ValueError):
        minutes = DEFAULT_MEETING_DURATION_MINUTES
    return max(1, min(SLOTS, (minutes + SLOT_MINUTES - 1) // SLOT_MINUTES))


def _has_submission(days_data: dict[str, list[int]] | None) -> bool:
    if not days_data:
        return False
    return any(isinstance(slots, list) and len(slots) == SLOTS for slots in days_data.values())


def _person(user_id: str, names: dict[str, str]) -> dict:
    return {"user_id": user_id, "name": names.get(user_id) or user_id[:8]}


def _is_available_for_range(
    days_data: dict[str, list[int]] | None,
    date_str: str,
    start_slot: int,
    end_slot: int,
) -> bool:
    slots = (days_data or {}).get(date_str)
    return bool(slots and len(slots) == SLOTS and all(slots[t] == 1 for t in range(start_slot, end_slot)))


def _slot_people(
    participants: dict[str, dict[str, list[int]]],
    names: dict[str, str],
    date_str: str,
    start_slot: int,
    end_slot: int,
) -> dict:
    available = []
    unavailable = []
    pending = []

    for user_id in sorted(names, key=lambda uid: names.get(uid, "").casefold()):
        person = _person(user_id, names)
        submitted = _has_submission(participants.get(user_id))
        if _is_available_for_range(participants.get(user_id), date_str, start_slot, end_slot):
            available.append(person)
        else:
            unavailable.append(person)
            if not submitted:
                pending.append(person)

    return {
        "available": available,
        "unavailable": unavailable,
        "pending": pending,
        "available_names": [p["name"] for p in available],
        "unavailable_names": [p["name"] for p in unavailable],
        "pending_names": [p["name"] for p in pending],
    }


def _submission_status(participants: dict[str, dict[str, list[int]]], names: dict[str, str]) -> dict:
    submitted = []
    pending = []

    for user_id in sorted(names, key=lambda uid: names.get(uid, "").casefold()):
        person = _person(user_id, names)
        if _has_submission(participants.get(user_id)):
            submitted.append(person)
        else:
            pending.append(person)

    return {
        "total_count": len(names),
        "submitted_count": len(submitted),
        "pending_count": len(pending),
        "submitted": submitted,
        "pending": pending,
        "submitted_names": [p["name"] for p in submitted],
        "pending_names": [p["name"] for p in pending],
    }


def _enrich_recommendations(
    recs: list[dict],
    participants: dict[str, dict[str, list[int]]],
    names: dict[str, str],
) -> list[dict]:
    enriched = []
    for rec in recs:
        item = dict(rec)
        item.update(_slot_people(participants, names, item["date"], item["start_slot"], item["end_slot"]))
        enriched.append(item)
    return enriched


def _finalized_slot(meta: dict, participants: dict[str, dict[str, list[int]]], names: dict[str, str]) -> dict | None:
    raw = meta.get("finalized_slot")
    if not raw:
        return None
    try:
        slot = json.loads(raw)
        date_str = slot["date"]
        start_slot = int(slot["start_slot"])
        end_slot = int(slot["end_slot"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None

    people = _slot_people(participants, names, date_str, start_slot, end_slot)
    duration_slots = end_slot - start_slot
    return {
        **slot,
        "date": date_str,
        "start_slot": start_slot,
        "end_slot": end_slot,
        "start_time": slot_to_time(start_slot),
        "end_time": slot_to_time(end_slot),
        "time_string": f"{date_label(date_str)} {slot_to_time(start_slot)}~{slot_to_time(end_slot)}",
        "duration_slots": duration_slots,
        "duration_minutes": duration_slots * SLOT_MINUTES,
        "attendance_count": len(people["available"]),
        "attendance_ratio": round(len(people["available"]) / len(names), 2) if names else 0,
        **people,
    }


def _parse_slot_range(date_str: str, start_slot, end_slot) -> tuple[str, int, int]:
    if not _ISO_RE.match(date_str):
        raise ValueError("Invalid date (expected YYYY-MM-DD)")
    try:
        _date.fromisoformat(date_str)
        start = int(start_slot)
        end = int(end_slot)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid slot range") from exc
    if start < 0 or end > SLOTS or start >= end:
        raise ValueError(f"Invalid slot range (expected 0 <= start < end <= {SLOTS})")
    return date_str, start, end


async def _build_state(r, room_id: str, meta: dict | None = None) -> dict:
    participants = await _load_participants(r, room_id)
    names = await r.hgetall(f"room:{room_id}:names")
    if meta is None:
        meta = await r.hgetall(f"room:{room_id}:meta")
    recs = find_best_day_time(participants, _meeting_duration_slots(meta))
    return {
        "meta": meta,
        "participants": participants,
        "names": names,
        "recommended_slots": _enrich_recommendations(recs, participants, names),
        "submission_status": _submission_status(participants, names),
        "finalized_slot": _finalized_slot(meta, participants, names),
    }


async def _remove_participant(r, room_id: str, user_id: str, meta: dict | None = None) -> dict:
    pipe = r.pipeline()
    pipe.hdel(f"room:{room_id}:participants", user_id)
    pipe.hdel(f"room:{room_id}:names", user_id)
    await pipe.execute()
    return await _build_state(r, room_id, meta)


@app.post("/api/rooms")
async def create_room(data: RoomCreate):
    r = await get_redis()
    room_id = secrets.token_urlsafe(9)
    meta = {
        "timezone": data.timezone,
        "max_participants": str(data.max_participants),
        "meeting_duration_minutes": str(data.meeting_duration_minutes),
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
    state = await _build_state(r, room_id, meta)
    return {"room_id": room_id, "meta": meta, **state}


@app.delete("/api/rooms/{room_id}/participants/{user_id}")
async def leave_room(room_id: str, user_id: str):
    """Reliable HTTP-based leave — removes participant data and notifies others."""
    r = await get_redis()
    meta = await r.hgetall(f"room:{room_id}:meta")
    if not meta:
        raise HTTPException(404, "Room not found")
    state = await _remove_participant(r, room_id, user_id, meta)
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
        state = await _build_state(r, room_id, meta)
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

            elif msg_type == "finalize_slot":
                try:
                    date_str, start_slot, end_slot = _parse_slot_range(
                        msg.get("date", ""),
                        msg.get("start_slot"),
                        msg.get("end_slot"),
                    )
                except ValueError as exc:
                    await ws.send_json({"type": "error", "message": str(exc)})
                    continue

                finalized = {
                    "date": date_str,
                    "start_slot": start_slot,
                    "end_slot": end_slot,
                    "finalized_by": user_id,
                    "finalized_by_name": display_name,
                    "finalized_at": datetime.now(timezone.utc).isoformat(),
                }
                await r.hset(f"room:{room_id}:meta", "finalized_slot", json.dumps(finalized))
                await r.expire(f"room:{room_id}:meta", ROOM_TTL)

                state = await _build_state(r, room_id)
                await r.publish(
                    f"room:{room_id}:updates",
                    json.dumps({"type": "finalized_slot_update", "updated_by": user_id, **state}),
                )

            elif msg_type == "clear_finalized_slot":
                await r.hdel(f"room:{room_id}:meta", "finalized_slot")
                await r.expire(f"room:{room_id}:meta", ROOM_TTL)

                state = await _build_state(r, room_id)
                await r.publish(
                    f"room:{room_id}:updates",
                    json.dumps({"type": "finalized_slot_update", "updated_by": user_id, **state}),
                )

    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(room_id, ws)


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
