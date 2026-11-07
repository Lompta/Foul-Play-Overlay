// Runs in the Showdown page itself (MAIN world), where the battle objects live.
// Answers the overlay's requests for a snapshot of the battle being viewed, and
// records your own battles for review afterwards (see recordBattles below).
(() => {
  function players(b) {
    return [b.p1 && b.p1.name, b.p2 && b.p2.name];
  }

  function snapshot() {
    // replay.pokemonshowdown.com exposes the battle as window.battle
    if (location.hostname.startsWith('replay.') && window.battle) {
      const b = window.battle;
      return {
        kind: 'replay',
        id: location.pathname,
        log: b.stepQueue.slice(),
        upTo: b.currentStep,
        turn: b.turn,
        players: players(b),
        rated: !!b.rated,
        ended: true,
      };
    }

    const app = window.app;
    const room = app && app.curRoom;
    if (!room || !room.battle) return null;
    const b = room.battle;
    const ended = !!(b.ended || room.battleEnded);
    return {
      kind: ended ? 'ended' : 'live',
      id: room.id,
      side: room.side || '',
      request: room.request ? JSON.parse(JSON.stringify(room.request)) : null,
      log: b.stepQueue.slice(),
      // after a battle ends, Instant Replay / turn seeking moves currentStep
      upTo: ended ? b.currentStep : null,
      turn: b.turn,
      players: players(b),
      rated: !!b.rated,
      ended,
    };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.fpo !== 'string') return;
    if (e.data.fpo === 'get') {
      let snap = null;
      try { snap = snapshot(); } catch (err) { snap = { error: String(err) }; }
      window.postMessage({ fpo: 'snap', reqId: e.data.reqId, snap }, '*');
    }
  });

  // ------------------------------------------------------------ recording
  //
  // For battles you play, Showdown sends a "request" before each decision: your
  // exact team, moves, HP and legal options. We keep a copy of each one (and
  // the log when the battle ends) so the tape review knows what you knew.
  // Nothing is analyzed or shown during the battle; content.js just hands the
  // data to the background worker, which sends it on once the battle is over.

  if (location.hostname.startsWith('replay.')) return;

  const seenRqids = new Map(); // room id -> Set of rqids sent
  const finished = new Set();
  const sideOf = new Map(); // room id -> 'p1' | 'p2', in case the room forgets it

  function post(msg) { window.postMessage({ fpo: 'rec', ...msg }, '*'); }

  function recordRequest(room, request) {
    if (!room || !room.battle || !request || !request.side || !request.side.id) return;
    const rqid = request.rqid;
    let seen = seenRqids.get(room.id);
    if (!seen) seenRqids.set(room.id, (seen = new Set()));
    if (seen.has(rqid)) return;
    seen.add(rqid);
    sideOf.set(room.id, request.side.id);
    post({
      type: 'request',
      room: room.id,
      side: request.side.id,
      players: players(room.battle),
      logLen: room.battle.stepQueue.length,
      // the log so far, in case the tab closes before the battle ends
      log: room.battle.stepQueue.slice(),
      request: JSON.parse(JSON.stringify(request)),
    });
  }

  function hookRequests() {
    const BR = window.BattleRoom;
    if (!BR || !BR.prototype || BR.prototype.__fpoHooked) return !!(BR && BR.prototype && BR.prototype.__fpoHooked);
    const orig = BR.prototype.receiveRequest;
    BR.prototype.receiveRequest = function (request, choiceText) {
      try { recordRequest(this, request); } catch (e) { /* never break the client */ }
      return orig.apply(this, arguments);
    };
    BR.prototype.__fpoHooked = true;
    return true;
  }

  // ------------------------------------------------------------ Showdex
  //
  // If the Showdex extension is open on a battle, it shows damage ranges and
  // KO chances for your active Pokémon's moves. We copy what it shows, for each
  // decision, so the review can label options with them ("Discharge (2HKO)").
  // This only reads Showdex's table; nothing is shown during the battle. Its
  // markup uses CSS-module class names like "PokeMoves-module-container--Um1rb",
  // so we match on the stable prefix.

  const toID = (s) => String(s || '').normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const q = (el, mod) => el.querySelector(`[class*="${mod}"]`);
  const lastCalc = new Map(); // room id -> last calc sent, as JSON

  function calcdexRoots(room) {
    // Showdex renders either over the battle (inside its room) or in its own
    // "view-calcdex-<battle id>" panel
    const roots = [];
    const panel = window.app.rooms['view-calcdex-' + toID(room.id)];
    if (panel && panel.el) roots.push(panel.el);
    if (room.el) roots.push(room.el);
    return roots;
  }

  function nameLabel(playerCalc) {
    const el = q(playerCalc, 'PokeInfo-module-nameLabel');
    return el ? el.textContent.trim() : null;
  }

  function readShowdex(room, request, myName) {
    const active = request.active && request.active[0];
    if (!active || !Array.isArray(active.moves)) return null;
    const legal = new Set(active.moves.map((m) => toID(m.id || m.move)));
    for (const root of calcdexRoots(room)) {
      const calcs = [...root.querySelectorAll('[class*="PlayerCalc-module-container"]')];
      const mine = calcs.find((pc) => {
        const who = q(pc, 'PlayerInfo-module-usernameButtonLabel');
        return who && toID(who.textContent) === toID(myName);
      });
      if (!mine) continue;
      const table = q(mine, 'PokeMoves-module-container');
      if (!table || /PokeMoves-module-editor-/.test(table.className)) return null;
      const kids = [...table.children];
      const moves = [];
      for (let i = 0; i < kids.length; i++) {
        const dd = q(kids[i], 'Dropdown-module-container');
        if (!dd) continue;
        const nm = q(dd, 'Dropdown-module-singleValue');
        const dmg = kids[i + 1], ko = kids[i + 2];
        if (!nm || !dmg || !ko || q(ko, 'Dropdown-module-container')) continue;
        const label = q(dmg, 'PokeMoves-module-damageButtonLabel');
        moves.push({ move: nm.textContent.trim(), damage: label ? label.textContent.trim() : '', ko: ko.textContent.trim() });
        i += 2;
      }
      // Only trust it when it's showing your active Pokémon's actual moves
      if (!moves.length || !moves.every((m) => legal.has(toID(m.move)))) return null;
      const teraBtn = [...table.querySelectorAll('[class*="PokeMoves-module-ultButton"]')]
        .find((b) => q(b, 'PokeMoves-module-teraButtonLabel'));
      const opp = calcs.find((pc) => pc !== mine);
      return {
        mon: nameLabel(mine),
        vs: opp ? nameLabel(opp) : null,
        tera: !!(active.canTerastallize && teraBtn && /ToggleButton-module-active/.test(teraBtn.className)),
        moves,
      };
    }
    return null;
  }

  function recordShowdex(room) {
    const r = room.request;
    if (!r || r.wait || r.teamPreview || r.forceSwitch || !r.side || room.battleEnded || room.battle.ended) return;
    const names = players(room.battle);
    const myName = names[r.side.id === 'p1' ? 0 : 1] || r.side.name;
    const calc = readShowdex(room, r, myName);
    if (!calc) return;
    // The last reading before the next request is the one you saw while deciding
    const key = JSON.stringify([r.rqid, calc]);
    if (lastCalc.get(room.id) === key) return;
    lastCalc.set(room.id, key);
    post({ type: 'calc', room: room.id, side: r.side.id, rqid: r.rqid, calc });
  }

  function pollRooms() {
    hookRequests();
    const rooms = (window.app && window.app.rooms) || {};
    for (const id in rooms) {
      const room = rooms[id];
      if (!room || !room.battle || !id.startsWith('battle-')) continue;
      // Backup for anything the hook missed (e.g. requests received before it was installed)
      if (room.side && room.request) { try { recordRequest(room, room.request); } catch (e) { /* ignore */ } }
      if (room.side) { try { recordShowdex(room); } catch (e) { /* never break the client */ } }
      const side = room.side || sideOf.get(id);
      if ((room.battleEnded || room.battle.ended) && side && !finished.has(id)) {
        finished.add(id);
        post({ type: 'final', room: id, side, players: players(room.battle), log: room.battle.stepQueue.slice() });
      }
    }
  }

  // Item and ability names ("heavydutyboots" -> "Heavy-Duty Boots") for the
  // review page, from the tables Showdown already loaded
  function shareNames() {
    const items = window.BattleItems, abilities = window.BattleAbilities;
    if (!items || !abilities) return false;
    const pick = (t) => { const o = {}; for (const id in t) if (t[id] && t[id].name) o[id] = t[id].name; return o; };
    post({ type: 'names', items: pick(items), abilities: pick(abilities) });
    return true;
  }
  let namesTries = 0;
  const namesTimer = setInterval(() => { if (shareNames() || ++namesTries > 30) clearInterval(namesTimer); }, 2000);

  hookRequests();
  setInterval(pollRooms, 1000);
})();
