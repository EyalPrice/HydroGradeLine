// HydroGradeLine – user interface
import { MATERIALS, waterProps, G, fillingTable, normalDepth, froude, circle, Y_QMAX } from './hydraulics.js';
import { solveRun } from './solver.js';
import { QUANTITIES, toSI, fromSI, defaultUnit, fmt } from './units.js';

// ---------------- State (all SI) ----------------
let uid = 1;
const newId = (p) => p + uid++;
const pick = (m) => ({ n: m.n, eps: m.eps, C: m.C });
const newSection = (base = {}) => ({ id: newId('s'), L: 100, D: 0.254, S0: 0, material: 'PVC', ...pick(MATERIALS.PVC), kJoint: 0, ...base });
const S = {
  system: 'metric',
  zDown: 0, method: 'DW',
  sections: [newSection()],
  markers: [],
  Q: 100 / 3600, fluid: 'water', T: 20, rhoCustom: 1000, nuCustom: 1e-6,
  endType: 'pressurised', pressure: 10000, level: 0.5,
  fillSec: 0,
};
const units = {}; // field key -> current unit
let result = null;
const unitOf = (key, q) => (units[key] ||= defaultUnit(q, S.system));

// ---------------- Generic field builders ----------------
function unitSelect(q, cur, onChange, extra = []) {
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Unit');
  for (const u of QUANTITIES[q].units.map((x) => x[0]).concat(extra)) {
    const o = document.createElement('option');
    o.value = o.textContent = u;
    if (u === cur) o.selected = true;
    sel.append(o);
  }
  if (sel.options.length < 2) sel.disabled = true;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
// conversions that also understand "% of D" for gate heights
const conv = {
  to: (q, u, v, D) => (u === '% of D' ? (v / 100) * D : toSI(q, u, v)),
  from: (q, u, v, D) => (u === '% of D' ? (v / D) * 100 : fromSI(q, u, v)),
};
// numeric field: {label, q, key (unit memory), get(), set(v), readonly, extraUnits, D()}
function numField(parent, f) {
  const wrap = el('div', 'field');
  const id = 'i-' + f.key + (f.idx ?? '');
  const uk = f.key + (f.idx ?? '');
  const lab = el('label');
  lab.textContent = f.label;
  lab.htmlFor = id;
  const row = el('div', 'row');
  const inp = el('input');
  inp.id = id;
  inp.type = 'number';
  inp.inputMode = 'decimal';
  inp.step = 'any';
  inp.readOnly = !!f.readonly;
  const D = () => (f.D ? f.D() : 1);
  const show = () => { inp.value = fmt(conv.from(f.q, unitOf(uk, f.q), f.get(), D()), 6); };
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    f.set(conv.to(f.q, unitOf(uk, f.q), v, D()));
    if (f.after) f.after();
    refreshAll(inp);
    recompute();
  });
  inp._show = show;
  row.append(inp, unitSelect(f.q, unitOf(uk, f.q), (u) => { units[uk] = u; refreshAll(); }, f.extraUnits || []));
  wrap.append(lab, row);
  parent.append(wrap);
  show();
  return wrap;
}
function selField(parent, f) {
  const wrap = el('div', 'field');
  const lab = el('label');
  lab.textContent = f.label;
  const sel = el('select');
  sel.id = 'i-' + f.key + (f.idx ?? '');
  lab.htmlFor = sel.id;
  for (const opt of f.options) {
    const [v, t] = Array.isArray(opt) ? opt : [opt, opt];
    const o = el('option');
    o.value = v; o.textContent = t;
    sel.append(o);
  }
  sel.value = f.get();
  sel.addEventListener('change', () => { f.set(sel.value); if (f.rebuild) buildAll(); else refreshAll(); recompute(); });
  sel._show = () => { sel.value = f.get(); };
  wrap.append(lab, sel);
  parent.append(wrap);
  return wrap;
}
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function refreshAll(skip) {
  for (const e of document.querySelectorAll('input, select')) if (e !== skip && e._show) e._show();
  for (const w of document.querySelectorAll('[data-show]')) w.hidden = !SHOW[w.dataset.show]();
  const endSel = document.getElementById('i-endType');
  if (endSel) for (const o of endSel.options) o.disabled = S.fluid === 'air' && o.value !== 'pressurised';
}
const SHOW = {
  temp: () => S.fluid !== 'custom',
  custom: () => S.fluid === 'custom',
  pressure: () => S.endType === 'pressurised' || S.fluid === 'air',
  level: () => S.endType === 'level' && S.fluid !== 'air',
};
const withShow = (w, key) => { w.dataset.show = key; w.hidden = !SHOW[key](); return w; };

// ---------------- Section geometry helpers ----------------
function geometry() {
  // inverts from the downstream end upwards; x is horizontal
  const g = [];
  let z = S.zDown;
  for (let i = S.sections.length - 1; i >= 0; i--) {
    const s = S.sections[i];
    const c = 1 / Math.sqrt(1 + s.S0 * s.S0);
    const Lh = s.L * c;
    g[i] = { zDn: z, zUp: z + s.S0 * Lh, Lh };
    z = g[i].zUp;
  }
  let x = 0;
  for (const gi of g) { gi.x0 = x; x += gi.Lh; }
  return { g, total: x };
}
const sectionAtX = (x) => {
  const { g } = geometry();
  for (let i = 0; i < g.length; i++) if (x <= g[i].x0 + g[i].Lh + 1e-9) return i;
  return g.length - 1;
};

