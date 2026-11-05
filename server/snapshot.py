"""
A plain-JSON picture of a position, from the reviewing player's side: what the
board looked like at a decision, as Foul Play understood it.

Your side is exact (it comes from Showdown's request). The opponent's side is
what had been revealed so far, plus anything Foul Play deduced (marked
"inferred"). Items and abilities are ids ("heavydutyboots"); the review page
turns them into names with Showdown's own tables.
"""

from fp import constants
from fp.data import all_move_json

SIDE_CONDITIONS = {
    "stealthrock": "Stealth Rock",
    "spikes": "Spikes",
    "toxicspikes": "Toxic Spikes",
    "stickyweb": "Sticky Web",
    "reflect": "Reflect",
    "lightscreen": "Light Screen",
    "auroraveil": "Aurora Veil",
    "tailwind": "Tailwind",
    "safeguard": "Safeguard",
    "mist": "Mist",
    "luckychant": "Lucky Chant",
}
STACKING = {"spikes", "toxicspikes"}
WEATHER = {
    "sunnyday": "Sun", "raindance": "Rain", "sandstorm": "Sandstorm", "sand": "Sandstorm",
    "hail": "Hail", "snow": "Snow", "snowscape": "Snow",
    "desolateland": "Harsh sun", "primordialsea": "Heavy rain", "deltastream": "Strong winds",
}
TERRAIN = {
    "electricterrain": "Electric Terrain", "grassyterrain": "Grassy Terrain",
    "mistyterrain": "Misty Terrain", "psychicterrain": "Psychic Terrain",
}
BOOST_ORDER = ["attack", "defense", "special-attack", "special-defense", "speed", "accuracy", "evasion"]
BOOST_SHORT = {"attack": "Atk", "defense": "Def", "special-attack": "SpA", "special-defense": "SpD", "speed": "Spe", "accuracy": "Acc", "evasion": "Eva"}
# Volatile statuses worth showing; Foul Play tracks many internal ones too
VOLATILES = {
    "substitute": "Substitute", "leechseed": "Leech Seed", "confusion": "Confused", "taunt": "Taunt",
    "encore": "Encore", "partiallytrapped": "Trapped", "yawn": "Drowsy", "perishsong": "Perish Song",
    "curse": "Cursed", "torment": "Torment", "disable": "Disabled", "throatchop": "Throat Chop",
    "slowstart": "Slow Start", "protosynthesis": "Protosynthesis", "quarkdrive": "Quark Drive",
    "flashfire": "Flash Fire", "focusenergy": "Focus Energy", "saltcure": "Salt Cure",
    "charge": "Charged", "magnetrise": "Magnet Rise", "aquaring": "Aqua Ring", "ingrain": "Ingrain",
    "healblock": "Heal Block", "embargo": "Embargo", "glaiverush": "Glaive Rush", "roost": "Roosting",
}


def _mon(pkmn, names: dict, mine: bool, active: bool) -> dict:
    hp_pct = 0 if pkmn.hp <= 0 else max(1, round(100 * pkmn.hp / max(pkmn.max_hp, 1)))
    out = {
        "name": names.get(pkmn.name, names.get(pkmn.base_name, pkmn.name)),
        "level": pkmn.level,
        "hp": hp_pct,
        "fainted": pkmn.hp <= 0,
        "status": pkmn.status,
        "types": list(pkmn.types or []),
        "tera": pkmn.tera_type,
        "terastallized": bool(pkmn.terastallized),
    }
    if mine:
        out["hpExact"] = [int(pkmn.hp), int(pkmn.max_hp)]
    item = pkmn.item
    if item == constants.UNKNOWN_ITEM:
        out["item"] = None  # not revealed
    else:
        out["item"] = item or ""  # "" = no item (knocked off, consumed...)
        if not mine and getattr(pkmn, "item_inferred", False):
            out["itemInferred"] = True
    out["ability"] = pkmn.ability or None
    out["moves"] = [
        {
            "name": all_move_json.get(m.name, {}).get("name", m.name),
            **({"pp": m.current_pp, "maxpp": m.max_pp} if mine else {}),
        }
        for m in pkmn.moves
    ]
    if active:
        out["boosts"] = {BOOST_SHORT[k]: v for k in BOOST_ORDER if (v := pkmn.boosts.get(k, 0))}
        out["volatiles"] = sorted({VOLATILES[v] for v in pkmn.volatile_statuses if v in VOLATILES})
    return out


def _side(battler, names: dict, mine: bool, teamsize: int) -> dict:
    team = []
    if battler.active is not None:
        team.append(_mon(battler.active, names, mine, active=True))
    team += [_mon(p, names, mine, active=False) for p in battler.reserve]
    conditions = []
    for key, label in SIDE_CONDITIONS.items():
        n = battler.side_conditions.get(key, 0)
        if n:
            conditions.append(f"{label} ×{n}" if key in STACKING and n > 1 else label)
    if battler.wish and battler.wish[0]:
        conditions.append("Wish")
    if battler.future_sight and battler.future_sight[0]:
        conditions.append("Future Sight")
    return {
        "team": team,
        "unrevealed": max(0, teamsize - len(team)) if not mine else 0,
        "conditions": conditions,
    }


def snapshot(battle, names: dict, teamsizes: dict) -> dict:
    field = []
    if battle.weather:
        field.append(WEATHER.get(battle.weather, battle.weather))
    if battle.field:
        field.append(TERRAIN.get(battle.field, battle.field))
    if battle.trick_room:
        field.append("Trick Room")
    if battle.gravity:
        field.append("Gravity")
    return {
        "field": field,
        "me": _side(battle.user, names, True, teamsizes.get(battle.user.name, 6)),
        "opp": _side(battle.opponent, names, False, teamsizes.get(battle.opponent.name, 6)),
    }


def teamsizes(log: list[str]) -> dict:
    out = {}
    for line in log:
        parts = line.split("|")
        if len(parts) > 3 and parts[1] == "teamsize" and parts[3].isdigit():
            out[parts[2]] = int(parts[3])
    return out
