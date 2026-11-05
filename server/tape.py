"""
"Review the tape": analysis of your own finished battles, using what you
actually knew at each decision.

While you play, the extension records every request Showdown sends you (your
exact team, moves, HP and legal options at that moment). Nothing is analyzed
then. When the battle ends it sends the recording here; we line each request up
with its place in the battle log and run Foul Play on every decision you made:
each turn's move, plus each replacement you had to choose after a faint or a
pivot move.

Recordings live in data/battles/<room id>.json.
"""

import json
import logging
import os
import re
import threading
import time
from copy import deepcopy
from html import unescape

from fp.battle.helpers import normalize_name

from battle_builder import clean_log
from choices import display_names, next_action, prettify, rank_played
from snapshot import snapshot, teamsizes

logger = logging.getLogger("fpo")

FORMAT_TIER = "[Gen 9] Random Battle"
ABANDONED_AFTER_S = 30 * 60
SAFE_ID = re.compile(r"^[a-z0-9-]{1,100}$")


# ---------------------------------------------------------------- decision points


def _is_mine(parts: list[str], side: str) -> bool:
    return len(parts) > 2 and parts[2].startswith(side + "a")


def decision_points(log: list[str], side: str) -> list[dict]:
    """
    Every point in `log` where `side` had to choose something, in order.

    - kind "move": the start of each turn (cut just after the |turn| line).
    - kind "switch": a replacement chosen mid-turn or at end of turn (after a
      faint, U-turn, Eject Button...). Cut just before the switch-in, and before
      any opponent replacement that happened alongside it.

    A switch at the start of a turn, before anything has moved, is that turn's
    move decision, not a separate one. Drags (Roar, Red Card...) aren't decisions.
    """
    points = []
    turn = 0
    mid_turn = False
    for i, line in enumerate(log):
        parts = line.split("|")
        if len(parts) < 2:
            continue
        tag = parts[1]
        if tag == "turn":
            turn = int(parts[2])
            mid_turn = False
            points.append({"kind": "move", "cut": i + 1, "turn": turn})
        elif tag in ("move", "upkeep", "cant", "faint") and turn > 0:
            mid_turn = True
        elif tag == "switch" and mid_turn and _is_mine(parts, side):
            cut = i
            # Back up over the |split| header of our own (private) switch line,
            # and over an opponent replacement made at the same time
            while cut > 0:
                prev = log[cut - 1].split("|")
                if len(prev) > 1 and (
                    prev[1] == "split"
                    or (prev[1] == "switch" and not _is_mine(prev, side))
                    or prev[1] in ("", "t:")
                ):
                    cut -= 1
                else:
                    break
            # A split block repeats our switch line (private, then public); count it once
            if points and points[-1]["kind"] == "switch" and all(
                log[k].startswith("|switch|" + side + "a") for k in range(points[-1]["switchLine"], i)
            ):
                continue
            name = parts[3].split(",")[0]
            points.append(
                {
                    "kind": "switch",
                    "cut": cut,
                    "turn": turn,
                    "switchLine": i,
                    "played": {"choice": "switch " + normalize_name(name), "label": "Switch to " + name},
                }
            )
    return points


def usable_requests(recorded: list[dict]) -> list[dict]:
    """
    Requests that asked for a decision, oldest first, one per rqid. Each recorded
    entry is {"request": ..., "logLen": length of the log when it arrived}.
    """
    by_rqid = {}
    for entry in recorded:
        r = entry.get("request") if isinstance(entry, dict) else None
        if not isinstance(r, dict) or r.get("wait") or r.get("teamPreview") or "side" not in r:
            continue
        by_rqid[r.get("rqid", len(by_rqid))] = {"request": r, "logLen": entry.get("logLen")}
    return [by_rqid[k] for k in sorted(by_rqid)]


def align(points: list[dict], recorded: list[dict]) -> list[tuple[dict, dict | None]]:
    """
    Pair each decision point with the request Showdown sent for it. Both are in
    order, so walk them together. A request can't have arrived after its
    decision point was already past, which catches gaps (a request we never saw).
    """
    out = []
    j = 0
    for p in points:
        want_switch = p["kind"] == "switch"
        if not want_switch:
            # switch requests before this turn's move request belong to replacements
            # we didn't spot in the log; they can't be this turn's request
            while j < len(recorded) and recorded[j]["request"].get("forceSwitch"):
                j += 1
        if j < len(recorded):
            r = recorded[j]
            kind_ok = bool(r["request"].get("forceSwitch")) == want_switch
            in_time = r["logLen"] is None or r["logLen"] <= p["cut"] + 3
            if kind_ok and in_time:
                out.append((p, r["request"]))
                j += 1
                continue
        out.append((p, None))
    return out