// ---------------- Building panels ----------------
function fluidProps() {
  if (S.fluid === 'custom') return { rho: S.rhoCustom, nu: S.nuCustom, pv: 2339, liquid: true };
  if (S.fluid === 'air') {
    const Tk = S.T + 273.15;
    const rho = 101325 / (287.05 * Tk);
    const mu = (1.458e-6 * Tk ** 1.5) / (Tk + 110.4);
    return { rho, nu: mu / rho, pv: 0, liquid: false };
  }
  return { ...waterProps(S.T), liquid: true };
}

function buildGlobal() {
  const p = document.getElementById('pipeFields');
  p.innerHTML = '';
  numField(p, { key: 'zDown', label: 'Downstream invert level (outlet)', q: 'elevation', get: () => S.zDown, set: (v) => { S.zDown = v; } });
  selField(p, { key: 'method', label: 'Full-pipe friction', options: [['DW', 'Darcy-Weisbach'], ['HW', 'Hazen-Williams']], get: () => S.method, set: (v) => { S.method = v; } });

  const f = document.getElementById('flowFields');
  f.innerHTML = '';
  numField(f, { key: 'Q', label: 'Flow rate', q: 'flow', get: () => S.Q, set: (v) => { S.Q = v; } });
  selField(f, { key: 'fluid', label: 'Fluid', options: [['water', 'Water'], ['air', 'Air (incompressible)'], ['custom', 'Custom liquid']], get: () => S.fluid, set: (v) => { S.fluid = v; if (v === 'air') S.endType = 'pressurised'; } });
  withShow(numField(f, { key: 'T', label: 'Temperature', q: 'temperature', get: () => S.T, set: (v) => { S.T = v; } }), 'temp');
  withShow(numField(f, { key: 'rho', label: 'Density', q: 'density', get: () => S.rhoCustom, set: (v) => { S.rhoCustom = v; } }), 'custom');
  withShow(numField(f, { key: 'nu', label: 'Kinematic viscosity', q: 'viscosity', get: () => S.nuCustom, set: (v) => { S.nuCustom = v; } }), 'custom');

  const e = document.getElementById('endFields');
  e.innerHTML = '';
  selField(e, { key: 'endType', label: 'End condition', options: [['pressurised', 'Pressurised'], ['steady', 'Steady state (normal depth)'], ['freefall', 'Free fall'], ['level', 'Set water level']], get: () => S.endType, set: (v) => { S.endType = v; } });
  withShow(numField(e, { key: 'pressure', label: 'Pressure at outlet (pipe axis, gauge)', q: 'pressure', get: () => S.pressure, set: (v) => { S.pressure = v; } }), 'pressure');
  withShow(numField(e, { key: 'level', label: 'Downstream water level', q: 'elevation', get: () => S.level, set: (v) => { S.level = v; } }), 'level');
}

function buildSections() {
  const box = document.getElementById('sections');
  box.innerHTML = '';
  const n = S.sections.length;
  S.sections.forEach((s, i) => {
    const card = el('div', 'card');
    card.id = 'card-' + s.id;
    const head = el('div', 'card-head');
    head.innerHTML = `<span>Section ${i + 1} <span class="tag">${n === 1 ? '' : i === 0 ? '(inlet)' : i === n - 1 ? '(outlet)' : ''}</span></span>`;
    if (n > 1) {
      const del = el('button', 'icon-btn');
      del.type = 'button';
      del.textContent = 'Remove';
      del.setAttribute('aria-label', `Remove section ${i + 1}`);
      del.addEventListener('click', () => { S.sections.splice(i, 1); S.fillSec = Math.min(S.fillSec, S.sections.length - 1); buildAll(); recompute(); });
      head.append(del);
    }
    card.append(head);
    const geo = () => geometry().g[i];
    numField(card, { key: 'secL', idx: i, label: 'Length along pipe', q: 'length', get: () => s.L, set: (v) => { s.L = Math.max(v, 1e-6); } });
    numField(card, { key: 'secD', idx: i, label: 'Inside diameter', q: 'diameter', get: () => s.D, set: (v) => { s.D = v; } });
    numField(card, { key: 'secS', idx: i, label: 'Slope (+ falls downstream, − rises)', q: 'slope', get: () => s.S0, set: (v) => { s.S0 = v; } });
    numField(card, {
      key: 'secZu', idx: i, label: 'Upstream invert level', q: 'elevation', get: () => geo().zUp,
      set: (v) => { const dz = v - geo().zDn; s.S0 = dz / Math.sqrt(Math.max(s.L * s.L - dz * dz, 1e-12)); },
    });
    numField(card, { key: 'secZd', idx: i, label: 'Downstream invert level', q: 'elevation', readonly: true, get: () => geo().zDn, set: () => {} });
    selField(card, { key: 'secMat', idx: i, label: 'Material', options: Object.keys(MATERIALS).concat('Custom'), get: () => s.material, set: (v) => { s.material = v; if (MATERIALS[v]) Object.assign(s, pick(MATERIALS[v])); } });
    const custom = () => { s.material = 'Custom'; };
    numField(card, { key: 'secN', idx: i, label: 'Manning n', q: 'ratio', get: () => s.n, set: (v) => { s.n = v; }, after: custom });
    numField(card, { key: 'secEps', idx: i, label: 'Wall roughness (Darcy-Weisbach)', q: 'roughness', get: () => s.eps, set: (v) => { s.eps = v; }, after: custom });
    numField(card, { key: 'secC', idx: i, label: 'Hazen-Williams C', q: 'ratio', get: () => s.C, set: (v) => { s.C = v; }, after: custom });
    if (i > 0) numField(card, { key: 'secK', idx: i, label: 'K loss at joint with section above', q: 'ratio', get: () => s.kJoint, set: (v) => { s.kJoint = v; } });
    box.append(card);
  });
}

