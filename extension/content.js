// Foul Play Overlay: the panel. Asks page.js for the battle being viewed,
// decides whether analysis is allowed, and shows Foul Play's ranking.
//
// Allowed: replays (rated or not), ended battles, and unrated live battles.
// Not allowed: live rated battles until they end.

(() => {
  const DEFAULTS = { enabled: false, searchMs: 1500, worlds: 8 };
  let settings = { ...DEFAULTS };
  let perspective = null; // 'p1' | 'p2', for replays and spectating
  let lastKey = null;
  let inFlight = false;
  let pendingSnap = null;
  let lastResult = null;
  let snap = null;
  let firstRun = true;

  // ------------------------------------------------------------ page bridge

  let reqCounter = 0;
  const waiting = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    // Your own battles, recorded for the tape review; the background worker
    // holds them until the battle is over
    if (e.data.fpo === 'rec' && e.data.type === 'names') {
      try { chrome.runtime.sendMessage({ type: 'names', items: e.data.items, abilities: e.data.abilities }); } catch (err) { /* extension reloaded */ }
      return;
    }
    if (e.data.fpo === 'rec' && location.hostname === 'play.pokemonshowdown.com') {
      try { chrome.runtime.sendMessage({ ...e.data, type: 'rec', kind: e.data.type, fpo: undefined }); } catch (err) { /* extension reloaded */ }
      return;
    }
    if (e.data.fpo !== 'snap') return;
    const resolve = waiting.get(e.data.reqId);
    if (resolve) { waiting.delete(e.data.reqId); resolve(e.data.snap); }
  });
  function getSnapshot() {
    return new Promise((resolve) => {
      const reqId = ++reqCounter;
      waiting.set(reqId, resolve);
      window.postMessage({ fpo: 'get', reqId }, '*');
      setTimeout(() => { if (waiting.delete(reqId)) resolve(null); }, 1000);
    });
  }

  function analyze(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'analyze', payload }, (res) => resolve(res || { ok: false, error: 'No response' }));
      } catch (err) {
        resolve({ ok: false, error: 'Extension reloaded; refresh this page.' });
      }
    });
  }

  // ------------------------------------------------------------ battle logic

  function tierOf(log) {
    const line = log.find((l) => l.startsWith('|tier|'));
    return line ? line.slice(6) : '';
  }

  function lastTurnLineBefore(log, upTo) {
    for (let i = Math.min(upTo, log.length) - 1; i >= 0; i--) if (log[i].startsWith('|turn|')) return i;
    return -1;
  }

  // Decide what (if anything) to analyze for this snapshot
  function plan(s) {
    if (!s || !s.log) return { status: 'Open a battle or replay.' };
    if (s.error) return { status: 'Page error: ' + s.error };
    if (!s.log.some((l) => l === '|start')) return { status: 'Waiting for the battle to start.' };
    if (tierOf(s.log) !== '[Gen 9] Random Battle') return { status: 'Only Gen 9 Random Battles are supported.' };

    if (s.kind === 'live' && s.rated) {
      return { status: 'Off during live rated battles. It turns on when this one ends, or in the replay.', blocked: true };
    }

    if (s.kind === 'live' && s.side && s.request) {
      const r = s.request;
      if (r.wait || r.teamPreview) return { status: 'Waiting for your turn.' };
      return {
        live: true,
        side: s.side,
        key: `live:${s.id}:${r.rqid}:${s.log.length}`,
        payload: { log: s.log, side: s.side, request: r, searchMs: settings.searchMs, worlds: settings.worlds },
      };
    }

    // Replays, ended battles and spectating: pick a perspective
    const side = perspective || s.side || 'p1';
    const upTo = s.upTo == null ? s.log.length : s.upTo;
    const cut = lastTurnLineBefore(s.log, upTo);
    if (cut < 0) return { status: 'Step to turn 1 or later.', side, replayish: true };
    return {
      side,
      replayish: true,
      key: `replay:${s.id}:${side}:${cut}`,
      payload: { log: s.log, side, upTo: cut + 1, searchMs: settings.searchMs, worlds: settings.worlds },
    };
  }

  async function tick() {
    if (!settings.enabled) return;
    snap = await getSnapshot();
    const p = plan(snap);
    renderHeader(p);
    if (!p.key) { if (p.status) renderStatus(p.status); lastKey = null; return; }
    if (p.key === lastKey) return;
    if (inFlight) { pendingSnap = p; return; }
    run(p);
  }

  async function run(p) {
    inFlight = true;
    lastKey = p.key;
    renderStatus(firstRun ? 'Starting Foul Play…' : 'Thinking…');
    firstRun = false;
    const res = await analyze(p.payload);
    inFlight = false;
    if (lastKey === p.key) { lastResult = { res, plan: p }; renderResult(res, p); }
    if (pendingSnap && pendingSnap.key !== p.key) { const next = pendingSnap; pendingSnap = null; run(next); }
    else pendingSnap = null;
  }

  // ------------------------------------------------------------ UI

  const root = document.createElement('div');
  root.id = 'fpo-root';
  root.innerHTML = `
    <button id="fpo-toggle" title="Foul Play Overlay">FP</button>
    <div id="fpo-panel" hidden>
      <div id="fpo-head">
        <span id="fpo-title">Foul Play</span>
        <span id="fpo-persp"></span>
        <button id="fpo-gear" title="Settings">⚙</button>
      </div>
      <div id="fpo-settings" hidden>
        <label>Search per world <input id="fpo-ms" type="number" min="100" step="100"> ms</label>
        <label>Sampled worlds <input id="fpo-worlds" type="number" min="1" max="32"></label>
      </div>
      <div id="fpo-body"></div>
      <div id="fpo-foot"><button id="fpo-review" class="fpo-link">Review my games ↗</button></div>
    </div>`;
  document.documentElement.appendChild(root);
  const $ = (id) => root.querySelector('#' + id);

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }

  function renderHeader(p) {
    const persp = $('fpo-persp');
    // Your own finished battle: the tape review has your real options for every turn
    const mine = snap && snap.kind === 'ended' && snap.side && /^battle-/.test(snap.id || '');
    $('fpo-review').textContent = mine ? 'Full review of this game ↗' : 'Review my games ↗';
    $('fpo-review').dataset.id = mine ? snap.id.replace(/^battle-/, '') : '';
    if (p && p.replayish && snap && snap.players) {
      const side = p.side;
      persp.innerHTML = ['p1', 'p2']
        .map((sd, i) => `<button class="fpo-side ${sd === side ? 'on' : ''}" data-side="${sd}">${esc(snap.players[i] || sd)}</button>`)
        .join('');
    } else if (p && p.live) {
      persp.textContent = 'you';
    } else {
      persp.textContent = '';
    }
  }

  function renderStatus(text) {
    $('fpo-body').innerHTML = `<div class="fpo-status">${esc(text)}</div>`;
  }

  function verdict(played) {
    if (played && played.skipped) return '';
    if (!played || played.rank == null) return played ? '<span class="fpo-tag bad">not considered</span>' : '';
    if (played.rank === 1) return '<span class="fpo-tag good">top choice</span>';
    // By win estimate, like the review page: within 3 points counts as agreeing
    const loss = played.evalLoss;
    if (loss == null) return '<span class="fpo-tag ok">reasonable</span>';
    if (loss < 0.03) return '<span class="fpo-tag good">about as good</span>';
    if (loss >= 0.1) return '<span class="fpo-tag bad">likely mistake</span>';
    return '<span class="fpo-tag ok">slightly worse</span>';
  }

  function renderResult(res, p) {
    if (!res.ok) { renderStatus(res.error || 'Analysis failed.'); return; }
    const playedChoice = res.played && res.played.choice;
    const top = res.options[0] && res.options[0].eval;
    const rows = res.options.slice(0, 6).map((o) => {
      const isPlayed = playedChoice && (o.choice === playedChoice || o.choice === playedChoice.replace(/-tera$/, ''));
      const q = o.eval == null || top == null ? '' : top - o.eval >= 0.1 ? 'q-bad' : top - o.eval >= 0.03 ? 'q-meh' : '';
      return `<div class="fpo-opt ${isPlayed ? 'played' : ''} ${q}">
        <div class="fpo-bar" style="width:${o.eval == null ? 0 : Math.max(2, o.eval * 100)}%"></div>
        <span class="fpo-label">${esc(o.label)}</span>
        <span class="fpo-num" title="Foul Play's win estimate if you pick this">${pct(o.eval)}</span>
        <span class="fpo-eval" title="Share of Foul Play's search spent on this option">${pct(o.share)}</span>
      </div>`;
    }).join('');
    let playedLine = '';
    if (res.played) {
      playedLine = res.played.skipped
        ? `<div class="fpo-played fpo-skipped">${esc(res.played.label)}, so there's no choice to grade this turn.</div>`
        : `<div class="fpo-played">Played: <b>${esc(res.played.label)}</b> ${res.played.rank ? `(#${res.played.rank})` : ''} ${verdict(res.played)}</div>`;
    }
    const note = res.synthetic ? '<div class="fpo-note">Own team rebuilt from the replay; unrevealed teammates are left out.</div>' : '';
    $('fpo-body').innerHTML = `
      <div class="fpo-sub">Turn ${res.turn} · ${esc(res.user)} vs ${esc(res.opponent)}</div>
      ${rows}
      ${playedLine}
      <div class="fpo-meta">${res.worlds} worlds · ${res.iterations.toLocaleString()} sims · ${(res.ms / 1000).toFixed(1)}s</div>
      ${note}`;
  }

  // events
  $('fpo-toggle').onclick = () => {
    settings.enabled = !settings.enabled;
    save();
    applyEnabled();
  };
  $('fpo-gear').onclick = () => { $('fpo-settings').hidden = !$('fpo-settings').hidden; };
  root.addEventListener('click', (e) => {
    const sideBtn = e.target.closest('.fpo-side');
    if (sideBtn) { perspective = sideBtn.dataset.side; lastKey = null; tick(); }
  });
  $('fpo-review').onclick = (e) => {
    try { chrome.runtime.sendMessage({ type: 'open-review', id: e.target.dataset.id || '' }); } catch (err) { /* extension reloaded */ }
  };
  for (const [id, key] of [['fpo-ms', 'searchMs'], ['fpo-worlds', 'worlds']]) {
    $(id).onchange = (e) => { const v = Number(e.target.value); if (v > 0) { settings[key] = v; save(); lastKey = null; } };
  }

  // While FP is on in this tab, hold a port to the background worker; that's
  // what keeps the server running. Closing the tab drops it automatically.
  let activePort = null;
  function holdServer(on) {
    if (on && !activePort) {
      try {
        activePort = chrome.runtime.connect({ name: 'fpo-active' });
        activePort.onDisconnect.addListener(() => {
          activePort = null;
          // the background worker restarted; reconnect if we still want the server
          if (settings.enabled) setTimeout(() => holdServer(settings.enabled), 1000);
        });
      } catch (e) { activePort = null; /* extension reloaded; page needs a refresh */ }
    } else if (!on && activePort) {
      const p = activePort;
      activePort = null;
      p.disconnect();
    }
  }

  function applyEnabled() {
    $('fpo-panel').hidden = !settings.enabled;
    $('fpo-toggle').classList.toggle('on', settings.enabled);
    holdServer(settings.enabled);
    if (settings.enabled) { lastKey = null; tick(); }
  }

  function save() { try { chrome.storage.local.set({ fpo: settings }); } catch (e) { /* page outlived extension */ } }

  chrome.storage.local.get('fpo', (v) => {
    settings = { ...DEFAULTS, ...(v && v.fpo) };
    $('fpo-ms').value = settings.searchMs;
    $('fpo-worlds').value = settings.worlds;
    applyEnabled();
  });

  setInterval(tick, 1000);
})();
