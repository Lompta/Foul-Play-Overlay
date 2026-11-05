"""
Foul Play Overlay: local analysis server.

Takes a Showdown battle log (plus the player's request JSON, when we have one),
rebuilds the position with Foul Play's own battle-tracking code, and runs
Foul Play's search. Returns every option it considered, ranked.

Listens on 127.0.0.1 only. Rated battles are refused.

    python server/overlay_server.py [--port 8770] [--search-ms 1500] [--worlds 8] [--workers 4]
"""

import argparse
import json
import logging
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "vendor", "foul-play"))
sys.path.insert(0, HERE)

# Foul Play caches its random-battle set data relative to the working directory
os.chdir(os.path.join(HERE, "..", "vendor", "foul-play"))

from fp import constants  # noqa: E402
from fp.config import FoulPlayConfig  # noqa: E402
from fp.data import all_move_json, pokedex  # noqa: E402
from fp.data.mods.apply_mods import apply_mods  # noqa: E402

from battle_builder import build_battle  # noqa: E402
from choices import display_names, next_action, prettify, rank_played  # noqa: E402

FORMAT = "gen9randombattle"
logger = logging.getLogger("fpo")


def configure_foul_play(search_ms: int, worlds: int):
    FoulPlayConfig.pokemon_format = FORMAT
    FoulPlayConfig.search_time_ms = search_ms
    FoulPlayConfig.parallelism = worlds
    FoulPlayConfig.search_threads = 1
    FoulPlayConfig.time_remaining = None
    apply_mods(FoulPlayConfig.format_spec)


def search_one_world(state_string: str, search_ms: int):
    # Runs in a worker process
    from poke_engine import State, monte_carlo_tree_search

    res = monte_carlo_tree_search(State.from_string(state_string), search_ms, threads=1)
    return {
        "total": res.total_visits,
        # Average result over the whole search, from side one's view: Foul Play's
        # own estimate of how the game is going (0 = losing, 1 = winning)
        "value": sum(o.total_score for o in res.side_one) / max(sum(o.visits for o in res.side_one), 1),
        "options": [
            {"choice": o.move_choice, "visits": o.visits, "score": o.total_score}
            for o in res.side_one
        ],
    }


def pretty_choice(choice: str) -> str:
    tera = choice.endswith("-tera")
    base = choice.removesuffix("-tera").removesuffix("-mega")
    if base.startswith("switch "):
        name = base.split(" ", 1)[1]
        label = "Switch to " + pokedex.get(name, {}).get("name", name)
    else:
        label = all_move_json.get(base, {}).get("name", base)
    return label + (" + Tera" if tera else "")


def cut_at_turn_start(log: list[str], up_to: int) -> list[str]:
    head = log[:up_to]
    for i in range(len(head) - 1, -1, -1):
        if head[i].startswith("|turn|"):
            return head[: i + 1]
    return head


class Analyzer:
    def __init__(self, search_ms: int, worlds: int, workers: int):
        from fp.modes.random_battle import RandomBattleMode
        from fp.search.poke_engine_helpers import battle_to_poke_engine_state

        self.mode = RandomBattleMode()
        self.mode.datasets.initialize(FoulPlayConfig.format_spec)
        self.to_state = battle_to_poke_engine_state
        self.search_ms = search_ms
        self.worlds = worlds
        self.pool = ProcessPoolExecutor(max_workers=workers)
        self.lock = Lock()

    def analyze(self, payload: dict) -> dict:
        log = payload["log"]
        side = payload["side"]
        rated = any(line.startswith("|rated") for line in log)
        ended = any(line.startswith("|win|") or line == "|tie" or line.startswith("|tie|") for line in log)
        if rated and not ended:
            # The one thing this tool won't do: help during an ongoing ladder game
            return {"ok": False, "error": "Live rated battle: analysis is off until it ends."}

        search_ms = int(payload.get("searchMs") or self.search_ms)
        worlds = int(payload.get("worlds") or self.worlds)

        t0 = time.time()
        request = payload.get("request")
        position, played = log, None
        if payload.get("upTo") is not None:
            # Replay: analyze the decision at the start of the turn being viewed
            position = cut_at_turn_start(log, int(payload["upTo"]))
            played = next_action(log[len(position):], side)
            request = None
        built = build_battle(position, side, request, self.mode, full_log=log)
        battle = built.battle

        if battle.user.active is None or battle.opponent.active is None:
            return {"ok": False, "error": "Battle hasn't started yet."}
        if not battle.user.active.is_alive() and not battle.force_switch:
            return {"ok": False, "error": "Waiting for a switch-in."}

        result = self.search(battle, search_ms, worlds)
        result.update(
            turn=battle.turn,
            side=side,
            user=battle.user.active.name,
            opponent=battle.opponent.active.name,
            synthetic=built.synthetic,
            played=rank_played(played, result["options"]),
            ms=int((time.time() - t0) * 1000),
        )
        return prettify(result, display_names(log, [request] if request else []))

    def search(self, battle, search_ms: int, worlds: int) -> dict:
        # Same as Foul Play's own move picker: sample plausible hidden sets for the
        # opponent, search each sampled world, then merge the results
        with self.lock:
            battle_copy = deepcopy(battle)
            battle_copy.user.update_from_request_json(battle_copy.request_json)
            sampled = self.mode.prepare_battles(battle_copy, worlds)
            futures = [
                (self.pool.submit(search_one_world, self.to_state(b).to_string(), search_ms), weight)
                for b, weight in sampled
            ]
            results = [(f.result(), w) for f, w in futures]

        merged = {}
        total_iterations = 0
        value = weight_sum = 0.0
        for res, weight in results:
            total_iterations += res["total"]
            value += weight * res["value"]
            weight_sum += weight
            for o in res["options"]:
                m = merged.setdefault(o["choice"], {"share": 0.0, "visits": 0, "score": 0.0})
                m["share"] += weight * o["visits"] / max(res["total"], 1)
                m["visits"] += o["visits"]
                m["score"] += o["score"]

        options = sorted(
            (
                {
                    "choice": c,
                    "label": pretty_choice(c),
                    "share": round(m["share"], 4),
                    "eval": round(m["score"] / m["visits"], 4) if m["visits"] else None,
                }
                for c, m in merged.items()
            ),
            key=lambda o: o["share"],
            reverse=True,
        )
        return {
            "ok": True,
            "options": options,
            "value": round(value / weight_sum, 4) if weight_sum else None,
            "iterations": total_iterations,
            "worlds": worlds,
        }