const MK_LABEL = { loss: 'Head loss (K)', vent: 'Air vent', orifice: 'Orifice', gate: 'Gate' };
function newMarker(type, x) {
  const i = sectionAtX(x), D = S.sections[i].D;
  const base = { id: newId('m'), type, x };
  if (type === 'loss') return { ...base, K: 0.5 };
  if (type === 'orifice') return { ...base, shape: 'circle', size: D / 2, Cd: 0.61, Cc: 0.61 };
  if (type === 'gate') return { ...base, gate: 'top', size: D / 2, Cd: 0.61, Cc: 0.61 };
  return base;
}
function addMarker(type, x) {
  const m = newMarker(type, x);
  S.markers.push(m);
  buildMarkers();
  recompute();
  flashCard('card-' + m.id);
}
function flashCard(id) {
  const c = document.getElementById(id);
  if (!c) return;
  c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 1200);
}

function buildMarkers() {
  const box = document.getElementById('markers');
  box.innerHTML = '';
  document.getElementById('mkEmpty').hidden = S.markers.length > 0;
  const ordered = [...S.markers].sort((a, b) => a.x - b.x);
  ordered.forEach((m) => {
    const card = el('div', 'card');
    card.id = 'card-' + m.id;
    const head = el('div', 'card-head');
    head.innerHTML = `<span>${MK_LABEL[m.type]}</span>`;
    const del = el('button', 'icon-btn');
    del.type = 'button';
    del.textContent = 'Remove';
    del.addEventListener('click', () => { S.markers = S.markers.filter((q) => q !== m); buildMarkers(); recompute(); });
    head.append(del);
    card.append(head);
    const D = () => S.sections[sectionAtX(m.x)].D;
    numField(card, { key: 'mkX', idx: m.id, label: 'Position from inlet (horizontal)', q: 'length', get: () => m.x, set: (v) => { m.x = Math.min(Math.max(v, 0), geometry().total); } });
    if (m.type === 'loss') numField(card, { key: 'mkK', idx: m.id, label: 'K (loss = K·v²/2g, downstream velocity)', q: 'ratio', get: () => m.K, set: (v) => { m.K = v; } });
    if (m.type === 'orifice') {
      selField(card, { key: 'mkShape', idx: m.id, label: 'Opening shape (at the pipe bottom)', options: [['circle', 'Circular'], ['square', 'Square']], get: () => m.shape, set: (v) => { m.shape = v; } });
      numField(card, { key: 'mkSize', idx: m.id, label: 'Diameter or side', q: 'diameter', get: () => m.size, set: (v) => { m.size = v; } });
    }
    if (m.type === 'gate') {
      selField(card, { key: 'mkGate', idx: m.id, label: 'Gate type', options: [['top', 'Top gate (lowers from the crown)'], ['bottom', 'Bottom gate (rises from the invert)']], get: () => m.gate, set: (v) => { m.gate = v; }, rebuild: true });
      numField(card, { key: 'mkGh', idx: m.id, label: m.gate === 'bottom' ? 'Crest height above invert' : 'Opening under the gate', q: 'diameter', extraUnits: ['% of D'], D, get: () => m.size, set: (v) => { m.size = v; } });
    }
    if (m.type === 'orifice' || m.type === 'gate') {
      numField(card, { key: 'mkCd', idx: m.id, label: 'Discharge coefficient Cd', q: 'ratio', get: () => m.Cd, set: (v) => { m.Cd = v; } });
      numField(card, { key: 'mkCc', idx: m.id, label: 'Contraction coefficient Cc', q: 'ratio', get: () => m.Cc, set: (v) => { m.Cc = v; } });
    }
    const st = el('div', 'note muted');
    st.id = 'mkstate-' + m.id;
    card.append(st);
    box.append(card);
  });
}

function buildAll() {
  buildGlobal();
  buildSections();
  buildMarkers();
  buildResults();
  fillSelects();
  refreshAll();
}

// ---------------- Results ----------------
const vBand = (v) => (v < 0.6 ? ['v-low', 'Low: self-cleansing risk'] : v <= 3 ? ['v-ok', 'OK'] : v <= 6 ? ['v-warn', 'High'] : ['v-bad', 'Too high: erosion risk']);
const regimeName = (g) => ({ full: 'Pressurised', sub: 'Subcritical', super: 'Supercritical', critical: 'Critical' }[g] || '');
const RES = [
  { id: 'Eup', label: 'Upstream energy level (inlet)', q: 'elevation', get: (r) => r.points[0].egl, note: () => 'Water level needed in an inlet tank, ignoring entry loss' },
  { id: 'hUp', label: 'Upstream hydraulic grade level', q: 'elevation', get: (r) => r.points[0].hgl, note: (r) => regimeName(r.points[0].regime) + ' at inlet' },
  { id: 'pUp', label: 'Upstream pressure (pipe axis, gauge)', q: 'pressure', get: (r) => { const p = r.points[0]; return p.regime === 'full' ? (p.hgl - p.zInv - p.D / 2) * r.fl.rho * G : null; }, note: (r) => (r.points[0].regime === 'full' ? '' : 'Free surface at inlet') },
  { id: 'hfTot', label: 'Head loss, inlet to outlet (energy)', q: 'head', get: (r) => r.points[0].egl - r.points.at(-1).egl, note: () => 'Includes friction, fittings and controls' },
  { id: 'fillDn', label: 'Filling at outlet', q: 'percent', get: (r) => r.points.at(-1).fill, note: (r) => regimeName(r.points.at(-1).regime) },
  { id: 'vmin', label: 'Lowest velocity along run', q: 'velocity', get: (r) => Math.min(...r.points.map((p) => p.V)), band: true },
  { id: 'vmax', label: 'Highest velocity along run', q: 'velocity', get: (r) => Math.max(...r.points.map((p) => p.V)), band: true },
  { id: 'pmin', label: 'Lowest pressure at crown (gauge)', q: 'pressure', get: (r) => Math.min(...r.points.map((p) => p.pCrown)), note: (r) => (Math.min(...r.points.map((p) => p.pCrown)) < -1000 ? 'Below atmospheric' : '') },
  { id: 'jumps', label: 'Hydraulic jumps', q: 'ratio', get: (r) => r.jumps.length, note: (r) => r.jumps.map((j) => `at ${fmt(fromSI('length', defaultUnit('length', S.system), j.x), 4)} ${defaultUnit('length', S.system)}, Froude before ${fmt(j.F1, 3)}`).join('; '), free: true },
  { id: 'air', label: 'Air drawn in by jumps (estimate)', q: 'flow', get: (r) => (r.jumps.length ? r.jumps.reduce((a, j) => a + j.airQ, 0) : null), note: (r) => (r.jumps.length ? 'Kalinske & Robertson, for vent sizing' : ''), free: true },
];

