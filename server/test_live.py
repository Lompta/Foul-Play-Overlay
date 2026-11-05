"""
Smoke test for the live path (request JSON known), using a replay with the
|rated| line removed and a request JSON reconstructed from it.

    .venv\\Scripts\\python.exe server\\test_live.py <abs path to replay.json> [turn]
"""

import json
import logging
import sys

import overlay_server as srv
from battle_builder import after_start, clean_log, new_battle, process_by_turn, init_user_from_request, reconstruct_team, synthetic_request

logging.basicConfig(level=logging.ERROR)


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        log = json.load(f)["log"].split("\n")
    turn = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    log = [line for line in log if not line.startswith("|rated")]
    cut = next(i for i, line in enumerate(log) if line == f"|turn|{turn}")
    live_log = log[: cut + 1]

    srv.configure_foul_play(search_ms=300, worlds=4)
    analyzer = srv.Analyzer(search_ms=300, worlds=4, workers=4)

    for side in ("p1", "p2"):
        # Build the request the server would have sent this player
        team = reconstruct_team(after_start(clean_log(log)), side, analyzer.mode)
        b = new_battle(analyzer.mode, side)
        init_user_from_request(b, synthetic_request(team, side))
        process_by_turn(b, after_start(clean_log(live_log)))
        request = synthetic_request(team, side, now=b.user)

        res = analyzer.analyze({"log": live_log, "side": side, "request": request})
        assert res["ok"], res
        assert res["played"] is None
        top = ", ".join(f"{o['label']} {o['share']:.0%}" for o in res["options"][:3])
        print(f"live T{res['turn']} {side} {res['user']} vs {res['opponent']}: {top} | synthetic={res['synthetic']}")


if __name__ == "__main__":
    main()
