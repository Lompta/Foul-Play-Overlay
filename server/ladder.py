"""
Your ladder rank before and after a rated game, when either is in the top 500.

Showdown publishes only the top 500 of each ladder, sorted by Elo. Right after
a rated game ends we fetch it once: your rank after is where you are in it, and
your rank before is where your old rating would place you among everyone else
(with your opponent at their old rating too). Other players' games in those few
seconds can shift it by a place or so.
"""

import json
import logging
import time
import urllib.request

from fp.battle.helpers import normalize_name

logger = logging.getLogger("fpo")

LADDER_URL = "https://pokemonshowdown.com/ladder/gen9randombattle.json"
TOP = 500


def fetch_toplist(timeout: float = 5) -> list[dict]:
    req = urllib.request.Request(LADDER_URL, headers={"User-Agent": "foul-play-overlay"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["toplist"]


def ranks(toplist: list[dict], me: str, rating: dict, opponent: str | None = None, opp_rating: dict | None = None) -> dict | None:
    """
    {"before": rank or None, "after": rank or None} (None: outside the top 500),
    or None if the list doesn't show your new rating yet.
    """
    me_id, opp_id = normalize_name(me), normalize_name(opponent or "")
    toplist = sorted(toplist, key=lambda e: -e["elo"])
    cutoff = round(toplist[-1]["elo"]) if len(toplist) >= TOP else 0

    after = None
    for i, e in enumerate(toplist):
        if e["userid"] == me_id:
            if round(e["elo"]) != rating["after"]:
                return None  # still your old rating: not updated yet
            after = i + 1
            break
    else:
        if rating["after"] > cutoff:
            return None  # should be on it by now

    others = [round(e["elo"]) for e in toplist if e["userid"] not in (me_id, opp_id)]
    if opp_rating:
        others.append(opp_rating["before"])
    before = None
    if rating["before"] >= cutoff:
        before = 1 + sum(1 for elo in others if elo > rating["before"])
        if before > TOP:
            before = None
    return {"before": before, "after": after}


def ladder_shift(me: str, rating: dict, opponent: str | None = None, opp_rating: dict | None = None, tries: int = 4, wait: float = 2) -> dict | None:
    """Fetch the ladder (retrying while it catches up) and work out your rank change."""
    for attempt in range(tries):
        try:
            got = ranks(fetch_toplist(), me, rating, opponent, opp_rating)
        except Exception as e:
            logger.warning("couldn't read the ladder: %s", e)
            return None
        if got is not None:
            return {**got, "asOf": int(time.time() * 1000)}
        if attempt < tries - 1:
            time.sleep(wait)
    return None
