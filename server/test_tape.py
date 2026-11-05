"""
Test the "review the tape" path end to end, without Showdown: take a saved replay,
pretend we were one of the players, and build the request Showdown would have
sent at each decision (exact team, from hindsight). Then record and analyze it.

    .venv\\Scripts\\python.exe server\\test_tape.py <abs path to replay.json> [p1|p2]
"""

import json
import logging
import os
import sys
import tempfile
import time

import overlay_server as srv
from battle_builder import after_start, clean_log, new_battle, process_by_turn, init_user_from_request, reconstruct_team, synthetic_request, finish_with_request
from choices import next_action
from tape import Tape, align, decision_points, usable_requests

logging.basicConfig(level=logging.ERROR)


def fake_requests(log, side, mode):
    team = reconstruct_team(after_start(clean_log(log)), side, mode)
    out = []
    for n, p in enumerate(decision_points(log, side)):
        b = new_battle(mode, side)
        init_user_from_request(b, synthetic_request(team, side))
        process_by_turn(b, after_start(clean_log(log[: p["cut"]])))
        req = synthetic_request(team, side, now=b.user)
        req["rqid"] = n + 2
        if p["kind"] == "switch":
            req["forceSwitch"] = [True]
            req.pop("active", None)
        out.append({"request": req, "logLen": p["cut"]})
    # noise a real recording has: a wait request and a duplicate
    out.insert(1, {"request": {"wait": True, "side": {}, "rqid": 1}, "logLen": 0})
    out.append(dict(out[-1]))
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    with open(sys.argv[1], encoding="utf-8") as f:
        replay = json.load(f)
    log = replay["log"].split("\n")
    side = sys.argv[2] if len(sys.argv) > 2 else "p1"

    # 1. A turn where our mon fainted before moving isn't a choice we made
    skipped = 0
    for i, line in enumerate(log):
        if line.startswith("|turn|"):
            a = next_action(log[i + 1 :], side)
            if a and a.get("skipped"):
                skipped += 1
    print(f"turns where {side} never got to act: {skipped}")

    srv.configure_foul_play(search_ms=200, worlds=3)
    analyzer = srv.Analyzer(search_ms=200, worlds=3, workers=4)

    points = decision_points(log, side)
    kinds = [p["kind"] for p in points]
    print(f"decision points: {kinds.count('move')} moves, {kinds.count('switch')} replacements")
    requests = fake_requests(log, side, analyzer.mode)
    pairs = align(points, usable_requests(requests))
    assert all(r is not None for _, r in pairs), "every decision should get its request"
    # dropping one request must not shift the rest onto the wrong decisions
    gappy = [r for k, r in enumerate(usable_requests(requests)) if k != 3]
    pairs2 = align(points, gappy)
    assert pairs2[3][1] is None and all(r is not None for k, (_, r) in enumerate(pairs2) if k != 3), "gap handling"

    # 2. In-progress battles are refused
    with tempfile.TemporaryDirectory() as d:
        tape = Tape(analyzer, d, 200, 3)
        live = [l for l in log if not l.startswith("|win|")]
        res = tape.record({"id": "battle-" + replay["id"], "log": live, "side": side, "players": ["a", "b"], "requests": requests, "lastUpdate": time.time() * 1000})
        assert not res["ok"] and "progress" in res["error"], res
        print("in-progress battle refused: OK")

        # 3. Finished battle: recorded, analyzed in the background
        res = tape.record({"id": "battle-" + replay["id"], "log": log, "side": side, "players": [replay["players"][0], replay["players"][1]], "requests": requests, "lastUpdate": time.time() * 1000})
        assert res["ok"], res
        t0 = time.time()
        while tape.status()["pending"]:
            time.sleep(0.5)
        rec = tape.load(replay["id"])
        assert rec["status"] == "done", rec.get("error")
        ds = rec["decisions"]
        errors = [d for d in ds if d.get("error")]
        warnings = [d for d in ds if d.get("warning")]
        print(f"analyzed {len(ds)} decisions in {time.time() - t0:.0f}s, {len(errors)} errors, {len(warnings)} warnings, all known={all(d['known'] for d in ds)}")
        for d in ds[:4] + [d for d in ds if d["kind"] == "switch"][:3]:
            top = d.get("options", [{}])[0].get("label")
            p = d.get("played") or {}
            print(f"  T{d['turn']} {d['kind']:6} {d.get('user')} vs {d.get('opponent')}: win {d.get('value')} | FP {top} | played {p.get('label')} #{p.get('rank')}")
        print("  happened:", ds[1]["happened"][:4])
        print("meta:", Tape.meta(rec))
        for d in errors:
            print("ERROR", d["turn"], d["kind"], d["error"])
        sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
