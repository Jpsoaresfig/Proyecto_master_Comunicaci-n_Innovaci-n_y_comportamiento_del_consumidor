// BASS CHALLENGE — lógica compartida (productos, sincronización, estadísticas, utilidades)

export const STAGES = ['lobby', 'r1', 'res1', 'r2', 'res2', 'r3', 'final', 'bass', 'marketing'];
export const STAGE_LABELS = ['Entrada', 'Ronda 1', 'Resultados', 'Ronda 2', 'Resultados', 'Ronda 3', 'Final', 'Modelo de Bass', 'Marketing'];

const ICONS = {
  nothing: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M9 6.5a2 2 0 0 1 2-1M12 10a3.5 3.5 0 1 1-3.2 4.9M15.2 18.3v-1.6"/></svg>',
  fairphone: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M9.5 14.5c0-3.5 2-5.5 5.5-5.5 0 3.5-2 5.5-5.5 5.5zM9 16.5l3.2-4.2"/></svg>',
};

// Dos móviles con el mismo precio hipotético. "pitched": el que el presentador vende antes de la ronda 3.
export const PRODUCTS = [
  { id: 'nothing', name: 'Nothing Phone', desc: 'Diseño transparente y luces en la parte trasera', price: '€499', color: '#3987e5', pitched: true },
  { id: 'fairphone', name: 'Fairphone', desc: 'Sostenible y fácil de reparar', price: '€499', color: '#d95926' },
].map((p) => ({ ...p, icon: ICONS[p.id] }));
export const productById = (id) => PRODUCTS.find((p) => p.id === id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const NONE = 'none'; // «Ninguno por ahora»
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);

// Primera ronda en la que el participante compró (0,1,2) o -1, y qué producto.
export const adoptedRound = (p) => p.votes.findIndex((v) => !!productById(v));
export const adoptedProduct = (p) => productById(p.votes[adoptedRound(p)]);

// ---------- Reglas del juego (compartidas por ambos modos) ----------
export function canVote(state, p, round) {
  if (!p || state.stage !== 'r' + round) return false;
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
      name: p.name, t: p.t || 0,
      votes: [0, 1, 2].map((k) => (votes[k] === NONE || productById(votes[k]) ? votes[k] : null)),
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
    vote: (id, round, choice) => post('/api/vote', { id, round, choice }),
    admin: (action) => post('/api/admin', { key, action }),
  };
}

// Cloud Firestore:
//   sessions/{sid}                     { owner, stage, createdAt }      <- solo el presentador (owner) la modifica
//   sessions/{sid}/participants/{uid}  { name, v1, v2, v3, t }          <- cada móvil solo escribe el suyo
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
    return { mode: 'firebase', join: fail, vote: fail, admin: fail };
  }

  const sessionRef = doc(db, 'sessions', sid);
  const partsRef = collection(db, 'sessions', sid, 'participants');
  const myRef = doc(partsRef, uid);
  let session, parts = null, current = normalize();
  const emit = () => {
    if (session === undefined || !parts) return; // aún cargando
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
        : setDoc(myRef, { name, v1: null, v2: null, v3: null, t: Date.now() }));
    },
    vote(_id, round, choice) {
      if (!canVote(current, current.participants[uid], round)) return Promise.reject(new Error('Esta ronda no está abierta'));
      return guard(updateDoc(myRef, { ['v' + round]: choice }));
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
// Toda la clase es un único mercado (N). Para cada producto: cuántos lo compraron en cada ronda.
// upTo = número de rondas a contar (1..3).
export function stats(state, upTo = 3) {
  const list = Object.values(state.participants);
  const N = list.length;
  const series = (perRound) => {
    let acc = 0;
    const cumulative = [0, ...perRound.map((n) => (acc += n))];
    return { perRound, adopters: acc, cumulative, share: pct(acc, N) };
  };
  const byProduct = PRODUCTS.map((prod) => ({
    ...prod,
    ...series([0, 1, 2].map((k) => (k < upTo ? list.filter((p) => adoptedRound(p) === k && p.votes[k] === prod.id).length : 0))),
  }));
  const total = series([0, 1, 2].map((k) => byProduct.reduce((a, p) => a + p.perRound[k], 0)));
  const { perRound, adopters } = total;
  // Base de cálculo de p y q: solo quienes respondieron la ronda 1. Quien llegó tarde o no respondió
  // no tuvo ocasión de actuar como innovador: no debe bajar p ni contar como imitador.
  const answered1 = list.filter((p) => p.votes[0] !== null);
  const notYet = upTo > 1 ? answered1.filter((p) => p.votes[0] === NONE && p.votes[1] !== null) : [];
  const panel = {
    n1: answered1.length,                             // respondieron la ronda 1
    buy1: answered1.filter((p) => p.votes[0] !== NONE).length, // …y compraron
    n2: notYet.length,                                // no compraron en R1 y respondieron la ronda 2
    buy2: notYet.filter((p) => p.votes[1] !== NONE).length,
    out: list.length - answered1.length,              // fuera del cálculo
  };
  return { byProduct, N, perRound, adopters, total, panel };
}

// Estimación ILUSTRATIVA de p y q a partir de las rondas (no es una estimación estadística).
// Ronda 1: nadie conoce adoptantes → tasa = p.  Ronda 2: tasa entre no adoptantes = p + q·F1.
// Como F1 = p, q = (tasa R2 − p) / p. La ronda 3 (posterior a la presentación comercial del presentador) no interviene.
export function illustrativePQ({ panel }) {
  const { n1, buy1, n2, buy2 } = panel;
  const p = n1 ? buy1 / n1 : null;
  const rate2 = n2 ? buy2 / n2 : null;
  const q = p && rate2 !== null ? Math.max(0, (rate2 - p) / p) : null;
  // Compras de la ronda 2 que cabría esperar solo con la tasa de innovación p.
  const expectedByP = p !== null ? p * n2 : null;
  return { p, q, rate2, expectedByP };
}

// Lectura del resultado para la pantalla del presentador (umbrales orientativos).
export function interpretPQ({ p, q, rate2 }) {
  if (p === null) return 'Nadie respondió la ronda 1: no se pueden calcular p ni q.';
  if (p === 0) return 'Nadie compró en la ronda 1 (p = 0): no había a quién imitar y q no se puede calcular.';
  if (p === 1) return 'Todos compraron en la ronda 1: no quedó mercado para observar la imitación (q).';
  if (rate2 === null) return 'Faltan respuestas de la ronda 2: q no se puede calcular.';
  if (q === 0) return 'La tasa de compra de la ronda 2 no superó a la de la ronda 1: no se observó imitación.';
  if (p < 0.1 && rate2 < 0.1) return 'Tasas bajas en las dos rondas: la adopción fue lenta en esta clase.';
  if (q > p) return 'q > p: pesó más la influencia de los demás que la iniciativa propia.';
  return 'p ≥ q: pesó más la iniciativa propia que la influencia de los demás.';
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