function buildResults() {
  const box = document.getElementById('results');
  box.innerHTML = '';
  for (const d of RES) {
    const key = 'r-' + d.id;
    const e = el('div', 'result');
    e.id = key;
    e.innerHTML = `<div class="field"><label>${d.label}</label></div><div class="row"><span class="val"></span></div><div class="note"></div>`;
    const row = e.querySelector('.row');
    if (QUANTITIES[d.q].units.length > 1) row.append(unitSelect(d.q, unitOf(key, d.q), (u) => { units[key] = u; renderResults(); }));
    else if (QUANTITIES[d.q].units[0][0] !== '–') row.insertAdjacentHTML('beforeend', `<span class="note">${QUANTITIES[d.q].units[0][0]}</span>`);
    box.append(e);
  }
}

function renderResults() {
  const w = document.getElementById('warnings');
  w.innerHTML = '';
  for (const t of result.warnings) { const li = el('li'); li.textContent = t; w.append(li); }
  const ok = result.points.length > 0;
  for (const d of RES) {
    const e = document.getElementById('r-' + d.id);
    const v = ok ? d.get(result) : null;
    e.hidden = d.free && S.fluid === 'air';
    e.querySelector('.val').textContent = v === null || v === undefined ? '–' : fmt(fromSI(d.q, unitOf('r-' + d.id, d.q), v), 4);
    e.className = 'result';
    if (d.band && v) { const [c, t] = vBand(v); e.classList.add(c); e.querySelector('.note').textContent = t; }
    else e.querySelector('.note').textContent = ok && d.note ? d.note(result) : '';
  }
  renderSectionTable();
  renderTable();
  for (const m of S.markers) {
    const st = document.getElementById('mkstate-' + m.id);
    if (!st) continue;
    if (!ok) { st.textContent = ''; continue; }
    const i = result.points.findIndex((p) => p.marker === m.id && p.side === 'u');
    if (i < 0) { st.textContent = ''; continue; }
    const u = result.points[i], d = result.points[i + 1], eu = unitOf('r-hUp', 'elevation');
    const dh = Math.abs(u.egl - d.egl) < 1e-9 ? 0 : u.egl - d.egl;
    st.textContent = `Energy drop ${fmt(fromSI('head', defaultUnit('head', S.system), dh), 3)} ${defaultUnit('head', S.system)} · upstream ${regimeName(u.regime).toLowerCase()}, downstream ${regimeName(d.regime).toLowerCase()}` + (m.type === 'vent' ? (result.ventsOpen.includes(m.id) ? ' · vent open (letting air in)' : ' · vent closed (pressure above atmospheric)') : '');
  }
}

function renderSectionTable() {
  const t = document.getElementById('stable');
  if (!result.secs) { t.innerHTML = ''; return; }
  const du = defaultUnit('diameter', S.system), vu = defaultUnit('velocity', S.system), hu = defaultUnit('headloss', S.system), qu = defaultUnit('flow', S.system);
  const kind = (s) => (s.sinA <= 0 ? (s.sinA === 0 ? 'Flat' : 'Rising') : !s.yn || s.yn.full ? 'Full (over capacity)' : s.steep ? 'Steep' : 'Mild');
  t.innerHTML = `<thead><tr><th>Section</th><th>Diameter (${du})</th><th>Velocity full (${vu})</th><th>Head loss full (${hu})</th><th>Normal depth fill %</th><th>Critical depth fill %</th><th>Gravity capacity (${qu})</th><th style="text-align:left">Slope type</th></tr></thead><tbody>${result.secs.map((s, i) => `<tr><td>${i + 1}</td><td>${fmt(fromSI('diameter', du, s.D), 4)}</td><td class="vb ${vBand(s.full.V)[0]}">${fmt(fromSI('velocity', vu, s.full.V), 3)}</td><td>${fmt(fromSI('headloss', hu, s.full.Sf), 4)}</td><td>${s.yn && !s.yn.full ? fmt((s.yn.y / s.D) * 100, 3) : '–'}</td><td>${fmt((s.yc / s.D) * 100, 3)}</td><td>${s.yn ? fmt(fromSI('flow', qu, s.yn.Qmax), 4) : '–'}</td><td style="text-align:left">${kind(s)}</td></tr>`).join('')}</tbody>`;
}

