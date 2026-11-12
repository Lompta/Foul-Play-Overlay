r"""
Test the ladder rank arithmetic on made-up toplists, without the network.

    .venv\Scripts\python.exe server\test_ladder.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "vendor", "foul-play"))
sys.path.insert(0, HERE)

from ladder import ranks  # noqa: E402


def board(n=500, top=2400.0):
    return [{"userid": f"p{i}", "elo": top - i} for i in range(n)]


def test_truncated_rating_matches():
    # The ladder said 2114.54; the battle message said 2114 (truncated, not rounded)
    t = board()
    t.append({"userid": "me", "elo": 2114.54})
    got = ranks(t, "Me", {"before": 2097, "after": 2114})
    assert got is not None and got["after"] is not None, got


def test_stale_ladder_waits():
    t = board()
    t.append({"userid": "me", "elo": 2097.9})
    assert ranks(t, "Me", {"before": 2097, "after": 2114}) is None


def test_entering_top_500():
    t = board(500, 2400.0)  # cutoff 1901
    t.append({"userid": "me", "elo": 1905.2})
    got = ranks(t, "Me", {"before": 1890, "after": 1905})
    assert got["before"] is None and got["after"] is not None, got


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
