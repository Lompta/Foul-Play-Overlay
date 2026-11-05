// Foul Play Overlay: the panel. Asks page.js for the battle being viewed,
// decides whether analysis is allowed, and shows Foul Play's ranking.
//
// Allowed: replays (rated or not), ended battles, and unrated live battles.
// Not allowed: live rated battles until they end.

(() => {
  const DEFAULTS = { enabled: false, searchMs: 1500, worlds: 8, scanMs: 500, scanWorlds: 6 };
  let settings = { ...DEFAULTS };
  let perspective = null; // 'p1' | 'p2', for replays and spectating
  let lastKey = null;
  let inFlight = false;
  let pendingSnap = null;
  let lastResult = null;
  let scan = null; // { running, cancel, rows, done, total }
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
  function seekTurn(turn) { window.postMessage({ fpo: 'seek', turn }, '*'); }

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

  // ------------------------------------------------------------ replay scan

  async function runScan() {
    const s = await getSnapshot();
    if (!s || !(s.kind === 'replay' || s.kind === 'ended')) return;
    const turnLines = s.log.map((l, i) => (l.startsWith('|turn|') ? i : -1)).filter((i) => i >= 0);
    const names = { p1: s.players[0] || 'p1', p2: s.players[1] || 'p2' };
    scan = { running: true, cancel: false, rows: [], done: 0, total: turnLines.length * 2 };
    renderScan();
    for (const idx of turnLines) {
      for (const side of ['p1', 'p2']) {
        if (scan.cancel) break;
        const res = await analyze({ log: s.log, side, upTo: idx + 1, searchMs: settings.scanMs, worlds: settings.scanWorlds });
        scan.done++;
        if (res && res.ok && res.played && !res.played.skipped && res.options && res.options.length) {
          scan.rows.push({
            turn: res.turn,
            side,
            player: names[side],
            played: res.played,
            best: res.options[0],
            score: res.played.evalLoss != null ? res.played.evalLoss : res.played.surprise,
          });
        }
        renderScan();
      }
      if (scan.cancel) break;
    }
    scan.running = false;
    renderScan();
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
        <label>Scan: <input id="fpo-scanms" type="number" min="100" step="100"> ms × <input id="fpo-scanworlds" type="number" min="1" max="32"> worlds</label>
      </div>
      <div id="fpo-body"></div>
      <div id="fpo-scanbar" hidden><button id="fpo-scan">Scan replay for surprises</button></div>
      <div id="fpo-scan-out"></div>
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
    $('fpo-scanbar').hidden = !(snap && (snap.kind === 'replay' || snap.kind === 'ended'));
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
    const loss = played.evalLoss;
    if (loss != null && loss >= 0.1) return '<span class="fpo-tag bad">likely mistake</span>';
    if (played.surprise >= 0.3) return '<span class="fpo-tag warn">surprising</span>';
    return '<span class="fpo-tag ok">reasonable</span>';
  }

  function renderResult(res, p) {
    if (!res.ok) { renderStatus(res.error || 'Analysis failed.'); return; }
    const playedChoice = res.played && res.played.choice;
    const rows = res.options.slice(0, 6).map((o) => {
      const isPlayed = playedChoice && (o.choice === playedChoice || o.choice === playedChoice.replace(/-tera$/, ''));
      return `<div class="fpo-opt ${isPlayed ? 'played' : ''}">
        <div class="fpo-bar" style="width:${Math.max(2, o.share * 100)}%"></div>
        <span class="fpo-label">${esc(o.label)}</span>
        <span class="fpo-num">${pct(o.share)}</span>
        <span class="fpo-eval" title="Foul Play's average search score for this choice (higher is better)">${o.eval == null ? '' : o.eval.toFixed(2)}</span>
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

  function renderScan() {
    const out = $('fpo-scan-out');
    if (!scan) { out.innerHTML = ''; return; }
    const top = [...scan.rows].filter((r) => r.played.rank !== 1).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 15);
    const progress = scan.running
      ? `<div class="fpo-sub">Scanning ${scan.done}/${scan.total} <button id="fpo-scan-cancel">Stop</button></div>`
      : `<div class="fpo-sub">Scan done · biggest disagreements first</div>`;
    out.innerHTML = progress + top.map((r) => `
      <div class="fpo-scanrow" data-turn="${r.turn}" data-side="${r.side}" title="Jump to this turn">
        <span class="fpo-t">T${r.turn}</span>
        <span class="fpo-who">${esc(r.player)}</span>
        <span class="fpo-what">${esc(r.played.label)} → <i>${esc(r.best.label)}</i></span>
        ${verdict(r.played)}
      </div>`).join('');
    const c = out.querySelector('#fpo-scan-cancel');
    if (c) c.onclick = () => { scan.cancel = true; };
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
    if (sideBtn) { perspective = sideBtn.dataset.side; lastKey = null; tick(); return; }
    const row = e.target.closest('.fpo-scanrow');
    if (row) { perspective = row.dataset.side; lastKey = null; seekTurn(Number(row.dataset.turn)); setTimeout(tick, 400); }
  });
  $('fpo-review').onclick = (e) => {
    try { chrome.runtime.sendMessage({ type: 'open-review', id: e.target.dataset.id || '' }); } catch (err) { /* extension reloaded */ }
  };
  $('fpo-scan').onclick = () => { if (!scan || !scan.running) runScan(); };
  for (const [id, key] of [['fpo-ms', 'searchMs'], ['fpo-worlds', 'worlds'], ['fpo-scanms', 'scanMs'], ['fpo-scanworlds', 'scanWorlds']]) {
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
    $('fpo-scanms').value = settings.scanMs;
    $('fpo-scanworlds').value = settings.scanWorlds;
    applyEnabled();
  });

  setInterval(tick, 1000);
})();