function at(pts, x) {
  if (x <= pts[0].x) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1], b = pts[i];
      if (b.x - a.x < 1e-12) return b;
      const f = (x - a.x) / (b.x - a.x);
      const o = { x, regime: f < 0.5 ? a.regime : b.regime, sec: b.sec, D: b.D };
      for (const k of ['zInv', 'y', 'hgl', 'egl', 'V', 'fill', 'pCrown']) o[k] = a[k] + f * (b[k] - a[k]);
      return o;
    }
  }
  return pts[pts.length - 1];
}

function renderTable() {
  const r = result;
  const t = document.getElementById('ptable');
  if (!r.points.length) { t.innerHTML = ''; return; }
  const lu = defaultUnit('length', S.system), eu = defaultUnit('elevation', S.system), vu = defaultUnit('velocity', S.system), pu = defaultUnit('pressure', S.system);
  const xs = new Set();
  for (let i = 0; i <= 40; i++) xs.add((r.totalX * i) / 40);
  for (const j of r.jumps) xs.add(j.x);
  const rows = [...xs].sort((a, b) => a - b).map((x) => at(r.points, x));
  for (const p of r.points) if (p.marker) rows.push(p);
  rows.sort((a, b) => a.x - b.x || (a.side === 'd') - (b.side === 'd'));
  const mkName = (p) => { const m = S.markers.find((q) => q.id === p.marker); return m ? `${MK_LABEL[m.type]} (${p.side === 'u' ? 'upstream' : 'downstream'})` : ''; };
  t.innerHTML = `<thead><tr><th>Distance (${lu})</th><th>Section</th><th>Invert (${eu})</th><th>Filling %</th><th>Velocity (${vu})</th><th>HGL (${eu})</th><th>EGL (${eu})</th><th>Crown pressure (${pu})</th><th style="text-align:left">Regime</th><th style="text-align:left">Note</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${fmt(fromSI('length', lu, p.x), 5)}</td><td>${p.sec + 1}</td><td>${fmt(fromSI('elevation', eu, p.zInv), 4)}</td><td>${fmt(p.fill * 100, 3)}</td><td class="vb ${vBand(p.V)[0]}">${fmt(fromSI('velocity', vu, p.V), 3)}</td><td>${fmt(fromSI('elevation', eu, p.hgl), 4)}</td><td>${fmt(fromSI('elevation', eu, p.egl), 4)}</td><td>${p.regime === 'full' ? fmt(fromSI('pressure', pu, p.pCrown), 3) : '–'}</td><td style="text-align:left">${regimeName(p.regime)}</td><td style="text-align:left">${p.marker ? mkName(p) : ''}</td></tr>`).join('')}</tbody>`;
}

// ---------------- Solve ----------------
function recompute() {
  const fl = fluidProps();
  const bad = !(S.Q > 0) || S.sections.some((s) => !(s.L > 0 && s.D > 0 && s.n > 0 && s.eps >= 0 && s.C > 0));
  if (bad) {
    result = { points: [], warnings: ['Check the inputs: flow, length, diameter, n and C must be greater than zero.'], jumps: [], fl, totalX: geometry().total };
  } else {
    result = solveRun({
      Q: S.Q, zDown: S.zDown, method: S.method, fluid: fl,
      sections: S.sections, markers: S.markers,
      end: { type: S.fluid === 'air' ? 'pressurised' : S.endType, pressure: S.pressure, level: S.level },
    });
    result.fl = fl;
    if (!fl.liquid) {
      const dp = (result.points[0].hgl - result.points.at(-1).hgl) * fl.rho * G;
      if (dp > 0.1 * (S.pressure + 101325)) result.warnings.push('Pressure drop exceeds 10% of absolute pressure: the incompressible assumption is no longer reliable.');
      result.warnings = result.warnings.filter((w) => !/vapour|Sub-atmospheric/.test(w));
    }
  }
  renderResults();
  draw();
  renderFill();
}

// ---------------- Partial flow table ----------------
const fillUnits = {};
function fillSelects() {
  for (const [id, q] of [['fillQu', 'flow'], ['fillVu', 'velocity'], ['fillYu', 'head']]) {
    const sel = document.getElementById(id);
    fillUnits[q] = defaultUnit(q, S.system);
    sel.innerHTML = QUANTITIES[q].units.map(([u]) => `<option${u === fillUnits[q] ? ' selected' : ''}>${u}</option>`).join('');
    sel.onchange = () => { fillUnits[q] = sel.value; renderFill(); };
  }
  const ss = document.getElementById('fillSec');
  ss.innerHTML = S.sections.map((_, i) => `<option value="${i}"${i === S.fillSec ? ' selected' : ''}>${i + 1}</option>`).join('');
  ss.onchange = () => { S.fillSec = +ss.value; renderFill(); };
}
document.getElementById('fillStep').addEventListener('change', () => renderFill());

function renderFill() {
  const t = document.getElementById('filltable');
  const sum = document.getElementById('fillSummary');
  const s = S.sections[S.fillSec] || S.sections[0];
  const c = 1 / Math.sqrt(1 + s.S0 * s.S0), Sb = s.S0 * c;
  if (S.fluid === 'air') { sum.textContent = 'Partial flow applies to liquids only.'; t.innerHTML = ''; return; }
  if (!(Sb > 0) || !(s.D > 0) || !(s.n > 0)) { sum.textContent = `Section ${S.fillSec + 1} is flat or rising: partial flow needs a falling slope.`; t.innerHTML = ''; return; }
  const qu = fillUnits.flow, vu = fillUnits.velocity, yu = fillUnits.head;
  const step = +document.getElementById('fillStep').value;
  const pcts = [];
  for (let p = step; p < 100; p += step) pcts.push(p);
  pcts.push(Y_QMAX * 100, 99.99);
  const rows = fillingTable(s.D, s.n, Sb, [...new Set(pcts)].sort((a, b) => a - b)).map((r) => ({ ...r, Fr: froude(r.Q, r.y, s.D) }));
  const yn = normalDepth(S.Q, s.D, s.n, Sb);
  if (yn && !yn.full) {
    const A = circle(yn.y, s.D).A;
    const cur = { pct: (yn.y / s.D) * 100, y: yn.y, Q: S.Q, V: S.Q / A, Fr: froude(S.Q, yn.y, s.D), current: true };
    rows.push(cur);
    rows.sort((a, b) => a.pct - b.pct);
    sum.textContent = `Section ${S.fillSec + 1}: your flow of ${fmt(fromSI('flow', qu, S.Q), 4)} ${qu} runs ${fmt(cur.pct, 3)}% full at normal depth, at ${fmt(fromSI('velocity', vu, cur.V), 3)} ${vu} (${cur.Fr > 1 ? 'supercritical' : 'subcritical'}).`;
  } else if (!yn) {
    sum.textContent = 'Enter a flow greater than zero to place your flow in the table.';
  } else {
    sum.textContent = `Section ${S.fillSec + 1}: your flow of ${fmt(fromSI('flow', qu, S.Q), 4)} ${qu} exceeds the gravity capacity of ${fmt(fromSI('flow', qu, yn.Qmax), 4)} ${qu}; the pipe runs full.`;
  }
  t.innerHTML = `<thead><tr><th>Filling %</th><th>Depth (${yu})</th><th>Flow (${qu})</th><th>Velocity (${vu})</th><th>Froude</th></tr></thead><tbody>${rows.map((r) => {
    const label = r.current ? `${fmt(r.pct, 3)} ← your flow` : Math.abs(r.pct - Y_QMAX * 100) < 1e-6 ? `${fmt(r.pct, 4)} (max flow)` : fmt(r.pct, 4);
    return `<tr class="${r.current ? 'current' : ''}"><td>${label}</td><td>${fmt(fromSI('head', yu, r.y), 4)}</td><td>${fmt(fromSI('flow', qu, r.Q), 4)}</td><td class="vb ${vBand(r.V)[0]}">${fmt(fromSI('velocity', vu, r.V), 3)}</td><td>${fmt(r.Fr, 3)}</td></tr>`;
  }).join('')}</tbody>`;
}

// ---------------- Long section drawing ----------------
const svg = document.getElementById('profile');
const view = { x0: 0, x1: 100 };
const M = { l: 58, r: 14, t: 18, b: 44 };
let lastTotal = null;

function niceTicks(a, b, n) {
  const span = b - a;
  if (!(span > 0)) return [a];
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function draw() {
  const W = svg.clientWidth || 800, H = svg.clientHeight || 360;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const total = result?.totalX || geometry().total;
  if (lastTotal !== total) { view.x0 = 0; view.x1 = total; lastTotal = total; }
  const pts = result?.points || [];
  if (!pts.length) { svg.innerHTML = ''; return; }
  let yMin = Infinity, yMax = -Infinity;
  for (const p of pts) { yMin = Math.min(yMin, p.zInv); yMax = Math.max(yMax, p.egl, p.zInv + p.D); }
  const pad = (yMax - yMin) * 0.08 || 0.1;
  yMin -= pad; yMax += pad;
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const X = (x) => M.l + ((x - view.x0) / (view.x1 - view.x0)) * pw;
  const Y = (z) => M.t + (1 - (z - yMin) / (yMax - yMin)) * ph;
  const lu = defaultUnit('length', S.system), eu = defaultUnit('elevation', S.system);
  const path = (arr) => arr.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
  const inv = pts.map((p) => [p.x, p.zInv]);
  const crown = pts.map((p) => [p.x, p.zInv + p.D]);
  const top = pts.map((p) => [p.x, p.regime === 'full' ? p.zInv + p.D : Math.min(p.hgl, p.zInv + p.D)]);
  const pipePoly = path(inv) + path(crown.slice().reverse()).replace('M', 'L') + 'Z';
  const waterPoly = path(inv) + path(top.slice().reverse()).replace('M', 'L') + 'Z';

  let g = `<defs><clipPath id="plot"><rect x="${M.l}" y="${M.t - 16}" width="${pw}" height="${ph + 40}"/></clipPath></defs>`;
  // ticks are chosen in the display units so they land on round numbers
  for (const tu of niceTicks(fromSI('elevation', eu, yMin), fromSI('elevation', eu, yMax), 5)) { const t = toSI('elevation', eu, tu); g += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--rule)"/><text x="${M.l - 6}" y="${Y(t) + 4}" text-anchor="end">${fmt(tu, 4)}</text>`; }
  for (const tu of niceTicks(fromSI('length', lu, view.x0), fromSI('length', lu, view.x1), Math.max(3, Math.floor(pw / 90)))) { const t = toSI('length', lu, tu); g += `<line x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${M.t + ph}" stroke="var(--rule)" stroke-dasharray="2 4"/><text x="${X(t)}" y="${H - 6}" text-anchor="middle">${fmt(tu, 4)}</text>`; }
  g += `<text x="${M.l - 6}" y="${M.t - 6}" text-anchor="end">${eu}</text><text x="${M.l - 6}" y="${H - 6}" text-anchor="end">${lu}</text>`;
  g += `<g clip-path="url(#plot)">`;
  g += `<path d="${pipePoly}" fill="var(--pipe-fill)"/><path d="${waterPoly}" fill="var(--water)"/>`;
  g += `<path d="${path(inv)}" fill="none" stroke="var(--pipe)" stroke-width="2"/><path d="${path(crown)}" fill="none" stroke="var(--pipe)" stroke-width="2"/>`;
  // sub-atmospheric reaches shaded red
  {
    let run = null;
    const flush = () => { if (run && run.length > 1) g += `<path d="${path(run.map((p) => [p.x, p.zInv]))}${path(run.slice().reverse().map((p) => [p.x, p.zInv + p.D])).replace('M', 'L')}Z" fill="var(--bad)" fill-opacity=".28"/>`; run = null; };
    for (const p of pts) { if (p.regime === 'full' && p.pCrown < -1000) (run ||= []).push(p); else flush(); }
    flush();
  }
  // section joints
  if (result.secs) for (const s of result.secs.slice(1)) g += `<line x1="${X(s.x0)}" x2="${X(s.x0)}" y1="${Y(s.zUp) + 4}" y2="${Y(s.zUp + s.D) - 4}" stroke="var(--pipe)" stroke-width="1"/>`;
  g += `<path d="${path(pts.map((p) => [p.x, p.hgl]))}" fill="none" stroke="var(--hgl)" stroke-width="2" stroke-dasharray="6 4"/>`;
  g += `<path d="${path(pts.map((p) => [p.x, p.egl]))}" fill="none" stroke="var(--egl)" stroke-width="2"/>`;
  // regime and velocity strips
  const sy = M.t + ph + 6;
  const regCol = { full: 'var(--full)', sub: 'var(--sub)', super: 'var(--super)', critical: 'var(--super)' };
  const vCol = (v) => (v < 0.6 ? 'var(--low)' : v <= 3 ? 'var(--ok)' : v <= 6 ? 'var(--warn)' : 'var(--bad)');
  const strip = (key, y) => {
    const runs = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x - pts[i - 1].x < 1e-12) continue;
      const k = key(pts[i]);
      const lastR = runs[runs.length - 1];
      if (lastR && lastR.k === k) lastR.x1 = pts[i].x;
      else runs.push({ k, x0: pts[i - 1].x, x1: pts[i].x });
    }
    return runs.map((r) => `<rect x="${X(r.x0)}" y="${y}" width="${Math.max(X(r.x1) - X(r.x0), 1)}" height="6" fill="${r.k}"/>`).join('');
  };
  g += strip((p) => regCol[p.regime], sy);
  g += strip((p) => vCol(p.V), sy + 9);
  for (const j of result.jumps) g += `<line x1="${X(j.x)}" x2="${X(j.x)}" y1="${M.t}" y2="${M.t + ph}" stroke="var(--super)" stroke-dasharray="3 3"/><text x="${X(j.x) + 4}" y="${M.t + 10}">Jump</text>`;
  // markers
  for (const m of S.markers) {
    const p = at(pts, m.x), x = X(m.x), yInv = Y(p.zInv), yCr = Y(p.zInv + p.D);
    const sym = { loss: 'K', vent: 'V', orifice: 'O', gate: 'G' }[m.type];
    let shape = '';
    if (m.type === 'gate') {
      const h = Math.min(m.size, p.D);
      shape = m.gate === 'bottom' ? `<rect x="${x - 2}" y="${Y(p.zInv + h)}" width="4" height="${yInv - Y(p.zInv + h)}" fill="var(--ink)"/>` : `<rect x="${x - 2}" y="${yCr}" width="4" height="${Y(p.zInv + h) - yCr}" fill="var(--ink)"/>`;
    } else if (m.type === 'orifice') {
      const h = Math.min(m.size, p.D);
      shape = `<rect x="${x - 2}" y="${yCr}" width="4" height="${Y(p.zInv + h) - yCr}" fill="var(--ink)"/>`;
    } else if (m.type === 'vent') {
      shape = `<line x1="${x}" x2="${x}" y1="${yCr}" y2="${yCr - 14}" stroke="var(--ink)" stroke-width="2"/>`;
    }
    g += `<g class="mk" data-id="${m.id}">${shape}<line x1="${x}" x2="${x}" y1="${M.t - 2}" y2="${M.t + ph}" stroke="var(--ink)" stroke-opacity=".35" stroke-dasharray="1 3"/><circle cx="${x}" cy="${M.t - 8}" r="7" fill="var(--card)" stroke="var(--ink)"/><text x="${x}" y="${M.t - 4.5}" text-anchor="middle">${sym}</text></g>`;
  }
  g += `</g>`;
  g += `<text x="${M.l - 6}" y="${sy + 6}" text-anchor="end" style="font-size:9px">flow</text><text x="${M.l - 6}" y="${sy + 15}" text-anchor="end" style="font-size:9px">speed</text>`;
  g += `<line id="cross" y1="${M.t}" y2="${M.t + ph}" stroke="var(--muted)" visibility="hidden"/>`;
  svg.innerHTML = g;
  draw.X = X;
}

