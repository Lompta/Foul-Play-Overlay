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


STARTED = 1794505927  # first |t:| of the battle


def test_estimate_off_by_a_few():
    # The battle said 2144 -> 2165; the login server made it 2163.35
    t = board()
    t.append({"userid": "me", "elo": 2163.35, "last_played": STARTED + 226})
    got = ranks(t, "Me", {"before": 2144, "after": 2165}, started=STARTED)
    assert got is not None and got["after"] is not None, got


def test_stale_ladder_waits():
    t = board()
    t.append({"userid": "me", "elo": 2144.2, "last_played": STARTED - 300})
    assert ranks(t, "Me", {"before": 2144, "after": 2165}, started=STARTED) is None


def test_entering_top_500():
    t = board(500, 2400.0)  # cutoff 1901
    t.append({"userid": "me", "elo": 1905.2, "last_played": STARTED + 200})
    got = ranks(t, "Me", {"before": 1890, "after": 1905}, started=STARTED)
    assert got["before"] is None and got["after"] is not None, got


def test_dropping_out_just_under_the_cutoff():
    # Estimate says 1903 (just over the 1901 cutoff), real rating fell below it
    got = ranks(board(500, 2400.0), "Me", {"before": 1915, "after": 1903}, started=STARTED)
    assert got is not None and got["after"] is None, got


def test_missing_but_should_be_there_waits():
    assert ranks(board(500, 2400.0), "Me", {"before": 2000, "after": 2020}, started=STARTED) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
