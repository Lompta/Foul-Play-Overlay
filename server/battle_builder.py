"""
Rebuild a Foul Play `Battle` from a Showdown battle log.

Two cases:
- Live, as a player: we have the request JSON, which describes our own team
  exactly. That's what Foul Play itself uses.
- Replay or spectating: no request. We reconstruct the chosen side's team from
  everything it reveals over the whole log (the player knew their own team, so
  hindsight about it is fair), fill in the rest from the random battle set
  data, and write a request JSON for it. Unrevealed teammates are left out.
"""

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass

from fp import constants
from fp.battle import protocol
from fp.battle.helpers import normalize_name
from fp.battle.protocol import process_battle_updates
from fp.battle.state import Battle, Battler, LastUsedMove, Pokemon
from fp.config import FoulPlayConfig
from fp.data import all_move_json
from fp.search.helpers import populate_pkmn_from_set

STAT_KEYS = {v: k for k, v in constants.STAT_ABBREVIATION_LOOKUPS.items()}


@dataclass
class Built:
    battle: Battle
    synthetic: bool  # True when our own team was reconstructed rather than known


def other_side(side: str) -> str:
    return "p2" if side == "p1" else "p1"


def new_battle(mode, user_side: str) -> Battle:
    battle = Battle("fpo")
    battle.pokemon_format = FoulPlayConfig.pokemon_format
    battle.generation = battle.format_spec.generation
    battle.battle_type = battle.format_spec.battle_type
    battle.mode = mode
    battle.user.name = user_side
    battle.opponent.name = other_side(user_side)
    battle.started = True
    return battle


def clean_log(log: list[str]) -> list[str]:
    # Drop chat and timer noise, and resolve |split| blocks to their public line
    out = []
    skip = 0
    for line in log:
        if skip:
            skip -= 1
            if skip == 0:  # second line of a split block is the public one
                out.append(line)
            continue
        if line.startswith("|split|"):
            skip = 2
            continue
        if line.startswith(("|c|", "|c:|", "|chat|", "|raw|", "|html|", "|j|", "|l|", "|n|", "|inactive")):
            continue
        out.append(line)
    return out


def after_start(log: list[str]) -> list[str]:
    for i, line in enumerate(log):
        if line == "|start":
            return log[i + 1 :]
    return []


def selected_move(battle: Battle, chunk: list[str]) -> LastUsedMove:
    """
    The live bot remembers what it chose each turn, and Foul Play's speed inference
    relies on that. Here we read it off the log. If our side never got to act
    (fainted first), assume an ordinary priority-0 move.
    """
    for line in chunk:
        parts = line.split("|")
        if len(parts) < 4 or not parts[2].startswith(battle.user.name + "a"):
            continue
        if parts[1] == "move" and not any(p.startswith("[from]") for p in parts[4:]):
            return LastUsedMove(normalize_name(parts[2].split(":", 1)[1]), normalize_name(parts[3]), battle.turn)
        if parts[1] == "switch":
            return LastUsedMove("", "switch " + normalize_name(parts[3].split(",")[0]), battle.turn)
    return LastUsedMove("", "tackle", battle.turn)


_vendor_illusion_end = protocol.illusion_end


def illusion_end(battle: Battle, split_msg: list[str]):
    """
    Foul Play only unmasks the *opponent's* Zoroark on |replace|: the live bot gets
    a fresh request every turn that fixes up its own side. We replay our side from
    the log, so without this, everything the disguised Zoroark did lands on the
    Pokemon it was posing as (a fifth move, which crashes the engine, and its damage).
    """
    if protocol.is_opponent(battle, split_msg):
        return _vendor_illusion_end(battle, split_msg)
    unmask(battle.user, Pokemon.from_switch_string(split_msg[3]).name)
    if battle.user.active is not None:
        battle.user.active.zoroark_disguised_as = None


