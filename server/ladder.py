"""
Your ladder rank before and after a rated game, when either is in the top 500.

Showdown publishes only the top 500 of each ladder, sorted by Elo. Right after
a rated game ends we fetch it once: your rank after is where you are in it, and
your rank before is where your old rating would place you among everyone else
(with your opponent at their old rating too). Other players' games in those few
seconds, and the battle message's ratings being estimates (see ranks), can
shift it by a place or so.
"""

import json
import logging
import time
import urllib.request

from fp.battle.helpers import normalize_name

logger = logging.getLogger("fpo")

LADDER_URL = "https://pokemonshowdown.com/ladder/gen9randombattle.json"
TOP = 500
# How far the battle message's estimate of your new rating may be off from the real one
SLACK = 10


def fetch_toplist(timeout: float = 5) -> list[dict]:
    req = urllib.request.Request(LADDER_URL, headers={"User-Agent": "foul-play-overlay"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["toplist"]


def ranks(toplist: list[dict], me: str, rating: dict, opponent: str | None = None, opp_rating: dict | None = None, started: float = 0) -> dict | None:
    """
    {"before": rank or None, "after": rank or None} (None: outside the top 500),
    or None if the list doesn't show this game yet.

    The ratings in the battle's "X's rating: A -> B" message are only the battle
    server's estimate (from cached, rounded ratings); the login server works out
    the real ones separately and they can differ by a few points, or by more for
    someone playing several games at once. So we never match on the new rating:
    the list has caught up once your entry was last played after the game
    started (`started`, epoch seconds).
    """
    me_id, opp_id = normalize_name(me), normalize_name(opponent or "")
    toplist = sorted(toplist, key=lambda e: -e["elo"])
    cutoff = toplist[-1]["elo"] if len(toplist) >= TOP else 0

    after = None
    for i, e in enumerate(toplist):
        if e["userid"] == me_id:
            if (e.get("last_played") or 0) < started:
                return None  # still from before this game
            after = i + 1
            break
    else:
        if rating["after"] > cutoff + SLACK:
            return None  # should be on it by now

    others = [e["elo"] for e in toplist if e["userid"] not in (me_id, opp_id)]
    if opp_rating:
        others.append(opp_rating["before"])
    before = None
    if rating["before"] >= cutoff:
        before = 1 + sum(1 for elo in others if elo > rating["before"])
        if before > TOP:
            before = None
    return {"before": before, "after": after}


def ladder_shift(me: str, rating: dict, opponent: str | None = None, opp_rating: dict | None = None, started: float = 0, tries: int = 5, wait: float = 2) -> dict | None:
    """Fetch the ladder (retrying while it catches up) and work out your rank change."""
    for attempt in range(tries):
        try:
            got = ranks(fetch_toplist(), me, rating, opponent, opp_rating, started)
        except Exception as e:
            logger.warning("couldn't read the ladder: %s", e)
            return None
        if got is not None:
            return {**got, "asOf": int(time.time() * 1000)}
        if attempt < tries - 1:
            time.sleep(wait)
    logger.warning("the ladder hadn't caught up with the game after %d tries", tries)
    return None