// zoom / pan along the length axis only
const ptrs = new Map();
let pinch0 = null, longPress = null, moved = false;
const total = () => result?.totalX || geometry().total;
const clampView = () => {
  const T = total();
  const span = Math.min(Math.max(view.x1 - view.x0, T / 5000), T);
  const x0 = Math.min(Math.max(view.x0, 0), T - span);
  view.x0 = x0; view.x1 = x0 + span;
};
const dataX = (clientX) => {
  const r = svg.getBoundingClientRect();
  return view.x0 + ((clientX - r.left - M.l) / (r.width - M.l - M.r)) * (view.x1 - view.x0);
};
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const xm = dataX(e.clientX);
  const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
  view.x0 = xm - (xm - view.x0) * k;
  view.x1 = xm + (view.x1 - xm) * k;
  clampView(); draw();
}, { passive: false });
svg.addEventListener('pointerdown', (e) => {
  hideMenu();
  if (e.button === 2) return;
  const mk = e.target.closest('.mk');
  if (mk) { flashCard('card-' + mk.dataset.id); return; }
  try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: view.x0, x1: view.x1 });
  moved = false;
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.abs(a.x - b.x), mid: dataX((a.x + b.x) / 2), x0: view.x0, x1: view.x1 }; clearTimeout(longPress); }
  if (e.pointerType === 'touch' && ptrs.size === 1) longPress = setTimeout(() => { if (!moved) { ptrs.clear(); showMenu(e.clientX, e.clientY); } }, 550);
  svg.classList.add('dragging');
});
svg.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (p) {
    p.cur = e.clientX;
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 8) { moved = true; clearTimeout(longPress); }
    if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.abs((a.cur ?? a.x) - (b.cur ?? b.x)) || 1;
      const k = pinch0.d / d;
      view.x0 = pinch0.mid - (pinch0.mid - pinch0.x0) * k;
      view.x1 = pinch0.mid + (pinch0.x1 - pinch0.mid) * k;
    } else if (ptrs.size === 1) {
      const r = svg.getBoundingClientRect();
      const dx = ((e.clientX - p.x) / (r.width - M.l - M.r)) * (p.x1 - p.x0);
      view.x0 = p.x0 - dx; view.x1 = p.x1 - dx;
    }
    clampView(); draw();
    return;
  }
  showReadout(e);
});
const endPtr = (e) => { clearTimeout(longPress); ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; if (!ptrs.size) svg.classList.remove('dragging'); };
svg.addEventListener('pointerup', endPtr);
svg.addEventListener('pointercancel', endPtr);
svg.addEventListener('pointerleave', () => { document.getElementById('readout').hidden = true; const c = document.getElementById('cross'); if (c) c.setAttribute('visibility', 'hidden'); });
svg.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY); });
document.getElementById('fit').addEventListener('click', () => { view.x0 = 0; view.x1 = total(); draw(); });
new ResizeObserver(() => draw()).observe(svg);

