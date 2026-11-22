// BASS CHALLENGE — lógica compartida (productos, sincronización, estadísticas, utilidades)

export const STAGES = ['lobby', 'r1', 'res1', 'r2', 'res2', 'r3', 'final', 'bass'];
export const STAGE_LABELS = ['Entrada', 'Ronda 1', 'Resultados', 'Ronda 2', 'Resultados', 'Ronda 3', 'Final', 'Modelo de Bass'];

const ICONS = {
  watch: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6l.6-3h4.8l.6 3M9 18l.6 3h4.8l.6-3M12 9.5V12l1.6 1.2"/></svg>',
  pods: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4a3 3 0 0 0-3 3v3a3 3 0 0 0 3 3h.5v6.5a1.5 1.5 0 0 0 3 0V7a3 3 0 0 0-3-3z"/><path d="M16.5 4a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H16v6.5a1.5 1.5 0 0 1-3 0V7a3 3 0 0 1 3-3z"/></svg>',
  holo: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l6 3.5v7L12 17l-6-3.5v-7z"/><path d="M12 10l6-3.5M12 10L6 6.5M12 10v7"/><path d="M8 21h8M12 17v4"/></svg>',
};

export const PRODUCTS = [
  { id: 'watch', name: 'SmartWatch X', desc: 'Reloj inteligente', price: '€199', color: '#3987e5' },
  { id: 'pods', name: 'SoundPods', desc: 'Auriculares con traducción simultánea', price: '€149', color: '#d95926' },
  { id: 'holo', name: 'HoloMini', desc: 'Proyector holográfico portátil', price: '€299', color: '#199e70' },
].map((p) => ({ ...p, icon: ICONS[p.id] }));
export const productById = (id) => PRODUCTS.find((p) => p.id === id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);

// Primera ronda en la que el participante dijo "sí" (0,1,2) o -1.
export const adoptedRound = (p) => p.votes.findIndex((v) => v === true);

// ---------- Reglas del juego (compartidas por ambos modos) ----------
export function canChoose(state, p) {
  // Se elige en la entrada (y se puede cambiar); después solo quien aún no eligió (llegó tarde).
  return state.stage === 'lobby' || !p.product;
}
export function canVote(state, p, round) {
  if (!p || !p.product || state.stage !== 'r' + round) return false;
  const a = adoptedRound(p);
  // Mientras la ronda está abierta se puede responder y cambiar la respuesta.
  return !(a !== -1 && a < round - 1);
}

function normalize(raw) {
  raw = raw || {};
  const participants = {};
  for (const [id, p] of Object.entries(raw.participants || {})) {
    if (!p || !p.name) continue;
    const votes = Array.isArray(p.votes) ? p.votes.slice(0, 3) : [p.v1, p.v2, p.v3];
    participants[id] = {
      name: p.name, product: p.product || null, t: p.t || 0,
      votes: [0, 1, 2].map((k) => (typeof votes[k] === 'boolean' ? votes[k] : null)),
    };
  }
  return {
    stage: STAGES.includes(raw.stage) ? raw.stage : 'lobby',
    participants,
    publicUrl: raw.publicUrl || null,
    lanUrls: raw.lanUrls || [],
    me: raw.me || null,               // uid del participante (modo Firebase)
    sessionId: raw.sessionId || null, // id de la sesión (modo Firebase)
    noSession: !!raw.noSession,
  };
}

// ---------- Sincronización ----------
// Modo "firebase" (Vercel + Cloud Firestore) si config.js trae la configuración; si no, "local" (node server.js).
// role: 'presenter' | 'participant'
export async function connect(onState, { key, role = 'participant' } = {}) {
  const cfg = window.BASS_FIREBASE;
  return cfg ? connectFirestore(cfg, onState, role) : connectLocal(onState, key);
}

