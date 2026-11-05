// Talks to the local analysis server, and starts/stops it on demand.
//
// Each tab with FP turned on holds a port named 'fpo-active'. While at least one
// is open we keep a native messaging connection to the host, which runs the
// server. When the last one closes we wait a little (so a page reload doesn't
// restart it), then disconnect, and the host shuts the server down.
const SERVER = 'http://127.0.0.1:8770';
const HOST = 'com.justis.foulplay_overlay';
const STOP_AFTER_MS = 15000;

let nativePort = null;
let ready = false;
let lastError = null;
let waiters = [];
let stopTimer = null;
const clients = new Set();
let tapeBusy = false; // the server is analyzing recorded battles; keep it running

function settle(ok) {
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn(ok));
}

function ensureServer() {
  clearTimeout(stopTimer);
  if (nativePort) return;
  ready = false;
  lastError = null;
  try {
    nativePort = chrome.runtime.connectNative(HOST);
  } catch (e) {
    lastError = String(e);
    nativePort = null;
    settle(false);
    return;
  }
  nativePort.onMessage.addListener((m) => {
    if (m.type === 'ready') { ready = true; settle(true); }
    else if (m.type === 'error') { lastError = m.error; settle(false); }
  });
  nativePort.onDisconnect.addListener(() => {
    lastError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Server stopped.';
    nativePort = null;
    ready = false;
    settle(false);
  });
}

function stopSoonIfUnused() {
  clearTimeout(stopTimer);
  if (clients.size || tapeBusy) return;
  stopTimer = setTimeout(() => {
    if (!clients.size && !tapeBusy && nativePort) {
      nativePort.disconnect();
      nativePort = null;
      ready = false;
    }
  }, STOP_AFTER_MS);
}

async function serverResponds() {
  try {
    const r = await fetch(SERVER + '/health');
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function whenReady() {
  if (ready || (await serverResponds())) return true; // also covers a server started by hand
  ensureServer();
  if (ready) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30000);
    waiters.push((ok) => { clearTimeout(t); resolve(ok); });
  });
}

function startupHint() {
  const e = lastError || '';
  if (/not found|not registered/i.test(e)) return 'Server launcher not registered. Run install-native-host.ps1 once.';
  return 'Could not start the server' + (e ? ': ' + e : '.');
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fpo-active') return;
  clients.add(port);
  ensureServer();
  port.onDisconnect.addListener(() => {
    clients.delete(port);
    stopSoonIfUnused();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'rec') {
    onRecording(msg).catch((e) => console.warn('fpo recording', e));
    return false;
  }
  if (msg.type === 'names') {
    // Name tables for the review page; only rewrite when Showdown's data changed
    chrome.storage.local.get('fpo-names').then((got) => {
      const old = got['fpo-names'];
      const size = (n) => (n ? Object.keys(n.items || {}).length + Object.keys(n.abilities || {}).length : 0);
      if (size(old) !== size(msg)) chrome.storage.local.set({ 'fpo-names': { items: msg.items, abilities: msg.abilities } });
    });
    return false;
  }
  if (msg.type === 'open-review') {
    openReview(msg.id);
    return false;
  }
  if (msg.type === 'ensure') {
    whenReady().then((ok) => sendResponse(ok ? { ok: true } : { ok: false, error: startupHint() }));
    return true;
  }
  if (msg.type === 'analyze') {
    whenReady().then((ok) => {
      if (!ok) { sendResponse({ ok: false, error: startupHint() }); return; }
      fetch(SERVER + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-FPO': '1' },
        body: JSON.stringify(msg.payload),
      })
        .then((r) => r.json())
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: 'Lost the connection to the server.' }));
    });
    return true;
  }
  return false;
});

// ------------------------------------------------------------ battle recordings
//
// page.js sends a copy of every request Showdown gives you in your own battles
// (and the final log). They wait here, in extension storage, until the battle
// is over; only then do they go to the server for analysis. A battle whose tab
// closed early is sent once it has been quiet for half an hour.

const REC = 'rec:';
const ABANDONED_AFTER_MS = 30 * 60 * 1000;
let storageChain = Promise.resolve();

function withStorage(fn) {
  // one read-modify-write at a time
  const run = storageChain.then(fn, fn);
  storageChain = run.catch(() => {});
  return run;
}

async function onRecording(msg) {
  const key = REC + msg.room;
  const rec = await withStorage(async () => {
    const got = await chrome.storage.local.get(key);
    const r = got[key] || { id: msg.room, requests: [], log: [], final: false };
    r.side = msg.side || r.side;
    r.players = msg.players || r.players;
    r.lastUpdate = Date.now();
    if (msg.kind === 'request') {
      if (!r.requests.some((x) => x.request.rqid === msg.request.rqid)) {
        r.requests.push({ request: msg.request, logLen: msg.logLen });
      }
      if (msg.log && msg.log.length >= r.log.length) r.log = msg.log;
    } else if (msg.kind === 'final') {
      if (!got[key]) return null; // a battle we never recorded (e.g. before installing this)
      r.log = msg.log;
      r.final = true;
    }
    await chrome.storage.local.set({ [key]: r });
    return r;
  });
  if (rec && rec.final) await submit(rec);
  else flushStale();
}

const submitting = new Set();
async function submit(rec) {
  if (submitting.has(rec.id)) return;
  submitting.add(rec.id);
  try { await submitOnce(rec); } finally { submitting.delete(rec.id); stopSoonIfUnused(); }
}

async function submitOnce(rec) {
  if (!(await whenReady())) return; // try again later; it stays in storage
  let res;
  try {
    const r = await fetch(SERVER + '/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FPO': '1' },
      body: JSON.stringify({ id: rec.id, side: rec.side, players: rec.players, log: rec.log, requests: rec.requests, lastUpdate: rec.lastUpdate }),
    });
    res = await r.json();
  } catch (e) {
    return;
  }
  if (res.ok || !/in progress/.test(res.error || '')) {
    // Stored on the server (or permanently unusable, e.g. another format): done with it
    await withStorage(() => chrome.storage.local.remove(REC + rec.id));
  }
  if (res.ok) watchQueue();
}

async function flushStale() {
  const all = await chrome.storage.local.get(null);
  for (const [key, rec] of Object.entries(all)) {
    if (!key.startsWith(REC)) continue;
    if (rec.final || Date.now() - (rec.lastUpdate || 0) > ABANDONED_AFTER_MS) await submit(rec);
  }
}

// Keep the server up while it works through recorded battles
let watching = false;
async function watchQueue() {
  tapeBusy = true;
  clearTimeout(stopTimer);
  if (watching) return;
  watching = true;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      let pending = 0;
      try {
        pending = (await (await fetch(SERVER + '/queue')).json()).pending;
      } catch (e) {
        break; // server gone
      }
      if (!pending) break;
    }
  } finally {
    watching = false;
    tapeBusy = false;
    stopSoonIfUnused();
  }
}

function openReview(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL('review.html') + (id ? '#' + id : '') });
}

chrome.action.onClicked.addListener(() => openReview());

// On wake-up: anything left over from a browser restart or a closed tab
setTimeout(flushStale, 3000);
