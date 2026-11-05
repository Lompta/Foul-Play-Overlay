"""What a player actually chose, read off the battle log, and how Foul Play rated it."""


def next_action(rest: list[str], side: str) -> dict | None:
    """
    What `side` actually chose this turn, as a Foul Play choice string.

    Returns a dict with `skipped` set when the side never got to act on its choice
    (fainted first, flinched, fully paralyzed, dragged out...). A replacement sent
    in after fainting is a separate decision, not this turn's choice.
    """
    from fp.battle.helpers import normalize_name

    tera = False
    for line in rest:
        parts = line.split("|")
        if len(parts) < 3:
            continue
        if parts[1] in ("turn", "win", "tie"):
            return None
        if not parts[2].startswith(side + "a"):
            continue
        if parts[1] == "-terastallize":
            tera = True
        elif parts[1] == "move" and len(parts) > 3:
            # moves called by other moves or abilities aren't choices
            if any(p.startswith("[from]") for p in parts[4:]):
                continue
            return {"choice": normalize_name(parts[3]) + ("-tera" if tera else ""), "label": parts[3] + (" + Tera" if tera else "")}
        elif parts[1] == "switch" and len(parts) > 3:
            name = parts[3].split(",")[0]
            return {"choice": "switch " + normalize_name(name), "label": "Switch to " + name}
        elif parts[1] == "faint":
            return {"choice": None, "label": "Fainted before it could move", "skipped": True}
        elif parts[1] == "drag":
            return {"choice": None, "label": "Dragged out before it could move", "skipped": True}
        elif parts[1] == "cant":
            reason = parts[3] if len(parts) > 3 else ""
            return {"choice": None, "label": "Couldn't move" + (f" ({reason})" if reason else ""), "skipped": True}
    return None


def rank_played(played: dict | None, options: list[dict]) -> dict | None:
    """Where the move actually played ranks among Foul Play's options."""
    if played is None or played.get("skipped") or not options:
        return played
    names = [o["choice"] for o in options]
    choice = played["choice"]
    if choice not in names and choice.endswith("-tera") and choice.removesuffix("-tera") in names:
        choice = choice.removesuffix("-tera")
    if choice not in names:
        # Foul Play names forms differently in places (e.g. "switch sawsbuckautumn")
        choice = next((n for n in names if n.startswith(choice) or choice.startswith(n)), choice)
    if choice in names:
        i = names.index(choice)
        played.update(rank=i + 1, share=options[i]["share"], eval=options[i]["eval"])
        best = options[0]
        played["surprise"] = round(best["share"] - options[i]["share"], 4)
        if best["eval"] is not None and options[i]["eval"] is not None:
            played["evalLoss"] = round(best["eval"] - options[i]["eval"], 4)
    else:
        played.update(rank=None, share=0.0, surprise=options[0]["share"])
    return played


def display_names(log: list[str], requests: list[dict] = ()) -> dict:
    """Foul Play's internal species names ("ironvaliant") -> how Showdown shows them, from the log and your requests."""
    from fp.battle.helpers import normalize_name

    names = {}
    for r in requests:
        for p in ((r or {}).get("side") or {}).get("pokemon") or []:
            species = str(p.get("details", "")).split(",")[0]
            if species:
                names[normalize_name(species)] = species
    for line in log:
        parts = line.split("|")
        if len(parts) > 3 and parts[1] in ("switch", "drag", "detailschange", "replace", "poke"):
            species = parts[3].split(",")[0]
            names[normalize_name(species)] = species
    return names


def prettify(result: dict, names: dict) -> dict:
    """Use proper species names in a search result's labels."""
    def fix(text):
        if not isinstance(text, str):
            return text
        if text.startswith("Switch to "):
            rest = text[len("Switch to "):]
            tera = rest.endswith(" + Tera")
            base = rest.removesuffix(" + Tera")
            return "Switch to " + names.get(base, base[:1].upper() + base[1:]) + (" + Tera" if tera else "")
        return names.get(text, text)

    for o in result.get("options") or []:
        o["label"] = fix(o["label"])
    for k in ("user", "opponent"):
        if k in result:
            result[k] = fix(result[k])
    return result