def request_active(request: dict) -> str | None:
    for p in request.get("side", {}).get("pokemon", []):
        if p.get("active"):
            return normalize_name(p.get("details", "").split(",")[0])
    return None


# ---------------------------------------------------------------- what happened


def describe(lines: list[str], side: str, opp_name: str) -> list[str]:
    """A few readable lines for what happened after a decision, up to the next turn."""
    out = []
    for line in clean_log(lines):
        parts = line.split("|")
        if len(parts) < 3:
            continue
        tag = parts[1]
        if tag in ("turn", "win", "tie"):
            break
        who = parts[2]
        mon = who.split(": ", 1)[1] if ": " in who else who
        if not who.startswith(side) and ": " in who:
            mon = f"{opp_name}'s {mon}"
        if tag == "move" and len(parts) > 3 and not any(p.startswith("[from]") for p in parts[4:]):
            out.append(f"{mon} used {parts[3]}")
        elif tag in ("switch", "drag") and len(parts) > 3:
            owner = "You" if who.startswith(side) else opp_name
            out.append(f"{owner} {'sent in' if tag == 'switch' else 'were dragged to'} {parts[3].split(',')[0]}")
        elif tag == "faint":
            out.append(f"{mon} fainted")
        elif tag == "-terastallize" and len(parts) > 3:
            out.append(f"{mon} terastallized ({parts[3]})")
        elif tag == "cant" and len(parts) > 3:
            out.append(f"{mon} couldn't move ({parts[3]})")
        elif tag in ("-supereffective", "-crit", "-miss") and out:
            out[-1] += {"-supereffective": " (super effective)", "-crit": " (crit)", "-miss": " (missed)"}[tag]
        elif tag == "-damage" and len(parts) > 3 and out and not any(p.startswith("[from]") for p in parts[4:]):
            hp = parts[3].split(" ")[0]
            if hp == "0":
                hp = "0%"
            elif "/" in hp:
                a, b = hp.split("/")
                if a.isdigit() and b.isdigit() and int(b):
                    hp = f"{max(1, round(100 * int(a) / int(b))) if int(a) else 0}%"
            out[-1] += f" → {mon} {hp}"
    return out[:14]


# ---------------------------------------------------------------- the store