// context menu for adding markers at a point
const menu = document.getElementById('ctxmenu');
function showMenu(cx, cy) {
  const x = Math.min(Math.max(dataX(cx), 0), total());
  const lu = defaultUnit('length', S.system);
  const types = S.fluid === 'air' ? ['loss'] : ['loss', 'vent', 'orifice', 'gate'];
  menu.innerHTML = `<div class="at">at ${fmt(fromSI('length', lu, x), 4)} ${lu}</div>` + types.map((t) => `<button type="button" role="menuitem" data-t="${t}">Add ${MK_LABEL[t].toLowerCase()}</button>`).join('');
  const r = svg.parentElement.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(cx - r.left, r.width - menu.offsetWidth - 4) + 'px';
  menu.style.top = Math.min(cy - r.top, r.height - menu.offsetHeight - 4) + 'px';
  for (const b of menu.querySelectorAll('button')) b.onclick = () => { hideMenu(); addMarker(b.dataset.t, x); };
  menu.querySelector('button').focus();
}
function hideMenu() { menu.hidden = true; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && e.target !== svg && !svg.contains(e.target)) hideMenu(); });
for (const b of document.querySelectorAll('[data-add]')) b.addEventListener('click', () => addMarker(b.dataset.add, (view.x0 + view.x1) / 2));