def unmask(side: Battler, real_name: str):
    """Make `real_name` (in reserve) the active Pokemon in place of the one it was posing as."""
    disguised = side.active
    real = next((p for p in side.reserve if p.name == real_name), None)
    if disguised is None or real is None or disguised.name == real_name:
        return
    # What happened since the switch happened to Zoroark, not the mon it posed as
    hp_fraction = disguised.hp / disguised.max_hp if disguised.max_hp else 1
    real.hp = hp_fraction * real.max_hp
    real.boosts, real.status = disguised.boosts, disguised.status
    for mv in disguised.moves_used_since_switch_in:
        disguised.remove_move(mv)
        if real.get_move(mv) is None:
            real.add_move(mv)
    disguised.hp = disguised.hp_at_switch_in
    disguised.status = disguised.status_at_switch_in
    side.reserve.remove(real)
    side.reserve.append(disguised)
    side.active = real


def unmask_from_request(battle: Battle, request: dict):
    """
    Our Zoroark switches in under another name, and the log won't say otherwise
    until |replace|. The request does: if it has an Illusion user active where the
    log shows someone else, it's in disguise.
    """
    for p in request.get("side", {}).get("pokemon", []):
        if p.get("active"):
            if normalize_name(p.get("baseAbility") or p.get("ability") or "") == "illusion":
                unmask(battle.user, normalize_name(p.get("details", "").split(",")[0]))
            return


# process_battle_updates looks its handlers up by name on every call
protocol.illusion_end = illusion_end


def process_by_turn(battle: Battle, lines: list[str]):
    # Foul Play processes one turn's worth of messages at a time
    chunk = []
    for line in lines:
        chunk.append(line)
        if line.startswith("|turn|"):
            battle.user.last_selected_move = selected_move(battle, chunk)
            battle.msg_list = chunk
            process_battle_updates(battle)
            chunk = []
    if chunk:
        battle.user.last_selected_move = selected_move(battle, chunk)
        battle.msg_list = chunk
        process_battle_updates(battle)


@contextmanager
def no_inference():
    """
    In the hindsight pass the *other* side has placeholder stats, so damage and
    speed based set inference would be wrong. Keep only what was revealed outright.
    """
    names = ["check_speed_ranges", "update_dataset_possibilities", "check_choicescarf"]
    saved = {n: getattr(protocol, n) for n in names}
    # Form changes on the placeholder side re-read a request JSON it doesn't have
    reinit = Battler.re_initialize_active_pokemon_from_request_json

    def reinit_if_known(self, request_json):
        if request_json is not None:
            reinit(self, request_json)

    try:
        for n in names:
            setattr(protocol, n, lambda *a, **k: None)
        Battler.re_initialize_active_pokemon_from_request_json = reinit_if_known
        yield
    finally:
        for n, f in saved.items():
            setattr(protocol, n, f)
        Battler.re_initialize_active_pokemon_from_request_json = reinit


def init_user_from_request(battle: Battle, request: dict):
    battle.user.initialize_first_turn_user_from_json(request)
    # Start with nobody active; the log's first switch puts the lead in
    if battle.user.active is not None:
        battle.user.reserve.insert(0, battle.user.active)
        battle.user.active = None
    battle.request_json = request


def finish_with_request(battle: Battle, request: dict):
    battle.request_json = request
    battle.rqid = request.get(constants.RQID)
    battle.force_switch = bool(request.get(constants.FORCE_SWITCH))
    battle.wait = bool(request.get(constants.WAIT))


# ---------------------------------------------------------------- replays


def reconstruct_team(log_after_start: list[str], side: str, mode) -> list[Pokemon]:
    # Process the whole log with `side` as the "opponent", so Foul Play records
    # everything that side reveals, then fill each mon in with its likeliest set
    hindsight = new_battle(mode, other_side(side))
    with no_inference():
        process_by_turn(hindsight, log_after_start)

    team = []
    revealed = list(hindsight.opponent.reserve)
    if hindsight.opponent.active is not None:
        revealed.insert(0, hindsight.opponent.active)
    for seen in revealed:
        # The form it switched in as (Morpeko, not Morpeko-Hangry), which is
        # what the request JSON would list
        pkmn = Pokemon(seen.base_name, seen.level)
        pkmn.nickname = seen.nickname
        pkmn.moves = deepcopy(seen.moves)
        pkmn.ability = seen.ability
        pkmn.item = seen.item
        pkmn.tera_type = seen.tera_type
        sets = mode.datasets.get_all_remaining_sets(seen)
        if sets:
            best = max(sets, key=lambda s: s.pkmn_set.count)
            populate_pkmn_from_set(pkmn, best)
        if pkmn.item == constants.UNKNOWN_ITEM:
            pkmn.item = None
        team.append(pkmn)
    return team


