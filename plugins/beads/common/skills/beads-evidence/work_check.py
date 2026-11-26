"""Read the latest recorded progress or acceptance decision for one assignment."""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PREFIX = "beads-work/v1 "


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed


def nonblank(value):
    return isinstance(value, str) and bool(value.strip())


def check(issue, bead, kind, actor, event, since, subject=None):
    def result(ok, reason):
        return {"ok": ok, "bead": bead, "kind": kind, "event": event, "reason": reason}

    if issue.get("id") != bead:
        return result(False, "wrong bead")
    matches = []
    latest_unreadable = None
    for row in issue.get("comments", []):
        if not isinstance(row, dict) or row.get("author") != actor or row.get("issue_id") != bead:
            continue
        body = row.get("text")
        if not isinstance(body, str) or not body.startswith(PREFIX):
            continue
        when = timestamp(row["created_at"])
        if when < since:
            continue
        try:
            record = json.loads(body[len(PREFIX):])
        except ValueError:
            if latest_unreadable is None or when > latest_unreadable:
                latest_unreadable = when
            continue
        if not isinstance(record, dict) or (record.get("kind"), record.get("event")) != (kind, event):
            continue
        matches.append((when, record))
    if not matches:
        return result(False, "no matching checkpoint after the supplied work boundary")
    latest = max(when for when, _ in matches)
    if latest_unreadable is not None and latest_unreadable >= latest:
        return result(False, "invalid marked comment at or after the latest checkpoint")
    records = [record for when, record in matches if when == latest]
    if any(record != records[0] for record in records):
        return result(False, "conflicting checkpoints at the latest timestamp")
    record = records[0]
    if kind == "progress":
        if all(nonblank(record.get(key)) for key in ("result", "evidence", "next")):
            return result(True, "progress recorded")
        return result(False, "missing result, evidence or next action")
    if not nonblank(subject) or record.get("subject") != subject:
        return result(False, "verification names a different revision or deliverable")
    criteria = [s.strip() for s in (issue.get("acceptance_criteria") or "").splitlines() if s.strip()]
    checks = record.get("checks")
    if not criteria or not isinstance(checks, list) or len(set(criteria)) != len(criteria):
        return result(False, "need distinct criterion lines and a verification list")
    passed = []
    for item in checks:
        if not isinstance(item, dict) or item.get("verdict") != "pass" or not nonblank(item.get("evidence")) or not nonblank(item.get("criterion")):
            return result(False, "unverified criterion")
        passed.append(item["criterion"])
    if sorted(passed) != sorted(criteria):
        return result(False, "verification does not cover the current criteria exactly")
    return result(True, "acceptance attested for this subject; delivery not checked")


def background_actor(root, parent, parent_actor):
    """Read the native runner's one fresh run-0 header, never a path in worker output."""
    root = Path(root)
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("invalid assignment session root")
    runs = list(root.iterdir())
    if len(runs) != 1:
        raise ValueError("expected one run")
    run = runs[0]
    child = run / "run-0"
    session = child / "session.jsonl"
    if run.is_symlink() or child.is_symlink() or session.is_symlink() or not session.is_file():
        raise ValueError("expected native session file")
    with session.open("rb") as source:
        line = source.readline(65537)
    if len(line) > 65536:
        raise ValueError("oversized header")
    try:
        header = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid child session header") from error
    if (not isinstance(header, dict) or header.get("type") != "session" or header.get("parentSession") != parent
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", header.get("id", ""))):
        raise ValueError("not the assigned direct child")
    return f'{parent_actor}/{header["id"]}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="kind", required=True)
    for kind in ("progress", "acceptance", "background-progress"):
        mode = modes.add_parser(kind)
        mode.add_argument("bead", help="full issue ID in the active ledger")
        if kind == "background-progress":
            mode.add_argument("--session-root", required=True)
            mode.add_argument("--parent", required=True)
            mode.add_argument("--parent-actor", required=True)
        else:
            mode.add_argument("--actor", required=True)
        mode.add_argument("--event", required=True)
        mode.add_argument("--since", required=True, type=timestamp)
        if kind == "acceptance":
            mode.add_argument("--subject", required=True, help="expected revision or artifact digest")
    args = parser.parse_args()
    try:
        if args.kind == "background-progress":
            args.actor = background_actor(args.session_root, args.parent, args.parent_actor)
            args.kind = "progress"
        raw = subprocess.run(["bd", "--readonly", "show", "--include-comments", "--json", "--", args.bead],
                             check=True, capture_output=True, timeout=30)
        rows = json.loads(raw.stdout)
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise ValueError("expected one bead from bd show")
        outcome = check(rows[0], args.bead, args.kind, args.actor, args.event, args.since, getattr(args, "subject", None))
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError, AttributeError) as error:
        print(json.dumps({"ok": False, "reason": f"could not read ledger evidence: {type(error).__name__}"}))
        return 2
    print(json.dumps(outcome))
    return 0 if outcome["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
