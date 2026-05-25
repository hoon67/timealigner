from datetime import date as _date

SLOTS = 48
_WEEKDAYS_KO = ["월", "화", "수", "목", "금", "토", "일"]


def slot_to_time(slot: int) -> str:
    h = (slot * 30) // 60
    m = (slot * 30) % 60
    return f"{h:02d}:{m:02d}"


def date_label(iso: str) -> str:
    try:
        d = _date.fromisoformat(iso)
        return f"{d.month}/{d.day}({_WEEKDAYS_KO[d.weekday()]})"
    except ValueError:
        return iso


_TOP_PER_DATE = 3


def find_best_day_time(
    participants_all: dict[str, dict[str, list[int]]],
) -> list[dict]:
    """Return up to _TOP_PER_DATE recommendations per upcoming date, date ASC.

    Within each date: full attendance first, then by score (count²×duration).
    Past dates are excluded. Each entry carries date_rank (1-based within date)
    and rank (global sequential).
    """
    n = len(participants_all)
    if n == 0:
        return []

    min_required = n // 2 + 1
    today = _date.today()

    all_dates = sorted(
        iso for days_data in participants_all.values() for iso in days_data
        if _date.fromisoformat(iso) >= today
    )
    # deduplicate while preserving order
    seen: set[str] = set()
    all_dates = [d for d in all_dates if not (d in seen or seen.add(d))]  # type: ignore[func-returns-value]

    results: list[dict] = []
    global_rank = 0

    for iso in all_dates:
        scores = [0] * SLOTS
        for uid, days_data in participants_all.items():
            slots = days_data.get(iso)
            if not slots or len(slots) != SLOTS:
                continue
            for t in range(SLOTS):
                scores[t] += slots[t]

        date_entries: list[dict] = []
        t = 0
        while t < SLOTS:
            if scores[t] < min_required:
                t += 1
                continue
            start = t
            while t < SLOTS and scores[t] >= min_required:
                t += 1
            end = t

            guaranteed = min(scores[start:end])
            duration = end - start
            score = guaranteed ** 3 * duration
            date_entries.append({
                "date": iso,
                "start_slot": start,
                "end_slot": end,
                "start_time": slot_to_time(start),
                "end_time": slot_to_time(end),
                "time_string": f"{date_label(iso)} {slot_to_time(start)}~{slot_to_time(end)}",
                "attendance_count": guaranteed,
                "attendance_ratio": round(guaranteed / n, 2),
                "duration_slots": duration,
                "score": score,
            })

        # Full attendance first, then partial; both sorted by score DESC
        full    = sorted([e for e in date_entries if e["attendance_count"] == n], key=lambda x: -x["score"])
        partial = sorted([e for e in date_entries if e["attendance_count"] <  n], key=lambda x: -x["score"])
        top = (full + partial)[:_TOP_PER_DATE]

        for date_rank, entry in enumerate(top, 1):
            global_rank += 1
            entry["date_rank"] = date_rank
            entry["rank"] = global_rank
            results.append(entry)

    return results
