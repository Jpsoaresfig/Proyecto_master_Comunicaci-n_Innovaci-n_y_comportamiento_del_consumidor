// BASS CHALLENGE — servidor mínimo (Node.js puro, sin dependencias)
// Sirve los archivos de /public y sincroniza el estado con long-polling.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

const STAGES = ['lobby', 'elegir', 'r1', 'res1', 'r2', 'res2', 'r3', 'final', 'bass'];
const PRODUCTS = ['watch', 'pods', 'holo'];

// ---------- Estado ----------
let state = {
  key: crypto.randomBytes(4).toString('hex'), // clave del presentador
  stage: 'lobby',
  participants: {}, // id -> { name, product, votes: [null,null,null], t }
};
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && saved.key && STAGES.includes(saved.stage)) state = saved;
} catch (_) {}

let version = 1;
let publicUrl = process.env.PUBLIC_URL || null;
let waiters = [];
let flushTimer = null;
let saveTimer = null;

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
    }
  }
  // Prioriza redes Wi-Fi/LAN típicas (192.168.x, 10.x, 172.16-31.x) frente a adaptadores virtuales/VPN.
  const rank = (u) => (/\/\/192\.168\./.test(u) && !/\/\/192\.168\.56\./.test(u) ? 0 : /\/\/10\./.test(u) ? 1 : /\/\/172\.(1[6-9]|2\d|3[01])\./.test(u) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

function snapshot() {
  return {
    version,
    stage: state.stage,
    participants: state.participants,
    publicUrl,
    lanUrls: lanUrls(),
  };
}

function changed() {
  version++;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const body = JSON.stringify(snapshot());
    const list = waiters;
    waiters = [];
    for (const w of list) { clearTimeout(w.timer); sendRaw(w.res, 200, body); }
  }, 80);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
      fs.writeFile(DATA_FILE, JSON.stringify(state), () => {});
    });
  }, 300);
}

// ---------- Utilidades HTTP ----------
function sendRaw(res, code, body, type = 'application/json; charset=utf-8') {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => sendRaw(res, code, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/presentador') urlPath = '/presentador.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendRaw(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return sendRaw(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
const adoptedRound = (p) => p.votes.findIndex((v) => v === true); // -1 si no adoptó

// ---------- API ----------
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/state' && req.method === 'GET') {
    const v = Number(url.searchParams.get('v')) || 0;
    if (v !== version) return sendJson(res, 200, snapshot());
    const w = { res, timer: setTimeout(() => {
      waiters = waiters.filter((x) => x !== w);
      sendJson(res, 200, snapshot());
    }, 25000) };
    waiters.push(w);
    req.on('close', () => { clearTimeout(w.timer); waiters = waiters.filter((x) => x !== w); });
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 404, { error: 'no encontrado' });
  const body = await readBody(req);
  const id = String(body.id || '').slice(0, 40);

  if (route === '/api/join') {
    const name = cleanName(body.name);
    if (!id || !name) return sendJson(res, 400, { error: 'Apodo inválido' });
    const p = state.participants[id];
    if (p) p.name = name;
    else state.participants[id] = { name, product: null, votes: [null, null, null], t: Date.now() };
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/choose') {
    const p = state.participants[id];
    if (!p) return sendJson(res, 404, { error: 'Participante no encontrado' });
    if (!PRODUCTS.includes(body.product)) return sendJson(res, 400, { error: 'Producto inválido' });
    const stageIdx = STAGES.indexOf(state.stage);
    // Se puede cambiar libremente durante "elegir"; después solo quien aún no eligió (llegó tarde).
    if (stageIdx < 1 || (p.product && state.stage !== 'elegir')) return sendJson(res, 409, { error: 'Ya no se puede cambiar' });
    p.product = body.product;
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/vote') {
    const p = state.participants[id];
    const round = Number(body.round); // 1, 2 o 3
    if (!p || !p.product) return sendJson(res, 404, { error: 'Participante no encontrado' });
    if (state.stage !== 'r' + round) return sendJson(res, 409, { error: 'Esta ronda no está abierta' });
    const a = adoptedRound(p);
    if (a !== -1 && a < round - 1) return sendJson(res, 409, { error: 'Ya compraste' });
    if (p.votes[round - 1] !== null) return sendJson(res, 409, { error: 'Ya respondiste' });
    p.votes[round - 1] = !!body.buy;
    changed();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/admin') {
    if (body.key !== state.key) return sendJson(res, 403, { error: 'Clave de presentador inválida' });
    const i = STAGES.indexOf(state.stage);
    if (body.action === 'next' && i < STAGES.length - 1) state.stage = STAGES[i + 1];
    else if (body.action === 'prev' && i > 0) state.stage = STAGES[i - 1];
    else if (body.action === 'reset') {
      state.stage = 'lobby';
      state.participants = {};
    }
    changed();
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'no encontrado' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => sendJson(res, 500, { error: 'error interno' }));
  } else {
    serveStatic(req, res, decodeURIComponent(url.pathname));
  }
});

// ---------- Túnel público opcional (Cloudflare Quick Tunnel, gratuito y sin cuenta) ----------
function startTunnel() {
  if (publicUrl || process.env.NO_TUNNEL) return;
  const local = path.join(__dirname, 'cloudflared.exe');
  const bin = fs.existsSync(local) ? local : 'cloudflared';
  let child;
  try {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  } catch (_) { return; }
  child.on('error', () => {
    console.log('  (cloudflared no está instalado: los móviles deben usar la misma red Wi-Fi)\n');
  });
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !publicUrl) {
      publicUrl = m[0];
      console.log(`  Enlace PÚBLICO para los móviles:  ${publicUrl}\n`);
      changed();
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const stop = () => { try { child.kill(); } catch (_) {} process.exit(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

server.listen(PORT, () => {
  const presenter = `http://localhost:${PORT}/presentador?key=${state.key}`;
  console.log('\n  ==========  BASS CHALLENGE  ==========\n');
  console.log(`  Panel del presentador:  ${presenter}`);
  for (const u of lanUrls()) console.log(`  Enlace en red local:    ${u}`);
  console.log('');
  startTunnel();
  if (!process.env.NO_OPEN) exec(process.platform === 'win32' ? `start "" "${presenter}"` : `xdg-open "${presenter}"`);
});
