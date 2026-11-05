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

  function seek(turn) {
    const b = location.hostname.startsWith('replay.') ? window.battle : window.app?.curRoom?.battle;
    if (b) b.seekTurn(turn);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.fpo !== 'string') return;
    if (e.data.fpo === 'get') {
      let snap = null;
      try { snap = snapshot(); } catch (err) { snap = { error: String(err) }; }
      window.postMessage({ fpo: 'snap', reqId: e.data.reqId, snap }, '*');
    } else if (e.data.fpo === 'seek') {
      try { seek(e.data.turn); } catch (err) { /* ignore */ }
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

  function pollRooms() {
    hookRequests();
    const rooms = (window.app && window.app.rooms) || {};
    for (const id in rooms) {
      const room = rooms[id];
      if (!room || !room.battle || !id.startsWith('battle-')) continue;
      // Backup for anything the hook missed (e.g. requests received before it was installed)
      if (room.side && room.request) { try { recordRequest(room, room.request); } catch (e) { /* ignore */ } }
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
