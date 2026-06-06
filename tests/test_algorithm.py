import sys
import unittest
from datetime import date, timedelta
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from algorithm import SLOTS, find_best_day_time, slot_to_time  # noqa: E402


def slots(*ranges):
    result = [0] * SLOTS
    for start, end in ranges:
        for idx in range(start, end):
            result[idx] = 1
    return result


class RecommendationTests(unittest.TestCase):
    def test_slot_to_time_formats_half_hour_slots(self):
        self.assertEqual(slot_to_time(0), "00:00")
        self.assertEqual(slot_to_time(1), "00:30")
        self.assertEqual(slot_to_time(47), "23:30")
        self.assertEqual(slot_to_time(48), "24:00")

    def test_empty_participants_have_no_recommendations(self):
        self.assertEqual(find_best_day_time({}), [])

    def test_excludes_past_dates(self):
        past = (date.today() - timedelta(days=1)).isoformat()
        future = (date.today() + timedelta(days=1)).isoformat()
        participants = {
            "a": {past: slots((8, 10)), future: slots((12, 14))},
            "b": {past: slots((8, 10)), future: slots((12, 14))},
        }

        recs = find_best_day_time(participants)

        self.assertEqual([r["date"] for r in recs], [future])
        self.assertEqual(recs[0]["start_slot"], 12)
        self.assertEqual(recs[0]["end_slot"], 14)

    def test_requires_majority_overlap(self):
        target = (date.today() + timedelta(days=1)).isoformat()
        participants = {
            "a": {target: slots((8, 10))},
            "b": {target: slots((8, 10))},
            "c": {target: slots((20, 22))},
        }

        recs = find_best_day_time(participants)

        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["attendance_count"], 2)
        self.assertEqual(recs[0]["attendance_ratio"], 0.67)
        self.assertEqual(recs[0]["start_slot"], 8)
        self.assertEqual(recs[0]["end_slot"], 10)

    def test_full_attendance_is_prioritized_over_longer_partial_overlap(self):
        target = (date.today() + timedelta(days=1)).isoformat()
        participants = {
            "a": {target: slots((8, 9), (20, 30))},
            "b": {target: slots((8, 9), (20, 30))},
            "c": {target: slots((8, 9))},
        }

        recs = find_best_day_time(participants)

        self.assertGreaterEqual(len(recs), 2)
        self.assertEqual(recs[0]["attendance_count"], 3)
        self.assertEqual(recs[0]["start_slot"], 8)
        self.assertEqual(recs[0]["date_rank"], 1)
        self.assertEqual(recs[1]["attendance_count"], 2)
        self.assertEqual(recs[1]["start_slot"], 20)
        self.assertEqual(recs[1]["date_rank"], 2)

    def test_limits_recommendations_to_three_per_date(self):
        target = (date.today() + timedelta(days=1)).isoformat()
        participants = {
            "a": {target: slots((2, 3), (6, 7), (10, 11), (14, 15))},
            "b": {target: slots((2, 3), (6, 7), (10, 11), (14, 15))},
        }

        recs = find_best_day_time(participants)

        self.assertEqual(len(recs), 3)
        self.assertEqual([r["date_rank"] for r in recs], [1, 2, 3])

    def test_filters_recommendations_shorter_than_min_duration(self):
        target = (date.today() + timedelta(days=1)).isoformat()
        participants = {
            "a": {target: slots((8, 10), (20, 24))},
            "b": {target: slots((8, 10), (20, 24))},
        }

        recs = find_best_day_time(participants, min_duration_slots=3)

        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["start_slot"], 20)
        self.assertEqual(recs[0]["end_slot"], 24)
        self.assertEqual(recs[0]["meeting_duration_slots"], 3)
        self.assertEqual(recs[0]["meeting_duration_minutes"], 90)


if __name__ == "__main__":
    unittest.main()