class Tape:
    def __init__(self, analyzer, data_dir: str, search_ms: int, worlds: int):
        self.analyzer = analyzer
        self.dir = data_dir
        os.makedirs(self.dir, exist_ok=True)
        self.search_ms = search_ms
        self.worlds = worlds
        self.lock = threading.Lock()
        # One reader or writer of the battle files at a time: on Windows, replacing
        # a file fails while another thread has it open
        self.io = threading.RLock()
        self.metas = {}
        self.queue = []
        self.states_only = set()  # analyzed before positions were saved: just add them
        self.current = None
        self.wake = threading.Event()
        for name in os.listdir(self.dir):
            if name.endswith(".json.tmp"):
                os.remove(os.path.join(self.dir, name))  # left by a crash mid-save
            elif name.endswith(".json"):
                rec = self.load(name[:-5])
                if rec:
                    self.metas[rec["id"]] = self.meta(rec)
        for meta in self.list():
            if meta["status"] in ("queued", "analyzing"):
                self.queue.append(meta["id"])
            elif meta["status"] == "done" and meta.get("needsStates"):
                self.queue.append(meta["id"])
                self.states_only.add(meta["id"])
        threading.Thread(target=self._worker, daemon=True).start()
        if self.queue:
            self.wake.set()

    def _path(self, battle_id: str) -> str:
        return os.path.join(self.dir, battle_id + ".json")

    def load(self, battle_id: str) -> dict | None:
        if not SAFE_ID.match(battle_id):
            return None
        with self.io:
            try:
                with open(self._path(battle_id), encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                return None

    def _save(self, rec: dict):
        path = self._path(rec["id"])
        tmp = path + ".tmp"
        with self.io:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(rec, f)
            # Something outside this server (antivirus, search indexer, a text
            # editor) can hold the file for a moment; wait it out
            for attempt in range(20):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.25)
            self.metas[rec["id"]] = self.meta(rec)

    @staticmethod
    def meta(rec: dict) -> dict:
        ds = rec.get("decisions") or []
        judged = [d for d in ds if d.get("played") and d["played"].get("rank") is not None]
        return {
            "id": rec["id"],
            "me": rec.get("me"),
            "opponent": rec.get("opponent"),
            "result": rec.get("result"),
            "rated": rec.get("rated"),
            "rating": rec.get("rating"),
            "endedAt": rec.get("endedAt"),
            "turns": rec.get("turns"),
            "status": rec.get("status"),
            "error": rec.get("error"),
            "progress": rec.get("progress"),
            "abandoned": rec.get("abandoned", False),
            "agreement": round(sum(d["played"]["rank"] == 1 for d in judged) / len(judged), 3) if judged else None,
            "mistakes": sum(1 for d in judged if (d["played"].get("evalLoss") or 0) >= 0.1),
            "needsStates": any("state" not in d and not d.get("error") for d in ds),
        }

    def list(self) -> list[dict]:
        with self.io:
            out = list(self.metas.values())
        out.sort(key=lambda m: m.get("endedAt") or 0, reverse=True)
        return out

    def status(self) -> dict:
        with self.lock:
            return {"pending": len(self.queue) + (1 if self.current else 0), "current": self.current}

    # ------------------------------------------------------------ intake

    def record(self, payload: dict) -> dict:
        battle_id = str(payload.get("id", "")).removeprefix("battle-")
        if not SAFE_ID.match(battle_id):
            return {"ok": False, "error": "bad battle id"}
        log = payload.get("log") or []
        side = payload.get("side")
        if side not in ("p1", "p2") or not isinstance(log, list):
            return {"ok": False, "error": "bad recording"}
        if not any(line == "|tier|" + FORMAT_TIER for line in log):
            return {"ok": False, "error": "only Gen 9 Random Battles are supported"}

        ended = any(line.startswith("|win|") or line == "|tie" or line.startswith("|tie|") for line in log)
        last = float(payload.get("lastUpdate") or 0) / 1000
        abandoned = not ended and time.time() - last > ABANDONED_AFTER_S
        if not ended and not abandoned:
            # Same rule as the overlay: nothing about a battle until it's over
            return {"ok": False, "error": "battle still in progress"}

        existing = self.load(battle_id)
        if existing and existing.get("status") == "done" and len(existing.get("log", [])) >= len(log):
            return {"ok": True, "id": battle_id, "duplicate": True}

        players = payload.get("players") or ["p1", "p2"]
        me = players[0 if side == "p1" else 1]
        opp = players[1 if side == "p1" else 0]
        result = None
        for line in log:
            if line.startswith("|win|"):
                result = "win" if line[5:] == me else "loss"
            elif line == "|tie" or line.startswith("|tie|"):
                result = "tie"
        rating = None
        for line in log:
            # |raw|Name's rating: 1500 &rarr; <strong>1520</strong><br />(+20 for winning)
            m = re.match(r"\|raw\|(.+?)'s rating: (\d+) &rarr; <strong>(\d+)</strong>", line)
            if m and unescape(m.group(1)) == me:
                rating = {"before": int(m.group(2)), "after": int(m.group(3))}
        turns = max((int(l.split("|")[2]) for l in log if l.startswith("|turn|")), default=0)

        rec = {
            "id": battle_id,
            "side": side,
            "players": players,
            "me": me,
            "opponent": opp,
            "rated": any(line.startswith("|rated") for line in log),
            "result": result,
            "rating": rating,
            "turns": turns,
            "abandoned": abandoned,
            "endedAt": int(time.time() * 1000) if ended else int(last * 1000),
            "log": log,
            "requests": payload.get("requests") or [],
            "status": "queued",
            "progress": None,
            "decisions": [],
        }
        self._save(rec)
        self.enqueue(battle_id)
        return {"ok": True, "id": battle_id}

    def reanalyze(self, battle_id: str) -> bool:
        rec = self.load(battle_id)
        if rec is None:
            return False
        with self.lock:
            if battle_id == self.current:
                return True  # already running
        rec.update(status="queued", progress=None, decisions=[], error=None)
        self._save(rec)
        self.enqueue(battle_id)
        return True

    def enqueue(self, battle_id: str):
        with self.lock:
            if battle_id not in self.queue and battle_id != self.current:
                self.queue.append(battle_id)
        self.wake.set()

    # ------------------------------------------------------------ analysis

    def _worker(self):
        while True:
            self.wake.wait()
            with self.lock:
                if not self.queue:
                    self.wake.clear()
                    continue
                self.current = self.queue.pop(0)
            try:
                if self.current in self.states_only:
                    self.states_only.discard(self.current)
                    self.add_states(self.current)
                else:
                    self.analyze(self.current)
            except Exception as e:
                logger.exception("tape analysis failed")
                try:
                    rec = self.load(self.current)
                    if rec:
                        rec.update(status="error", error=f"{type(e).__name__}: {e}")
                        self._save(rec)
                except Exception:
                    logger.exception("couldn't record the failure either")
            finally:
                with self.lock:
                    self.current = None

    def _position(self, rec: dict, point: dict, request: dict | None, names: dict):
        """The battle at a decision point, and a snapshot of it for the review page."""
        from battle_builder import build_battle

        log = rec["log"]
        built = build_battle(log[: point["cut"]], rec["side"], request, self.analyzer.mode, full_log=log)
        battle = built.battle
        if battle.user.active is None or battle.opponent.active is None:
            return battle, None
        view = deepcopy(battle)
        view.user.update_from_request_json(view.request_json)  # exact HP, PP etc.
        return battle, snapshot(view, names, teamsizes(log))

    def add_states(self, battle_id: str):
        rec = self.load(battle_id)
        if rec is None:
            return
        log, side = rec["log"], rec["side"]
        pairs = align(decision_points(log, side), usable_requests(rec["requests"]))
        names = display_names(log, [e.get("request") for e in rec["requests"] if isinstance(e, dict)])
        # Decisions are in the same order as the points they came from (some points were skipped)
        k = 0
        for point, request in pairs:
            if k >= len(rec["decisions"]):
                break
            d = rec["decisions"][k]
            if (d["turn"], d["kind"]) != (point["turn"], point["kind"]):
                continue
            k += 1
            if "state" in d or d.get("error"):
                continue
            try:
                _, d["state"] = self._position(rec, point, request, names)
            except Exception:
                logger.exception("couldn't rebuild a position")
                d["state"] = None
        self._save(rec)

    def analyze(self, battle_id: str):
        rec = self.load(battle_id)
        if rec is None:
            return
        log, side = rec["log"], rec["side"]
        points = decision_points(log, side)
        pairs = align(points, usable_requests(rec["requests"]))
        opp_name = rec.get("opponent") or "Opponent"
        names = display_names(log, [e.get("request") for e in rec["requests"] if isinstance(e, dict)])
        # Pick up where we left off if the server stopped partway through
        start = (rec.get("progress") or {}).get("done", 0) if rec.get("status") == "analyzing" else 0
        if not start:
            rec["decisions"] = []
        rec.update(status="analyzing", progress={"done": start, "total": len(pairs)}, error=None)
        self._save(rec)

        for n, (point, request) in enumerate(pairs):
            if n < start:
                continue
            rest = log[point["cut"] :]
            if point["kind"] == "move":
                played = next_action(rest, side)
            else:
                played = dict(point["played"])
            decision = {
                "kind": point["kind"],
                "turn": point["turn"],
                "known": request is not None,
                "happened": describe(rest, side, opp_name),
            }
            try:
                t0 = time.time()
                battle, state = self._position(rec, point, request, names)
                if state is None:
                    rec["progress"] = {"done": n + 1, "total": len(pairs)}
                    continue
                if request is not None:
                    want = request_active(request)
                    if want and normalize_name(battle.user.active.name) != want and not battle.force_switch:
                        decision["warning"] = "recorded options didn't match the log here"
                res = self.analyzer.search(battle, self.search_ms, self.worlds)
                decision.update(
                    state=state,
                    user=battle.user.active.name,
                    opponent=battle.opponent.active.name,
                    options=res["options"][:10],
                    value=res["value"],
                    played=rank_played(played, res["options"]),
                    ms=int((time.time() - t0) * 1000),
                )
                prettify(decision, names)
            except Exception as e:
                logger.exception("decision analysis failed")
                decision.update(error=f"{type(e).__name__}: {e}", played=played)
            rec["decisions"].append(decision)
            rec["progress"] = {"done": n + 1, "total": len(pairs)}
            self._save(rec)

        rec.update(status="done", settings={"searchMs": self.search_ms, "worlds": self.worlds})
        self._save(rec)