function connectLocal(onState, key) {
  let v = 0;
  let current = normalize();
  (async function loop() {
    for (;;) {
      try {
        const r = await fetch('/api/state?v=' + v, { cache: 'no-store' });
        const s = await r.json();
        v = s.version;
        current = normalize(s);
        onState(current);
      } catch (_) {
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  })();
  const post = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Error de conexión');
    return j;
  };
  return {
    mode: 'local',
    join: (id, name) => post('/api/join', { id, name }),
    choose: (id, product) => post('/api/choose', { id, product }),
    vote: (id, round, buy) => post('/api/vote', { id, round, buy }),
    admin: (action) => post('/api/admin', { key, action }),
  };
}

// Cloud Firestore:
//   sessions/{sid}                     { owner, stage, createdAt }      <- solo el presentador (owner) la modifica
//   sessions/{sid}/participants/{uid}  { name, product, v1, v2, v3, t } <- cada móvil solo escribe el suyo
// El acceso anónimo de Firebase es invisible para el usuario (sin registro ni contraseña):
// solo da a cada dispositivo un uid que las reglas de seguridad verifican.
async function connectFirestore(cfg, onState, role) {
  const V = '10.12.2';
  const [{ initializeApp }, fs, au] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
  ]);
  const { getFirestore, doc, collection, onSnapshot, getDoc, getDocs, setDoc, updateDoc, writeBatch } = fs;
  const app = initializeApp(cfg);
  const db = getFirestore(app);
  const auth = au.getAuth(app);
  await auth.authStateReady();
  if (!auth.currentUser) await au.signInAnonymously(auth);
  const uid = auth.currentUser.uid;

  // Sesión: el presentador crea (o recupera) la suya; los participantes la reciben en el QR (?s=...).
  let sid = role === 'presenter' ? store('bass_sid') : new URLSearchParams(location.search).get('s');
  if (role === 'presenter') {
    const snap = sid ? await getDoc(doc(db, 'sessions', sid)).catch(() => null) : null;
    if (!snap || !snap.exists() || snap.data().owner !== uid) {
      sid = Math.random().toString(36).slice(2, 8);
      await setDoc(doc(db, 'sessions', sid), { owner: uid, stage: 'lobby', createdAt: Date.now() });
      store('bass_sid', sid);
    }
  }
  if (!sid || !/^[a-z0-9]{4,12}$/.test(sid)) {
    onState(normalize({ noSession: true }));
    const fail = async () => { throw new Error('Escanea el código QR de la pantalla'); };
    return { mode: 'firebase', join: fail, choose: fail, vote: fail, admin: fail };
  }

  const sessionRef = doc(db, 'sessions', sid);
  const partsRef = collection(db, 'sessions', sid, 'participants');
  const myRef = doc(partsRef, uid);
  let session, parts = {}, current = normalize();
  const emit = () => {
    if (session === undefined) return; // aún cargando
    current = normalize({ stage: session && session.stage, participants: parts, me: uid, sessionId: sid, noSession: !session });
    onState(current);
  };
  // onSnapshot: cualquier voto o cambio de etapa llega al instante a todas las pantallas.
  onSnapshot(sessionRef, (s) => { session = s.exists() ? s.data() : null; emit(); });
  onSnapshot(partsRef, (qs) => { parts = {}; qs.forEach((d) => { parts[d.id] = d.data(); }); emit(); });

  const guard = (p) => p.catch((e) => {
    throw new Error(e && e.code === 'permission-denied' ? 'Acción no permitida en esta etapa' : 'Error de conexión, inténtalo de nuevo');
  });
  return {
    mode: 'firebase',
    join(_id, name) {
      name = cleanName(name);
      if (!name) return Promise.reject(new Error('Apodo inválido'));
      return guard(current.participants[uid]
        ? updateDoc(myRef, { name })
        : setDoc(myRef, { name, product: null, v1: null, v2: null, v3: null, t: Date.now() }));
    },
    choose(_id, product) {
      const p = current.participants[uid];
      if (!p || !productById(product) || !canChoose(current, p)) return Promise.reject(new Error('Ya no se puede cambiar'));
      return guard(updateDoc(myRef, { product }));
    },
    vote(_id, round, buy) {
      if (!canVote(current, current.participants[uid], round)) return Promise.reject(new Error('Esta ronda no está abierta'));
      return guard(updateDoc(myRef, { ['v' + round]: !!buy }));
    },
    async admin(action) {
      const i = STAGES.indexOf(current.stage);
      if (action === 'next' && i < STAGES.length - 1) return guard(updateDoc(sessionRef, { stage: STAGES[i + 1] }));
      if (action === 'prev' && i > 0) return guard(updateDoc(sessionRef, { stage: STAGES[i - 1] }));
      if (action === 'reset') {
        const all = await getDocs(partsRef);
        const batch = writeBatch(db);
        all.forEach((d) => batch.delete(d.ref));
        batch.update(sessionRef, { stage: 'lobby' });
        return guard(batch.commit());
      }
    },
  };
}

// ---------- Estadísticas ----------
// Para cada producto: cuántos lo eligieron (su "mercado") y cuántos lo compraron en cada ronda.
// upTo = número de rondas a contar (1..3).
export function stats(state, upTo = 3) {
  const list = Object.values(state.participants);
  const byProduct = PRODUCTS.map((prod) => {
    const market = list.filter((p) => p.product === prod.id);
    const perRound = [0, 1, 2].map((k) => (k < upTo ? market.filter((p) => adoptedRound(p) === k).length : 0));
    const adopters = perRound.reduce((a, b) => a + b, 0);
    let acc = 0;
    const cumulative = [0, ...perRound.map((n) => (acc += n))];
    return { ...prod, chose: market.length, perRound, adopters, cumulative, share: pct(adopters, market.length) };
  });
  const N = byProduct.reduce((a, p) => a + p.chose, 0);
  const perRound = [0, 1, 2].map((k) => byProduct.reduce((a, p) => a + p.perRound[k], 0));
  const adopters = perRound.reduce((a, b) => a + b, 0);
  return { byProduct, N, perRound, adopters, total: list.length };
}

// Estimación ILUSTRATIVA de p y q a partir de las rondas (no es una estimación estadística).
// Ronda 1: nadie conoce adoptantes → tasa = p.  Ronda 2: tasa entre no adoptantes = p + q·F1.
export function illustrativePQ(s) {
  if (!s.N) return { p: null, q: null };
  const p = s.perRound[0] / s.N;
  const remaining = s.N - s.perRound[0];
  if (!p || !remaining) return { p, q: null };
  const hazard2 = s.perRound[1] / remaining;
  return { p, q: Math.max(0, (hazard2 - p) / p) };
}

// Curva teórica de Bass (tiempo discreto): f(t) = [p + q·F(t)]·[1 − F(t)]
export function bassCurve(p, q, T) {
  let F = 0;
  const out = [{ t: 0, F: 0, innov: 0, imit: 0 }];
  for (let t = 1; t <= T; t++) {
    const innov = p * (1 - F);
    const imit = q * F * (1 - F);
    F += innov + imit;
    out.push({ t, F, innov, imit, f: innov + imit });
  }
  return out;
}

// ---------- Tooltip simple para gráficos ----------
export function enableTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tip';
  document.body.appendChild(tip);
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { tip.classList.remove('on'); return; }
    tip.innerHTML = el.getAttribute('data-tip');
    tip.classList.add('on');
    const w = tip.offsetWidth;
    const x = Math.min(window.innerWidth - w - 12, e.clientX + 14);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
  });
}

// ---------- Identidad del participante (solo comodidad local) ----------
export function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (_) { return null; }
}
