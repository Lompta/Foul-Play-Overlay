// Foul Play: review the tape. Lists your recorded battles and shows Foul Play's
// verdict on every decision, using the options you actually had.
(() => {
  const SERVER = 'http://127.0.0.1:8770';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');

  let battles = [];
  let current = null; // full battle record being shown
  let open = new Set(); // expanded decision indexes
  let onlyDisagreements = false;
  let pollTimer = null;
  let names = { items: {}, abilities: {} }; // from Showdown's own tables, shared by page.js
  try { chrome.storage.local.get('fpo-names', (v) => { if (v && v['fpo-names']) { names = v['fpo-names']; if (current) renderDecisions(); } }); } catch (e) { /* ignore */ }

  // While this page is open, keep the local server running
  try { chrome.runtime.connect({ name: 'fpo-active' }); } catch (e) { /* ignore */ }

  // Notes on the battle being shown. The card is built once and kept across
  // re-renders, so typing isn't interrupted when analysis progress comes in.
  const notesCard = document.createElement('section');
  notesCard.className = 'card notes';
  notesCard.innerHTML = `<div class="notes-head"><h3>Notes</h3><span id="notes-status" class="muted"></span></div>
    <textarea id="notes" rows="4" placeholder="Your takeaways from this game. Saved as you type."></textarea>`;
  const notesBox = notesCard.querySelector('#notes');
  const notesStatus = notesCard.querySelector('#notes-status');
  let notesFor = null; // battle id the text box holds
  let notesTimer = null;

  async function api(path, opts = {}) {
    const r = await fetch(SERVER + path, { ...opts, headers: { 'X-FPO': '1', 'Content-Type': 'application/json' } });
    return r.json();
  }

  function ensureServer() {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'ensure' }, (res) => resolve(res || { ok: false })));
  }

  // ------------------------------------------------------------ verdicts

  // Verdicts go by win estimate, not search share: within ABOUT_AS_GOOD of
  // Foul Play's top choice is as good as agreeing (repeat searches differ by
  // about that much, and close options are often near-ties).
  const ABOUT_AS_GOOD = 0.03;
  const MISTAKE = 0.1;
  const agrees = (p) => !!p && !p.skipped && p.rank != null && (p.rank === 1 || (p.evalLoss != null && p.evalLoss < ABOUT_AS_GOOD));

  function verdict(p) {
    if (!p) return { cls: 'none', text: 'no choice seen' };
    if (p.skipped) return { cls: 'none', text: "didn't act" };
    if (p.rank == null) return { cls: 'bad', text: 'not considered' };
    if (p.rank === 1) return { cls: 'good', text: 'top choice' };
    if (p.evalLoss == null) return { cls: 'ok', text: 'reasonable' };
    if (p.evalLoss < ABOUT_AS_GOOD) return { cls: 'good', text: 'about as good' };
    if (p.evalLoss >= MISTAKE) return { cls: 'bad', text: 'likely mistake' };
    return { cls: 'ok', text: 'slightly worse' };
  }
  // How an option's win estimate compares with Foul Play's top choice
  const qualityClass = (ev, top) => (ev == null || top == null ? '' : top - ev >= MISTAKE ? 'q-bad' : top - ev >= ABOUT_AS_GOOD ? 'q-meh' : '');
  const tag = (v) => `<span class="tag ${v.cls}">${esc(v.text)}</span>`;
  const isMistake = (d) => d.played && d.played.rank != null && (d.played.evalLoss || 0) >= 0.1;

  // Ladder rank change, for games that start or end in the top 500
  function rankShift(b, long) {
    const l = b.ladder;
    if (!l || (l.before == null && l.after == null)) return '';
    const r = (n) => (n == null ? '500+' : '#' + n);
    const up = l.before == null ? true : l.after == null ? false : l.after < l.before;
    const delta = l.before != null && l.after != null && l.before !== l.after ? ` ${up ? '▲' : '▼'}${Math.abs(l.before - l.after)}` : '';
    const cls = l.before === l.after ? '' : up ? 'up' : 'down';
    const title = `Ladder rank: ${r(l.before)} before, ${r(l.after)} after (read just after the game)`;
    return `<span class="rank ${cls}" title="${esc(title)}">${long ? 'Ladder ' : ''}${r(l.before)} → ${r(l.after)}${delta}</span>`;
  }

  // ------------------------------------------------------------ list

  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function statusText(b) {
    if (b.status === 'done') return b.agreement == null ? 'analyzed' : `${pct(b.agreement)} agree · ${b.mistakes} mistake${b.mistakes === 1 ? '' : 's'}`;
    if (b.status === 'error') return 'analysis failed';
    if (b.progress) return `analyzing ${b.progress.done}/${b.progress.total}`;
    return 'queued';
  }

  function renderList() {
    const sel = location.hash.slice(1);
    if (!battles.length) {
      $('list').innerHTML = '<div class="empty muted" style="padding:0 16px">No recorded battles yet. Play a Gen 9 Random Battle and it will appear here when it ends.</div>';
      return;
    }
    $('list').innerHTML = battles.map((b) => {
      const res = b.result || 'unknown';
      const resText = { win: 'Won', loss: 'Lost', tie: 'Tie', unknown: b.abandoned ? 'Unfinished' : '?' }[res];
      const noted = b.hasNotes ? '<span class="noted" title="Has notes">✎ notes</span>' : '';
      const rating = b.rating ? `${b.rating.after} (${b.rating.after >= b.rating.before ? '+' : ''}${b.rating.after - b.rating.before})` : (b.rated ? 'rated' : 'unrated');
      return `<button class="item ${b.id === sel ? 'on' : ''}" data-id="${esc(b.id)}">
        <div class="row1"><span class="vs">vs ${esc(b.opponent)}</span><span class="res ${res}">${resText}</span></div>
        <div class="row2"><span>${when(b.endedAt)}</span><span>${esc(rating)}</span>${rankShift(b)}<span>${b.turns || 0} turns</span>${noted}</div>
        <div class="row2"><span>${esc(statusText(b))}</span></div>
      </button>`;
    }).join('');
  }

  // ------------------------------------------------------------ detail

  function renderDetail() {
    const b = current;
    if (!b) return;
    const ds = b.decisions || [];
    const judged = ds.filter((d) => d.played && d.played.rank != null);
    const agree = judged.length ? judged.filter((d) => agrees(d.played)).length / judged.length : null;
    const mistakes = ds.filter(isMistake).length;
    const unknown = ds.filter((d) => !d.known).length;
    const resText = { win: 'Won', loss: 'Lost', tie: 'Tie' }[b.result] || (b.abandoned ? 'Unfinished' : '');
    const rating = b.rating ? ` · ${b.rating.before} → ${b.rating.after}` : '';
    const progress = b.status !== 'done' && b.progress
      ? `<div class="card"><div class="sub">Analyzing decision ${b.progress.done} of ${b.progress.total}…</div><div class="progress"><div style="width:${(100 * b.progress.done) / Math.max(1, b.progress.total)}%"></div></div></div>`
      : b.status === 'queued' ? '<div class="card"><div class="sub">Waiting in the analysis queue…</div></div>'
      : b.status === 'error' ? `<div class="card"><div class="sub">Analysis failed: ${esc(b.error)}</div></div>` : '';

    const top = `
      <div class="head">
        <h2>${esc(b.me)} vs ${esc(b.opponent)}</h2>
        <span class="muted">${esc(resText)}${esc(rating)} · ${b.turns} turns · ${when(b.endedAt)}</span>
        ${rankShift(b, true)}
        <div class="actions"><button class="btn" id="reanalyze" title="Run the analysis again (e.g. after changing search settings)">Re-analyze</button></div>
      </div>
      ${progress}
      <div class="tiles">
        <div class="tile"><div class="k" title="Its top choice, or within 3 points of it">Agreed with Foul Play</div><div class="v">${pct(agree)}</div></div>
        <div class="tile"><div class="k">Likely mistakes</div><div class="v">${mistakes}</div></div>
        <div class="tile"><div class="k">Decisions</div><div class="v">${ds.length}</div></div>
        <div class="tile"><div class="k">Start → end estimate</div><div class="v">${pct(ds[0] && ds[0].value)} → ${pct(ds.length ? ds[ds.length - 1].value : null)}</div></div>
      </div>`;
    const rest = `
      <div class="card">
        <h3>Foul Play's win estimate</h3>
        <div class="sub">Its search score before each of your decisions, from your side. A rough guide, not a calibrated probability.</div>
        <div id="chart"></div>
        <div class="legend"><span><i class="l"></i>Win estimate</span><span><i class="m"></i>Likely mistake</span></div>
      </div>
      <div class="card">
        <h3>Every decision</h3>
        <div class="filters"><label><input type="checkbox" id="onlydis" ${onlyDisagreements ? 'checked' : ''}> Only where you were worse than Foul Play's top choice</label></div>
        <div id="decs"></div>
        ${unknown ? `<div class="note">${unknown} decision${unknown === 1 ? '' : 's'} had no recorded options (e.g. the page was reloaded); those were reconstructed from the log.</div>` : ''}
        ${b.settings ? `<div class="note">Search: ${b.settings.searchMs} ms × ${b.settings.worlds} sampled opponent sets per decision.</div>` : ''}
      </div>`;
    if (!$('d-top')) {
      $('detail').innerHTML = '<div id="d-top"></div><div id="d-notes"></div><div id="d-rest"></div>';
      $('d-notes').appendChild(notesCard);
    }
    $('d-top').innerHTML = top;
    $('d-rest').innerHTML = rest;
    $('reanalyze').onclick = async () => { await api(`/battles/${b.id}/reanalyze`, { method: 'POST' }); refresh(); };
    $('onlydis').onchange = (e) => { onlyDisagreements = e.target.checked; renderDecisions(); };
    renderChart();
    renderDecisions();
  }

  function decisionTitle(d) {
    return d.kind === 'switch' ? 'Replacement' : 'Move';
  }

  function renderDecisions() {
    const ds = current.decisions || [];
    const rows = ds.map((d, i) => ({ d, i })).filter(({ d }) => !onlyDisagreements || (d.played && !d.played.skipped && !agrees(d.played)));
    if (!rows.length) { $('decs').innerHTML = `<div class="muted">${ds.length ? 'You agreed with Foul Play on every decision.' : 'Nothing analyzed yet.'}</div>`; return; }
    $('decs').innerHTML = rows.map(({ d, i }) => {
      const v = verdict(d.played);
      const best = d.options && d.options[0];
      const played = d.played
        ? d.played.skipped ? esc(d.played.label) : `You: <b>${esc(d.played.label)}</b>${d.played.rank ? ` <span class="muted">#${d.played.rank}</span>` : ''}`
        : '<span class="muted">No choice found in the log</span>';
      const fp = best && !agrees(d.played) && !(d.played && d.played.skipped) ? ` · FP: <i>${esc(best.label)}</i>` : '';
      return `<div class="dec" id="dec-${i}">
        <button data-i="${i}" aria-expanded="${open.has(i)}">
          <span class="when"><b>T${d.turn}</b>${decisionTitle(d)}</span>
          <span class="what"><div class="pl">${played}${fp} ${tag(v)}</div><div class="mu">${esc(d.user || '')} vs ${esc(d.opponent || '')}${d.known ? '' : ' · options reconstructed'}</div></span>
          <span class="wp" title="Win estimate before this decision">${pct(d.value)}</span>
        </button>
        ${open.has(i) ? decisionBody(d) : ''}
      </div>`;
    }).join('');
  }

  // ------------------------------------------------------------ position

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  const itemName = (id) => names.items[id] || cap(id);
  const abilityName = (id) => names.abilities[id] || cap(id);
  const STATUS = { brn: 'BRN', par: 'PAR', slp: 'SLP', frz: 'FRZ', psn: 'PSN', tox: 'TOX' };

  function hpBar(m, big) {
    const cls = m.hp > 50 ? 'hi' : m.hp > 20 ? 'mid' : 'lo';
    return `<span class="hpbar ${big ? 'big' : ''}" title="${m.hp}% HP"><span class="${cls}" style="width:${m.hp}%"></span></span>`;
  }

  function hpText(m) {
    if (m.fainted) return '<span class="muted">fainted</span>';
    const exact = m.hpExact && m.hpExact[1] ? ` <span class="muted">${m.hpExact[0]}/${m.hpExact[1]}</span>` : '';
    return `${m.hp}%${exact}`;
  }

  function itemText(m, mine) {
    if (m.item === null) return mine ? '' : '<span class="muted">item ?</span>';
    if (m.item === '') return '<span class="muted">no item</span>';
    return esc(itemName(m.item)) + (m.itemInferred ? ' <span class="muted">(inferred)</span>' : '');
  }

  function details(m, mine) {
    const bits = [];
    const it = itemText(m, mine);
    if (it) bits.push(it);
    if (m.ability) bits.push(esc(abilityName(m.ability)));
    else if (!mine) bits.push('<span class="muted">ability ?</span>');
    if (m.tera) bits.push(m.terastallized ? `<b>Tera ${esc(cap(m.tera))}</b>` : `Tera ${esc(cap(m.tera))}`);
    return bits.join(' · ');
  }

  function moveList(m, mine) {
    if (!m.moves.length) return mine ? '' : '<span class="muted">no moves seen</span>';
    return m.moves.map((mv) => `<span class="mv">${esc(mv.name)}${mine && mv.maxpp ? ` <span class="muted">${mv.pp}/${mv.maxpp}</span>` : ''}</span>`).join('');
  }

  function statusChip(s) {
    return `<span class="chip st st-${esc(s)}">${STATUS[s] || esc(s)}</span>`;
  }

  function activeCard(m, mine) {
    if (!m) return '';
    const chips = [];
    if (m.status) chips.push(statusChip(m.status));
    for (const [k, v] of Object.entries(m.boosts || {})) chips.push(`<span class="chip ${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v} ${esc(k)}</span>`);
    for (const v of m.volatiles || []) chips.push(`<span class="chip">${esc(v)}</span>`);
    const types = (m.terastallized && m.tera ? [m.tera] : m.types).map((t) => `<span class="type">${esc(cap(t))}</span>`).join('');
    return `<div class="active">
      <div class="nm"><b>${esc(m.name)}</b> <span class="muted">L${m.level}</span> ${types}</div>
      <div class="hpline">${hpBar(m, true)}<span class="hpnum">${hpText(m)}</span></div>
      ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
      <div class="det">${details(m, mine)}</div>
      <div class="moves">${moveList(m, mine)}</div>
    </div>`;
  }

  function benchRow(m, mine) {
    const st = m.status && !m.fainted ? ' ' + statusChip(m.status) : '';
    const moves = m.moves.map((mv) => esc(mv.name)).join(', ');
    return `<div class="bench ${m.fainted ? 'fnt' : ''}">
      <div class="bl"><span class="bn">${esc(m.name)}</span>${hpBar(m)}<span class="hpnum">${m.fainted ? 'fainted' : m.hp + '%'}</span>${st}</div>
      <div class="bd muted">${[details(m, mine), moves].filter(Boolean).join(' · ') || (mine ? '' : 'nothing revealed')}</div>
    </div>`;
  }

  function sideView(side, label, mine) {
    const [active, ...bench] = side.team;
    const unrevealed = side.unrevealed ? `<div class="bench muted">+ ${side.unrevealed} not yet seen</div>` : '';
    const conds = side.conditions.length ? ` <span class="conds">${side.conditions.map((c) => `<span class="chip haz">${esc(c)}</span>`).join('')}</span>` : '';
    return `<div class="side">
      <h4>${esc(label)}${conds}</h4>
      ${activeCard(active, mine)}
      ${bench.map((m) => benchRow(m, mine)).join('')}${unrevealed}
    </div>`;
  }

  function positionView(state) {
    if (!state) return '';
    const field = state.field.length ? `<div class="fieldline">${state.field.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div>` : '';
    return `<div class="pos">
      ${field}
      <div class="sides">${sideView(state.me, 'You', true)}${sideView(state.opp, current.opponent || 'Opponent', false)}</div>
      <div class="note">The position before this decision, as you knew it. The opponent's side shows only what had been revealed, plus anything Foul Play deduced.</div>
    </div>`;
  }

  // ------------------------------------------------------------ Showdex

  const toID = (s) => String(s || '').normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  // What Showdex showed for this option while you were deciding, if anything.
  // Its numbers are for Tera only when its Tera toggle was on, so they label
  // either the Tera options or the plain ones, never both.
  function showdexFor(d, o) {
    const sd = d.showdex;
    if (!sd || !sd.moves || o.choice.startsWith('switch ')) return null;
    if (/-tera$/.test(o.choice) !== !!sd.tera) return null;
    const id = toID(o.choice.replace(/-tera$/, ''));
    const m = sd.moves.find((x) => toID(x.move) === id);
    if (!m) return null;
    const text = m.ko || (/%/.test(m.damage) ? m.damage : m.damage === 'IMMUNE' ? 'immune' : '');
    if (!text) return null;
    const vs = sd.vs ? ` vs ${sd.vs}` : '';
    return `<span class="ko" title="${esc(`Showdex: ${m.damage || '–'}${m.ko ? ' · ' + m.ko : ''}${vs}`)}">(${esc(text)})</span>`;
  }

  function showdexNote(d) {
    const sd = d.showdex;
    if (!sd) return '';
    const off = sd.vs && d.opponent && toID(sd.vs) !== toID(d.opponent)
      ? ` Showdex was calculating against ${esc(sd.vs)}, not the active ${esc(d.opponent)}.` : '';
    return `<div class="note">In brackets: what Showdex showed while you decided${sd.tera ? ', with Tera' : ''}${sd.vs && !off ? `, vs ${esc(sd.vs)}` : ''}.${off}</div>`;
  }

  function decisionBody(d) {
    if (d.error) return `<div class="body"><div class="note">Couldn't analyze this one: ${esc(d.error)}</div></div>`;
    const pc = d.played && d.played.choice;
    const top = d.options && d.options[0] && d.options[0].eval;
    const opts = (d.options || []).slice(0, 8).map((o) => {
      const isPlayed = pc && (o.choice === pc || o.choice === pc.replace(/-tera$/, ''));
      const ko = showdexFor(d, o);
      return `<div class="opt ${isPlayed ? 'played' : ''} ${qualityClass(o.eval, top)}"><span class="bar" style="width:${o.eval == null ? 0 : Math.max(1, o.eval * 100)}%"></span>
        <span class="lab">${esc(o.label)}${ko ? ' ' + ko : ''}</span>
        <span class="num" title="Foul Play's win estimate if you pick this">${pct(o.eval)}</span>
        <span class="sh" title="Share of Foul Play's search spent on this option">${pct(o.share)} of search</span></div>`;
    }).join('');
    const happened = (d.happened || []).map((h) => `<li>${esc(h)}</li>`).join('');
    const pos = d.state ? positionView(d.state) : '<div class="pos note">Position not available yet; it gets filled in shortly after the server starts.</div>';
    return `<div class="body">
      ${pos}
      <div><h4>Foul Play's options</h4>${opts}<div class="note">Bar and number: Foul Play's win estimate for each option; red ones are well below its top choice. Small: how much of its search went to it. Outlined: what you did.</div>
      ${showdexNote(d)}
      ${d.warning ? `<div class="note">Note: ${esc(d.warning)}.</div>` : ''}</div>
      <div><h4>What happened</h4>${happened ? `<ul class="happened">${happened}</ul>` : '<div class="muted">–</div>'}</div>
    </div>`;
  }

  // ------------------------------------------------------------ chart

  function renderChart() {
    const el = $('chart');
    if (!el) return;
    const ds = (current.decisions || []).map((d, i) => ({ d, i })).filter(({ d }) => d.value != null);
    const W = el.clientWidth, H = el.clientHeight;
    const m = { l: 34, r: 10, t: 8, b: 22 };
    const n = (current.decisions || []).length;
    if (!ds.length || W < 50) { el.innerHTML = '<div class="muted" style="padding-top:80px;text-align:center">No estimates yet.</div>'; return; }
    const x = (i) => m.l + (n <= 1 ? 0.5 : i / (n - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - v) * (H - m.t - m.b);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1" ${v === 0.5 ? 'stroke-dasharray="4 3"' : ''}/>
      <text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join('');
    // x labels: a handful of turn numbers
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l) / 60))));
    const xl = (current.decisions || []).map((d, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">T${d.turn}</text>` : '')).join('');
    const path = ds.map(({ d, i }, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
    const marks = ds.filter(({ d }) => isMistake(d)).map(({ d, i }) => `<circle cx="${x(i)}" cy="${y(d.value)}" r="5" fill="var(--bad-mark)" stroke="var(--surface)" stroke-width="2"/>`).join('');
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Win estimate by decision">
      ${grid}${xl}
      <path d="${path}" fill="none" stroke="var(--line)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${marks}
      <line id="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>
      <circle id="xd" r="4" fill="var(--line)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
      <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" id="hit" style="cursor:pointer"/>
    </svg>`;
    const nearest = (evt) => {
      const r = el.getBoundingClientRect();
      const px = evt.clientX - r.left;
      let best = ds[0];
      for (const p of ds) if (Math.abs(x(p.i) - px) < Math.abs(x(best.i) - px)) best = p;
      return best;
    };
    const hit = el.querySelector('#hit'), xh = el.querySelector('#xh'), xd = el.querySelector('#xd'), tip = $('tip');
    hit.onmousemove = (evt) => {
      const { d, i } = nearest(evt);
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
      xd.setAttribute('cx', x(i)); xd.setAttribute('cy', y(d.value)); xd.setAttribute('visibility', 'visible');
      const v = verdict(d.played);
      tip.innerHTML = `<div><b>Turn ${d.turn}</b> · ${decisionTitle(d)} · <b>${pct(d.value)}</b></div>
        <div>${d.played ? esc(d.played.label) : '–'} ${tag(v)}</div>
        ${d.options && d.options[0] && !(d.played && (agrees(d.played) || d.played.skipped)) ? `<div class="muted">FP: ${esc(d.options[0].label)}</div>` : ''}`;
      tip.hidden = false;
      const tx = Math.min(evt.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = tx + 'px';
      tip.style.top = evt.clientY + 14 + 'px';
    };
    hit.onmouseleave = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); };
    hit.onclick = (evt) => {
      const { i } = nearest(evt);
      onlyDisagreements = false;
      const cb = $('onlydis'); if (cb) cb.checked = false;
      open.add(i);
      renderDecisions();
      const row = $('dec-' + i);
      if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200); }
    };
  }

  // ------------------------------------------------------------ data

  async function loadSelected() {
    const id = location.hash.slice(1);
    if (!id) { current = null; return; }
    const res = await api('/battles/' + encodeURIComponent(id));
    if (!res.ok) {
      current = null;
      $('detail').innerHTML = `<div class="empty"><p>${esc(res.error || 'Not found')}.</p><p class="muted">If you just finished this game, it may still be on its way: recordings are sent when the battle ends.</p></div>`;
      return;
    }
    const prev = current && current.id === res.battle.id ? current : null;
    if (!prev) open = new Set();
    if (notesFor !== res.battle.id) {
      notesFor = res.battle.id;
      notesBox.value = res.battle.notes || '';
      notesStatus.textContent = '';
    }
    // keep scroll position stable when only progress changed
    const states = (b) => (b.decisions || []).filter((d) => d.state).length;
    const changed = !prev || prev.status !== res.battle.status || (prev.decisions || []).length !== (res.battle.decisions || []).length || states(prev) !== states(res.battle);
    current = res.battle;
    if (changed) renderDetail();
  }

  async function refresh() {
    clearTimeout(pollTimer);
    try {
      const res = await api('/battles');
      battles = res.battles || [];
      $('server').textContent = res.pending ? `Analyzing… ${res.pending} battle${res.pending === 1 ? '' : 's'} in the queue` : '';
      renderList();
      await loadSelected();
      const busy = res.pending || (current && current.status !== 'done' && current.status !== 'error');
      pollTimer = setTimeout(refresh, busy ? 3000 : 15000);
    } catch (e) {
      $('server').textContent = 'Lost the connection to the local server; retrying…';
      pollTimer = setTimeout(start, 3000);
    }
  }

  async function start() {
    $('server').textContent = 'Starting the local Foul Play server…';
    const ok = await ensureServer();
    if (!ok.ok) { $('server').textContent = ok.error || 'Could not start the server.'; pollTimer = setTimeout(start, 5000); return; }
    $('server').textContent = '';
    refresh();
  }

  async function saveNotes(keepalive) {
    clearTimeout(notesTimer);
    notesTimer = null;
    const id = notesFor, text = notesBox.value;
    if (!id) return;
    notesStatus.textContent = 'Saving…';
    try {
      const res = await api(`/battles/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ notes: text }), keepalive });
      if (notesFor === id) notesStatus.textContent = res.ok ? 'Saved' : `Couldn't save: ${res.error || 'unknown error'}`;
      const b = battles.find((x) => x.id === id);
      if (res.ok && b && b.hasNotes !== !!text.trim()) { b.hasNotes = !!text.trim(); renderList(); }
    } catch (e) {
      if (notesFor === id) notesStatus.textContent = "Couldn't save: the local server isn't reachable. Your text is still here.";
    }
  }
  notesBox.addEventListener('input', () => {
    notesStatus.textContent = 'Editing…';
    clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotes, 700);
  });
  notesBox.addEventListener('blur', () => { if (notesTimer) saveNotes(); });
  window.addEventListener('beforeunload', () => { if (notesTimer) saveNotes(true); });

  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (b) location.hash = b.dataset.id;
  });
  $('detail').addEventListener('click', (e) => {
    const b = e.target.closest('.dec > button');
    if (!b) return;
    const i = Number(b.dataset.i);
    if (open.has(i)) open.delete(i); else open.add(i);
    renderDecisions();
  });
  window.addEventListener('hashchange', () => {
    if (notesTimer) saveNotes(); // still for the battle being left
    current = null;
    renderList();
    loadSelected();
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => current && renderChart(), 100); });

  start();
})();
