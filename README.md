# Foul Play Overlay

*Coded by Claude Opus 5.5, with direction by Justis Mills.*

"What would Foul Play do?" A toggleable panel on Pokémon Showdown that shows
[Foul Play](https://github.com/pmariglia/foul-play)'s ranking of your options,
turn by turn. Gen 9 Random Battles only.

- **Replays** (rated or not), from either player's perspective: the ranking,
  where the move actually played ranked, and a tag for top choice, about as
  good, slightly worse or likely mistake.
- **Live unrated battles**, e.g. against Foul Play itself (see the sparring bot below).
- **Off during live rated battles.** It turns back on when the battle ends, and
  works on the replay. This is enforced in both the extension and the server.
- **Review the tape** of your own games (ladder or not). While you play, the
  extension quietly records each request Showdown sends you, which holds your exact
  team, moves, HP and legal options. Foul Play analyzes every decision you made
  (each turn's move, plus every replacement after a faint or pivot) with what you
  actually knew, and estimates how the game was going before each one. To have
  that ready when the game ends, it works through each decision once it's behind
  you (never one you're still making); the results stay in the server's memory,
  unseen, until the battle is over, and then show up within seconds. Open it from the
  extension's toolbar icon, or "Review my games" in the panel. Each game has a
  notes box, saved as you type.
- **Ladder rank**: for a rated game you start or end in the top 500, the review
  shows your rank before and after (e.g. "#312 → #287 ▲25"). The server reads
  Showdown's public top-500 list once, right after the game ends.
- **Showdex KO figures**: if [Showdex](https://github.com/doshidak/showdex) is open
  while you play, the recording also copies what it showed for your active
  Pokémon's moves, so the review labels options like "Discharge (2HKO)". It only
  reads Showdex's table; nothing is computed or shown during the battle.

Foul Play peaked around 2340 Elo on the Random Battle ladder: strong, but below
the very top. Treat its rankings as a strong second opinion, not gospel.

## Setup (once)

Already done on glimpseseeker: Rust + MSVC Build Tools, `.venv` with poke-engine
built for Gen 9 (terastallization), Foul Play cloned into `vendor/foul-play`.

To redo it elsewhere:
```powershell
git clone --depth 1 https://github.com/pmariglia/foul-play.git vendor/foul-play
uv venv .venv --python 3.13
uv pip install --python .venv\Scripts\python.exe requests==2.33.0 websockets==14.1 python-dateutil==2.8.0
uv pip install --python .venv\Scripts\python.exe --no-cache "poke-engine==0.0.48" -C "build-args=--features poke-engine/terastallization --no-default-features"
```

For now the installed poke-engine is patched with a fix for locking moves like
Outrage ([poke-engine#41](https://github.com/pmariglia/poke-engine/pull/41)).
Reinstalling from PyPI drops it. To put it back before that's released:
```powershell
uv pip install --python .venv\Scripts\python.exe --reinstall "poke-engine @ git+https://github.com/Lompta/poke-engine@fix/lockedmove-2-or-3-turns#subdirectory=poke-engine-py" -C "build-args=--features poke-engine/terastallization --no-default-features"
```
(Stop the server first; Windows won't replace the engine while it's loaded.)

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** →
this folder's `extension` subfolder. Its ID is always `olkcabjpgbmblenfkohjcophdlfpehca`
(fixed by the `key` in its manifest; the private half is `extension-key.pem`, not needed for use).

Then, once: `.\install-native-host.ps1`. This lets the extension start the server
itself (your Windows account only; undo with `-Uninstall`).

## Use

1. On Showdown or a replay page, click the round **FP** button at the bottom right.
   The server starts by itself (about a second). It stops about 15 s after FP is
   off in every tab or the last Showdown tab closes, but stays up while you're in a
   battle so your review can be prepared as you play. Idle it uses no CPU and
   about 500 MB of memory; it and its workers run in a Windows job object, so a
   crash can't leave them behind.
   - To use different search settings, start it by hand instead and leave the window open:
     `.\start-server.ps1 -SearchMs 3000`. The extension uses a running server if there is one.
     The default is 1500 ms × 8 sampled worlds, about 3-4 s per position.
3. In replays, choose whose perspective to analyze with the two name buttons.
   Step through turns as usual; the panel follows.
4. **Review my games** (toolbar icon or panel link) lists your recorded battles. Each one
   shows Foul Play's win estimate over the game (hover for details, click to jump),
   how often you agreed with it, likely mistakes, and every decision with its full
   ranking and what happened next. Most of the analysis happens during the game
   (1500 ms × 8 worlds per decision, a few seconds each; change with
   `--tape-search-ms` and `--tape-worlds`); a game recorded with the server off
   takes about 2-4 minutes after it ends. The server stays up until the queue is done. Notes are saved to
   `data/battles/notes/<battle id>.txt`, separate from the analysis, so Re-analyze
   keeps them.

Each option shows Foul Play's win estimate if you pick it (bar and number),
plus, small, how much of its search went to it. Verdicts go by win estimate:
within 3 points of its top choice is "about as good" and counts as agreeing
(repeat searches differ by about that much); 10 or more below is a "likely
mistake"; in between is "slightly worse".

## Sparring against Foul Play

`.\run-sparring-bot.ps1 -Username "SomeBotAccount"` logs Foul Play into a
separate Showdown account (you type its password) and accepts Gen 9 Random
Battle challenges. Challenge it, unrated, with the overlay on to compare notes
turn by turn.

## How it works

- `extension/page.js` reads the battle from the Showdown page (`app.curRoom.battle`,
  or `window.battle` on replay pages) and, for live battles, your request JSON.
- `extension/content.js` is the panel. It decides whether analysis is allowed and
  sends positions to the server via `background.js`.
- `server/overlay_server.py` (127.0.0.1:8770) rebuilds the position with Foul Play's
  own battle tracking, samples likely hidden opponent sets the way Foul Play does,
  runs poke-engine's MCTS on each sample, and merges the results.
- Recording: `page.js` wraps Showdown's `BattleRoom.receiveRequest` (with a 1 s poll
  as backup) and posts each request, plus the log when the battle ends. `background.js`
  keeps them in extension storage and sends them to the server's `/record` only once
  the log shows a winner (the server refuses anything else). If the tab closes
  mid-battle, the recording is sent once it has been quiet for 30 minutes.
- `server/tape.py` finds your decision points in the full log, pairs each with its
  recorded request (in order, checked against the log position when it arrived),
  and analyzes them one by one in a background thread. Results are in
  `data/battles/<battle id>.json`. Decisions with no recorded request (e.g. the page
  was reloaded) fall back to the replay reconstruction and are marked as such.
- `extension/review.html` is the review page (an extension page, so it can talk to
  the local server and keeps it running while open).
- `server/battle_builder.py`: in replays there's no request JSON, so your own side's
  team is rebuilt from everything it reveals over the whole replay (you knew your
  own team), with gaps filled by the likeliest random battle set. Teammates that
  never appear in the replay are left out.

- `server/native_host.py` is the native messaging host Chrome launches; it runs the
  server in a kill-on-close job object and exits when Chrome disconnects.

Tests: `server\test_tape.py <abs path to replay.json> [p1|p2]` (simulated recording, end to end), `server\test_replay.py <abs path to replay.json> all`, `server\test_live.py`, and
`server\test_native_host.py` (start/stop lifecycle; run with no server running).
This repo doesn't include any replays (`server/test_data/` is gitignored), so you'll need to get your own for
`test_replay.py` and `test_tape.py`. Download them from `https://replay.pokemonshowdown.com/<id>.json`.

## Known limits

- Gen 9 Random Battle only (the engine is built for one generation).
- Replays: unrevealed teammates of the analyzed side are missing, and that side's
  unrevealed moves are guessed.
- Zoroark/Illusion is handled by Foul Play's own logic, but untested here.
- Decisions after a faint (choosing a replacement) aren't analyzed in replays; the
  tape review covers them for your own games. A turn where your Pokémon fainted or
  couldn't move before acting is shown as "didn't act", not graded.
- The win estimate is Foul Play's average search score, not a calibrated probability.
- Recording uses Showdown's classic client (play.pokemonshowdown.com), not the beta client.