def make_handler(analyzer: Analyzer, tape):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _allowed(self) -> bool:
            # Only the extension talks to us. It sends this header, which ordinary
            # web pages can't send cross-origin without a CORS preflight (and we
            # never answer preflights), so random sites can't use the server or
            # read your recorded battles.
            if self.headers.get("X-FPO") == "1":
                return True
            self._send(403, {"ok": False, "error": "forbidden"})
            return False

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length))

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "format": FORMAT, "tape": True})
            elif self.path == "/queue":
                self._send(200, {"ok": True, **tape.status()})
            elif self.path == "/battles":
                if self._allowed():
                    self._send(200, {"ok": True, "battles": tape.list(), **tape.status()})
            elif self.path.startswith("/battles/"):
                if self._allowed():
                    rec = tape.load(self.path[len("/battles/") :])
                    if rec is None:
                        self._send(404, {"ok": False, "error": "no such battle"})
                    else:
                        rec.pop("requests", None)
                        self._send(200, {"ok": True, "battle": rec})
            else:
                self._send(404, {"ok": False})

        def do_POST(self):
            if not self._allowed():
                return
            try:
                if self.path == "/analyze":
                    self._send(200, analyzer.analyze(self._body()))
                elif self.path == "/record":
                    self._send(200, tape.record(self._body()))
                elif self.path.startswith("/battles/") and self.path.endswith("/reanalyze"):
                    battle_id = self.path[len("/battles/") : -len("/reanalyze")]
                    if tape.reanalyze(battle_id):
                        self._send(200, {"ok": True})
                    else:
                        self._send(404, {"ok": False, "error": "no such battle"})
                else:
                    self._send(404, {"ok": False})
            except Exception as e:  # report it to the extension instead of dying
                logger.exception("request failed")
                self._send(200, {"ok": False, "error": f"{type(e).__name__}: {e}"})

        def log_message(self, fmt, *args):
            logger.debug(fmt, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--search-ms", type=int, default=1500, help="search time per sampled world")
    parser.add_argument("--worlds", type=int, default=8, help="sampled opponent sets per analysis")
    parser.add_argument("--workers", type=int, default=max(1, min(8, (os.cpu_count() or 4) // 2)))
    parser.add_argument("--tape-search-ms", type=int, default=1500, help="search time per world when reviewing your recorded battles")
    parser.add_argument("--tape-worlds", type=int, default=8)
    parser.add_argument("--data-dir", default=os.path.join(HERE, "..", "data", "battles"))
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    # Foul Play logs every inference step; keep only errors unless debugging
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.ERROR, format="%(levelname)s %(message)s")
    logger.setLevel(logging.INFO)
    configure_foul_play(args.search_ms, args.worlds)
    analyzer = Analyzer(args.search_ms, args.worlds, args.workers)

    from tape import Tape

    tape = Tape(analyzer, os.path.abspath(args.data_dir), args.tape_search_ms, args.tape_worlds)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(analyzer, tape))
    logger.info("Foul Play Overlay server on http://127.0.0.1:%d (%d workers)", args.port, args.workers)
    print(f"Foul Play Overlay server ready on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