function showReadout(e) {
  if (!result?.points.length) return;
  const x = dataX(e.clientX);
  const ro = document.getElementById('readout');
  if (x < view.x0 || x > view.x1) { ro.hidden = true; return; }
  const p = at(result.points, x);
  const lu = defaultUnit('length', S.system), eu = defaultUnit('elevation', S.system), vu = defaultUnit('velocity', S.system);
  ro.textContent = `x    ${fmt(fromSI('length', lu, x), 4)} ${lu}  (section ${p.sec + 1})\nfill ${fmt(p.fill * 100, 3)} %\nV    ${fmt(fromSI('velocity', vu, p.V), 3)} ${vu}\nHGL  ${fmt(fromSI('elevation', eu, p.hgl), 4)} ${eu}\nEGL  ${fmt(fromSI('elevation', eu, p.egl), 4)} ${eu}\n${regimeName(p.regime)}`;
  ro.hidden = false;
  const r = svg.getBoundingClientRect();
  const px = e.clientX - r.left;
  ro.style.left = (px > r.width / 2 ? px - ro.offsetWidth - 12 : px + 12) + 'px';
  const c = document.getElementById('cross');
  c.setAttribute('x1', draw.X(x)); c.setAttribute('x2', draw.X(x)); c.setAttribute('visibility', 'visible');
}

// ---------------- Sections: add upstream ----------------
document.getElementById('addSec').addEventListener('click', () => {
  const first = S.sections[0];
  S.sections.unshift(newSection({ D: first.D, S0: first.S0, material: first.material, n: first.n, eps: first.eps, C: first.C }));
  // markers keep their place on the pipe: shift by the new section's horizontal length
  const c = 1 / Math.sqrt(1 + first.S0 * first.S0);
  for (const m of S.markers) m.x += 100 * c;
  S.fillSec = 0;
  buildAll();
  recompute();
  view.x0 = 0; view.x1 = total(); draw();
  flashCard('card-' + S.sections[0].id);
});

// ---------------- Unit system switch ----------------
for (const b of document.querySelectorAll('.system button')) {
  b.addEventListener('click', () => {
    S.system = b.dataset.system;
    for (const x of document.querySelectorAll('.system button')) x.setAttribute('aria-pressed', x === b);
    for (const k of Object.keys(units)) delete units[k];
    buildAll();
    recompute();
  });
}
document.getElementById('discBtn').addEventListener('click', () => document.getElementById('discDlg').showModal());

buildAll();
recompute();
