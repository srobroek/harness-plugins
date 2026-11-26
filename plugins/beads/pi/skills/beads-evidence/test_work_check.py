import json
import unittest

from work_check import check, timestamp


class WorkCheckTests(unittest.TestCase):
    def setUp(self):
        self.issue = {"id": "proj-1", "acceptance_criteria": "one\ntwo", "comments": []}
        self.start = timestamp("2026-01-01T12:00:00Z")

    def add(self, kind="progress", author="worker", when="2026-01-01T12:01:00Z", **fields):
        payload = {"kind": kind, "event": "job-1", **fields}
        self.issue["comments"].append({"issue_id": "proj-1", "author": author, "created_at": when,
                                       "text": "beads-work/v1 " + json.dumps(payload)})

    def verdict(self, kind="progress", author="worker", subject=None):
        return check(self.issue, "proj-1", kind, author, "job-1", self.start, subject)["ok"]

    def test_requires_matching_new_work_checkpoint(self):
        for field in ("author", "when", "event", "next", "result", "evidence"):
            with self.subTest(field=field):
                self.issue["comments"].clear()
                args = {"result": "Fixed", "evidence": "test run 15", "next": "send for review"}
                args[field] = {"author": "stranger", "when": "2026-01-01T11:59:59Z", "event": "old"}.get(field, " ")
                self.add(**args)
                self.assertFalse(self.verdict())
        self.issue["comments"].clear()
        self.add(result="Fixed", evidence="test run 16", next="send for review")
        self.assertTrue(self.verdict())
        self.issue["id"] = "proj-2"
        self.assertFalse(self.verdict())

    def test_acceptance_requires_all_current_criteria_and_revision(self):
        results = [{"criterion": c, "verdict": "pass", "evidence": "test run 3"} for c in ["one", "two"]]
        self.add("acceptance", "reviewer", subject="rev-a", checks=results)
        self.assertTrue(self.verdict("acceptance", "reviewer", "rev-a"))
        self.assertFalse(self.verdict("acceptance", "worker", "rev-a"))
        self.assertFalse(self.verdict("acceptance", "reviewer", "rev-b"))
        self.issue["acceptance_criteria"] += "\nthree"
        self.assertFalse(self.verdict("acceptance", "reviewer", "rev-a"))

    def test_later_failed_verdict_supersedes_pass_even_if_reads_are_unordered(self):
        self.issue["acceptance_criteria"] = "one"
        for when, verdict in [("2026-01-01T12:02:00Z", "fail"), ("2026-01-01T12:01:00Z", "pass")]:
            self.add("acceptance", "reviewer", when, subject="rev-a", checks=[{"criterion": "one", "verdict": verdict, "evidence": "run 3"}])
        self.assertFalse(self.verdict("acceptance", "reviewer", "rev-a"))

    def test_old_or_missing_comments_and_malformed_evidence(self):
        self.assertFalse(self.verdict())
        self.issue["comments"] = [{"text": "done"}]
        self.assertFalse(self.verdict())
        self.add(result="Done", evidence=["not a reference string"], next="review")
        self.assertFalse(self.verdict())

    def test_ambiguous_latest_receipts_fail_closed(self):
        self.add(result="Fixed", evidence="test run 15", next="review")
        self.add(result="Blocked", evidence="test run 16", next="retry")
        self.assertFalse(self.verdict())
