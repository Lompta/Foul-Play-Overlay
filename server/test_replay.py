"""
Smoke test: analyze a saved replay at a few turns, from both sides.

    .venv\\Scripts\\python.exe server\\test_replay.py server\\test_data\\replay1.json [turn ...]
"""

import json
import logging
import sys

import overlay_server as srv

logging.basicConfig(level=logging.ERROR)


def main():
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        replay = json.load(f)
    log = replay["log"].split("\n")
    turn_lines = {int(line.split("|")[2]): i for i, line in enumerate(log) if line.startswith("|turn|")}
    turns = sorted(turn_lines) if sys.argv[2:] == ["all"] else ([int(t) for t in sys.argv[2:]] or [1, 5, 10])
    quiet = sys.argv[2:] == ["all"]

    srv.configure_foul_play(search_ms=300, worlds=4)
    analyzer = srv.Analyzer(search_ms=300, worlds=4, workers=4)

    # A live rated battle that hasn't ended must be refused
    unfinished = log[: turn_lines[min(turn_lines)] + 1]
    refused = analyzer.analyze({"log": unfinished, "side": "p1"})
    assert not refused["ok"] and "rated" in refused["error"], refused
    print("live rated battle refused: OK")

    failures = 0
    for turn in turns:
        for side in ("p1", "p2"):
            try:
                res = analyzer.analyze({"log": log, "side": side, "upTo": turn_lines[turn] + 1})
            except Exception as e:
                res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            if not res["ok"]:
                if "Waiting for a switch-in" in res["error"]:
                    continue
                failures += 1
                print(f"T{turn} {side}: ERROR {res['error']}")
                continue
            if quiet:
                continue
            top = ", ".join(f"{o['label']} {o['share']:.0%}" for o in res["options"][:3])
            played = res["played"]
            p = f"played {played['label']} (#{played.get('rank')}, surprise {played.get('surprise')})" if played else "played: -"
            print(f"T{res['turn']} {side} {res['user']} vs {res['opponent']}: {top} | {p} | {res['ms']}ms")
    print(f"{replay['id']}: {len(turns)} turns x 2 sides, {failures} failures")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