def synthetic_request(team: list[Pokemon], side: str, now=None) -> dict:
    """A request JSON for `team`. `now` is the processed Battler, for current HP/status/active."""
    current = {}
    active_name = None
    if now is not None:
        for p in now.reserve + ([now.active] if now.active else []):
            current[p.name] = p
            current[p.base_name] = p
        active_name = now.active.base_name if now.active else None

    pokemon = []
    active_entry = None
    for pkmn in team:
        fresh = Pokemon(pkmn.name, pkmn.level)
        max_hp = fresh.max_hp
        cur = current.get(pkmn.name)
        hp = max_hp
        status = None
        if cur is not None and cur.max_hp:
            hp = round(max_hp * cur.hp / cur.max_hp) if cur.hp > 0 else 0
            status = cur.status
        condition = "0 fnt" if hp <= 0 else f"{hp}/{max_hp}" + (f" {status}" if status else "")
        is_active = pkmn.name == active_name
        moves = [m.name for m in pkmn.moves]
        pokemon.append(
            {
                "ident": f"{side}: {pkmn.nickname or pkmn.name}",
                "details": f"{pkmn.name}, L{pkmn.level}",
                "condition": condition,
                "active": is_active,
                "stats": {STAT_KEYS[k]: v for k, v in fresh.stats.items() if k in STAT_KEYS},
                "moves": moves,
                "baseAbility": pkmn.ability or "",
                "ability": pkmn.ability or "",
                "item": pkmn.item or "",
            }
        )
        if pkmn.tera_type:
            pokemon[-1]["teraType"] = pkmn.tera_type.capitalize()
        if is_active and hp > 0 and cur is not None:
            locked = None
            last = now.last_used_move
            if cur.item in constants.CHOICE_ITEMS and last.pokemon_name == cur.name and last.move in moves:
                locked = last.move
            active_entry = {
                "moves": [
                    {
                        "move": all_move_json.get(m, {}).get("name", m),
                        "id": m,
                        "pp": all_move_json.get(m, {}).get("pp", 10),
                        "maxpp": all_move_json.get(m, {}).get("pp", 10),
                        "disabled": locked is not None and m != locked,
                    }
                    for m in moves
                ],
                "canTerastallize": None if any(p.terastallized for p in current.values()) else pokemon[-1].get("teraType"),
            }

    request = {"side": {"id": side, "pokemon": pokemon}, "rqid": 1}
    if active_entry is not None:
        request["active"] = [active_entry]
    elif now is not None and now.active is not None and now.active.hp <= 0:
        request["forceSwitch"] = [True]
    return request


# ---------------------------------------------------------------- entry point


def build_battle(log: list[str], side: str, request: dict | None, mode, full_log: list[str] | None = None) -> Built:
    """`log` is the battle up to the position to analyze; `full_log` (replays) is all of it."""
    lines = after_start(clean_log(log))

    if request is not None:
        battle = new_battle(mode, side)
        init_user_from_request(battle, request)
        process_by_turn(battle, lines)
        unmask_from_request(battle, request)
        finish_with_request(battle, request)
        return Built(battle, synthetic=False)

    team = reconstruct_team(after_start(clean_log(full_log or log)), side, mode)
    battle = new_battle(mode, side)
    init_user_from_request(battle, synthetic_request(team, side))
    process_by_turn(battle, lines)
    finish_with_request(battle, synthetic_request(team, side, now=battle.user))
    return Built(battle, synthetic=True)
