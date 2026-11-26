// HydroGradeLine – user interface
import { MATERIALS, waterProps, G, fillingTable, normalDepth, froude, circle, Y_QMAX } from './hydraulics.js';
import { solveProfile } from './profile.js';
import { QUANTITIES, toSI, fromSI, defaultUnit, fmt } from './units.js';

// ---------------- State (all SI) ----------------
const S = {
  system: 'metric',
  L: 100, D: 0.254, S0: 0, zDown: 0,
  material: 'PVC', ...pick(MATERIALS.PVC), method: 'DW',
  Q: 100 / 3600, fluid: 'water', T: 20, rhoCustom: 1000, nuCustom: 1e-6,
  endType: 'pressurised', pressure: 10000, level: 0.5,
};
function pick(m) { return { n: m.n, eps: m.eps, C: m.C }; }
const units = {}; // field id -> current unit
let result = null;

// ---------------- Field definitions ----------------
const NUM = [
  { id: 'L', group: 'pipeFields', label: 'Length', q: 'length' },
  { id: 'D', group: 'pipeFields', label: 'Inside diameter', q: 'diameter' },
  { id: 'S0', group: 'pipeFields', label: 'Slope (falling downstream)', q: 'slope' },
  { id: 'zDown', group: 'pipeFields', label: 'Downstream invert level', q: 'elevation' },
  { id: 'zUp', group: 'pipeFields', label: 'Upstream invert level', q: 'elevation', get: () => S.zDown + S.S0 * S.L, set: (v) => { S.S0 = S.L > 0 ? (v - S.zDown) / S.L : 0; } },
  { id: 'material', group: 'pipeFields', label: 'Material', options: Object.keys(MATERIALS).concat('Custom') },
  { id: 'n', group: 'pipeFields', label: 'Manning n', q: 'ratio' },
  { id: 'eps', group: 'pipeFields', label: 'Wall roughness (Darcy-Weisbach)', q: 'roughness' },
  { id: 'C', group: 'pipeFields', label: 'Hazen-Williams C', q: 'ratio' },
  { id: 'method', group: 'pipeFields', label: 'Full-pipe friction', options: [['DW', 'Darcy-Weisbach'], ['HW', 'Hazen-Williams']] },
  { id: 'Q', group: 'flowFields', label: 'Flow rate', q: 'flow' },
  { id: 'fluid', group: 'flowFields', label: 'Fluid', options: [['water', 'Water'], ['air', 'Air (incompressible)'], ['custom', 'Custom']] },
  { id: 'T', group: 'flowFields', label: 'Temperature', q: 'temperature', show: () => S.fluid !== 'custom' },
  { id: 'rhoCustom', group: 'flowFields', label: 'Density', q: 'density', show: () => S.fluid === 'custom' },
  { id: 'nuCustom', group: 'flowFields', label: 'Kinematic viscosity', q: 'viscosity', show: () => S.fluid === 'custom' },
  { id: 'endType', group: 'endFields', label: 'End condition', options: [['pressurised', 'Pressurised'], ['steady', 'Steady state (normal depth)'], ['freefall', 'Free fall'], ['level', 'Set water level']] },
  { id: 'pressure', group: 'endFields', label: 'Pressure at outlet (pipe axis, gauge)', q: 'pressure', show: () => S.endType === 'pressurised' },
  { id: 'level', group: 'endFields', label: 'Downstream water level', q: 'elevation', show: () => S.endType === 'level' },
];
const byId = Object.fromEntries(NUM.map((f) => [f.id, f]));
const getSI = (f) => (f.get ? f.get() : S[f.id]);
const setSI = (f, v) => (f.set ? f.set(v) : (S[f.id] = v));

function fluidProps() {
  if (S.fluid === 'custom') return { rho: S.rhoCustom, nu: S.nuCustom, pv: 2339 };
  if (S.fluid === 'air') {
    const Tk = S.T + 273.15;
    const rho = 101325 / (287.05 * Tk);
    const mu = (1.458e-6 * Tk ** 1.5) / (Tk + 110.4);
    return { rho, nu: mu / rho, pv: 0 };
  }
  return waterProps(S.T);
}

// ---------------- Building inputs ----------------
function unitSelect(q, cur, onChange) {
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Unit');
  for (const [u] of QUANTITIES[q].units) {
    const o = document.createElement('option');
    o.value = o.textContent = u;
    if (u === cur) o.selected = true;
    sel.append(o);
  }
  if (QUANTITIES[q].units.length < 2) sel.disabled = true;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function buildInputs() {
  for (const g of ['pipeFields', 'flowFields', 'endFields']) document.getElementById(g).innerHTML = '';
  for (const f of NUM) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.id = 'f-' + f.id;
    const lab = document.createElement('label');
    lab.textContent = f.label;
    lab.htmlFor = 'i-' + f.id;
    wrap.append(lab);
    if (f.options) {
      const sel = document.createElement('select');
      sel.id = 'i-' + f.id;
      for (const opt of f.options) {
        const [v, t] = Array.isArray(opt) ? opt : [opt, opt];
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sel.append(o);
      }
      sel.value = S[f.id];
      sel.addEventListener('change', () => onSelect(f.id, sel.value));
      wrap.append(sel);
    } else {
      units[f.id] ||= defaultUnit(f.q, S.system);
      const row = document.createElement('div');
      row.className = 'row';
      const inp = document.createElement('input');
      inp.id = 'i-' + f.id;
      inp.type = 'number';
      inp.inputMode = 'decimal';
      inp.step = 'any';
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!isFinite(v)) return;
        setSI(f, toSI(f.q, units[f.id], v));
        if (['n', 'eps', 'C'].includes(f.id)) { S.material = 'Custom'; document.getElementById('i-material').value = 'Custom'; }
        refreshValues(f.id);
        recompute();
      });
      row.append(inp, unitSelect(f.q, units[f.id], (u) => { units[f.id] = u; refreshValues(); }));
      wrap.append(row);
    }
    document.getElementById(f.group).append(wrap);
  }
  refreshValues();
}

function onSelect(id, v) {
  S[id] = v;
  if (id === 'material' && MATERIALS[v]) Object.assign(S, pick(MATERIALS[v]));
  if (id === 'fluid' && v === 'air') { S.endType = 'pressurised'; document.getElementById('i-endType').value = 'pressurised'; }
  refreshValues();
  recompute();
}

// Write SI state into every numeric input (except the one being typed in).
function refreshValues(skip) {
  for (const f of NUM) {
    const el = document.getElementById('f-' + f.id);
    if (f.show) el.classList.toggle('hidden', !f.show());
    if (f.options || f.id === skip) continue;
    document.getElementById('i-' + f.id).value = fmt(fromSI(f.q, units[f.id], getSI(f)), 6);
  }
  const endSel = document.getElementById('i-endType');
  for (const o of endSel.options) o.disabled = S.fluid === 'air' && o.value !== 'pressurised';
}

// ---------------- Results ----------------
const vBand = (v) => (v < 0.6 ? ['v-low', 'Low: self-cleansing risk'] : v <= 3 ? ['v-ok', 'OK'] : v <= 6 ? ['v-warn', 'High'] : ['v-bad', 'Too high: erosion risk']);
const RES = [
  { id: 'Vfull', label: 'Velocity (pipe full)', q: 'velocity', get: (r) => r.full.V, band: true },
  { id: 'hf100', label: 'Head loss gradient (pipe full)', q: 'headloss', get: (r) => r.full.Sf },
  { id: 'hfL', label: 'Head loss over length (pipe full)', q: 'head', get: (r) => r.full.Sf * S.L },
  { id: 'dp', label: 'Pressure drop over length (pipe full)', q: 'pressure', get: (r) => r.full.Sf * S.L * r.fl.rho * G },
  { id: 'Re', label: 'Reynolds number', q: 'ratio', get: (r) => r.full.Re },
  { id: 'f', label: 'Darcy friction factor', q: 'ratio', get: (r) => r.full.f },
  { id: 'yn', label: 'Normal depth (Manning)', q: 'head', get: (r) => (r.yn && !r.yn.full ? r.yn.y : null), note: (r) => (!r.yn ? 'None on a flat or rising pipe' : r.yn.full ? 'Gravity capacity exceeded' : 'Filling ' + fmt((r.yn.y / S.D) * 100, 3) + '%'), free: true },
  { id: 'Qmax', label: 'Gravity capacity (max Manning flow)', q: 'flow', get: (r) => (r.yn ? r.yn.Qmax : null), free: true },
  { id: 'yc', label: 'Critical depth', q: 'head', get: (r) => r.yc, note: (r) => 'Filling ' + fmt((r.yc / S.D) * 100, 3) + '%', free: true },
  { id: 'vmin', label: 'Lowest velocity along pipe', q: 'velocity', get: (r) => Math.min(...r.points.map((p) => p.V)), band: true },
  { id: 'vmax', label: 'Highest velocity along pipe', q: 'velocity', get: (r) => Math.max(...r.points.map((p) => p.V)), band: true },
  { id: 'hUp', label: 'Upstream hydraulic grade level', q: 'elevation', get: (r) => r.points[0]?.hgl },
  { id: 'pUp', label: 'Upstream pressure (pipe axis, gauge)', q: 'pressure', get: (r) => { const p = r.points[0]; return p && p.regime === 'full' ? (p.hgl - p.zInv - S.D / 2) * r.fl.rho * G : null; }, note: (r) => (r.points[0]?.regime === 'full' ? '' : 'Free surface at inlet') },
  { id: 'fillUp', label: 'Filling at inlet', q: 'percent', get: (r) => r.points[0]?.fill, note: (r) => regimeName(r.points[0]?.regime) },
  { id: 'fillDn', label: 'Filling at outlet', q: 'percent', get: (r) => r.points.at(-1)?.fill, note: (r) => regimeName(r.points.at(-1)?.regime) },
  { id: 'jumpX', label: 'Hydraulic jump distance from inlet', q: 'length', get: (r) => r.jump?.x ?? null, note: (r) => (r.jump ? `Froude before jump ${fmt(r.jump.F1, 3)}` : 'No jump'), free: true },
  { id: 'air', label: 'Air drawn in by the jump (estimate)', q: 'flow', get: (r) => r.jump?.airQ ?? null, note: (r) => (r.jump ? `Air/water ratio ${fmt(r.jump.airRatio, 3)} (Kalinske & Robertson)` : ''), free: true },
];
const regimeName = (g) => ({ full: 'Pressurised', sub: 'Subcritical', super: 'Supercritical', critical: 'Critical' }[g] || '');

function buildResults() {
  const box = document.getElementById('results');
  box.innerHTML = '';
  for (const d of RES) {
    units['r-' + d.id] ||= defaultUnit(d.q, S.system);
    const el = document.createElement('div');
    el.className = 'result';
    el.id = 'r-' + d.id;
    el.innerHTML = `<div class="field"><label>${d.label}</label></div><div class="field row-wrap"><div class="row"><span class="val"></span></div></div><div class="note"></div>`;
    const row = el.querySelector('.row');
    if (QUANTITIES[d.q].units.length > 1) row.append(unitSelect(d.q, units['r-' + d.id], (u) => { units['r-' + d.id] = u; renderResults(); }));
    else row.insertAdjacentHTML('beforeend', `<span class="note">${QUANTITIES[d.q].units[0][0] === '–' ? '' : QUANTITIES[d.q].units[0][0]}</span>`);
    box.append(el);
  }
}

function renderResults() {
  if (!result) return;
  const liquid = S.fluid !== 'air';
  for (const d of RES) {
    const el = document.getElementById('r-' + d.id);
    const v = result.points.length ? d.get(result) : null;
    el.hidden = (d.free && !liquid) || (d.id === 'f' && S.method !== 'DW');
    el.querySelector('.val').textContent = v === null || v === undefined ? '–' : fmt(fromSI(d.q, units['r-' + d.id], v), 4);
    el.className = 'result';
    if (d.band && v) { const [c, t] = vBand(v); el.classList.add(c); el.querySelector('.note').textContent = t; }
    else el.querySelector('.note').textContent = d.note ? d.note(result) : '';
  }
  const w = document.getElementById('warnings');
  w.innerHTML = '';
  for (const t of result.warnings) { const li = document.createElement('li'); li.textContent = t; w.append(li); }
  renderTable();
}

function renderTable() {
  const r = result;
  const t = document.getElementById('ptable');
  if (!r.points.length) { t.innerHTML = ''; return; }
  const lu = defaultUnit('length', S.system), eu = defaultUnit('elevation', S.system), vu = defaultUnit('velocity', S.system), pu = defaultUnit('pressure', S.system);
  const xs = new Set();
  for (let i = 0; i <= 20; i++) xs.add((S.L * i) / 20);
  if (r.jump) xs.add(r.jump.x);
  const rows = [...xs].sort((a, b) => a - b).map((x) => at(r.points, x));
  t.innerHTML = `<thead><tr><th>Distance (${lu})</th><th>Invert (${eu})</th><th>Filling %</th><th>Velocity (${vu})</th><th>HGL (${eu})</th><th>EGL (${eu})</th><th>Crown pressure (${pu})</th><th>Regime</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${fmt(fromSI('length', lu, p.x), 4)}</td><td>${fmt(fromSI('elevation', eu, p.zInv), 4)}</td><td>${fmt(p.fill * 100, 3)}</td><td>${fmt(fromSI('velocity', vu, p.V), 3)}</td><td>${fmt(fromSI('elevation', eu, p.hgl), 4)}</td><td>${fmt(fromSI('elevation', eu, p.egl), 4)}</td><td>${p.regime === 'full' ? fmt(fromSI('pressure', pu, (p.hgl - p.zInv - S.D) * r.fl.rho * G), 3) : '–'}</td><td style="text-align:left">${regimeName(p.regime)}</td></tr>`).join('')}</tbody>`;
}

function at(pts, x) {
  if (x <= pts[0].x) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1], b = pts[i];
      const f = b.x === a.x ? 1 : (x - a.x) / (b.x - a.x);
      const o = { x, regime: f < 0.5 ? a.regime : b.regime };
      for (const k of ['zInv', 'y', 'hgl', 'egl', 'V', 'fill']) o[k] = a[k] + f * (b[k] - a[k]);
      return o;
    }
  }
  return pts[pts.length - 1];
}

// ---------------- Solve ----------------
function recompute() {
  const fl = fluidProps();
  const inputsOk = S.L > 0 && S.D > 0 && S.Q > 0 && S.n > 0 && S.eps >= 0 && S.C > 0;
  if (!inputsOk) {
    result = { points: [], warnings: ['Check the inputs: length, diameter, flow, n and C must be greater than zero.'], full: {}, fl };
  } else {
    result = solveProfile({
      L: S.L, D: S.D, S0: S.S0, zDown: S.zDown, n: S.n, eps: S.eps, C: S.C, Q: S.Q,
      nu: fl.nu, rho: fl.rho, pv: fl.pv, method: S.method,
      end: { type: S.endType, pressure: S.pressure, level: S.level },
    });
    result.fl = fl;
    if (S.fluid === 'air') {
      const dp = result.full.Sf * S.L * fl.rho * G;
      if (dp > 0.1 * (S.pressure + 101325)) result.warnings.push('Pressure drop exceeds 10% of absolute pressure: the incompressible assumption is no longer reliable.');
      result.warnings = result.warnings.filter((w) => !/vapour|Sub-atmospheric/.test(w));
    }
  }
  renderResults();
  draw();
  renderFill();
}

// ---------------- Partial flow table ----------------
const fillUnits = { flow: null, velocity: null, head: null };
function fillSelects() {
  for (const [id, q] of [['fillQu', 'flow'], ['fillVu', 'velocity'], ['fillYu', 'head']]) {
    const sel = document.getElementById(id);
    fillUnits[q] = defaultUnit(q, S.system);
    sel.innerHTML = QUANTITIES[q].units.map(([u]) => `<option${u === fillUnits[q] ? ' selected' : ''}>${u}</option>`).join('');
    sel.onchange = () => { fillUnits[q] = sel.value; renderFill(); };
  }
}
document.getElementById('fillStep').addEventListener('change', () => renderFill());

function renderFill() {
  const t = document.getElementById('filltable');
  const sum = document.getElementById('fillSummary');
  if (S.fluid === 'air') { sum.textContent = 'Partial flow applies to liquids only.'; t.innerHTML = ''; return; }
  if (!(S.S0 > 0) || !(S.D > 0) || !(S.n > 0)) { sum.textContent = 'Enter a slope greater than zero to see partial flow.'; t.innerHTML = ''; return; }
  const qu = fillUnits.flow, vu = fillUnits.velocity, yu = fillUnits.head;
  const step = +document.getElementById('fillStep').value;
  const pcts = [];
  for (let p = step; p < 100; p += step) pcts.push(p);
  pcts.push(Y_QMAX * 100, 99.99);
  const rows = fillingTable(S.D, S.n, S.S0, [...new Set(pcts)].sort((a, b) => a - b)).map((r) => ({ ...r, Fr: froude(r.Q, r.y, S.D) }));
  const yn = normalDepth(S.Q, S.D, S.n, S.S0);
  let cur = null;
  if (yn && !yn.full) {
    const A = circle(yn.y, S.D).A;
    cur = { pct: (yn.y / S.D) * 100, y: yn.y, Q: S.Q, V: S.Q / A, Fr: froude(S.Q, yn.y, S.D), current: true };
    rows.push(cur);
    rows.sort((a, b) => a.pct - b.pct);
    sum.textContent = `Your flow of ${fmt(fromSI('flow', qu, S.Q), 4)} ${qu} runs ${fmt(cur.pct, 3)}% full, at ${fmt(fromSI('velocity', vu, cur.V), 3)} ${vu} (${cur.Fr > 1 ? 'supercritical' : 'subcritical'}).`;
  } else if (!yn) {
    sum.textContent = 'Enter a flow greater than zero to place your flow in the table.';
  } else {
    sum.textContent = `Your flow of ${fmt(fromSI('flow', qu, S.Q), 4)} ${qu} exceeds the gravity capacity of ${fmt(fromSI('flow', qu, yn.Qmax), 4)} ${qu}; the pipe runs full.`;
  }
  t.innerHTML = `<thead><tr><th>Filling %</th><th>Depth (${yu})</th><th>Flow (${qu})</th><th>Velocity (${vu})</th><th>Froude</th></tr></thead><tbody>${rows.map((r) => {
    const label = r.current ? `${fmt(r.pct, 3)} ← your flow` : Math.abs(r.pct - Y_QMAX * 100) < 1e-6 ? `${fmt(r.pct, 4)} (max flow)` : fmt(r.pct, 4);
    return `<tr class="${r.current ? 'current' : ''}"><td>${label}</td><td>${fmt(fromSI('head', yu, r.y), 4)}</td><td>${fmt(fromSI('flow', qu, r.Q), 4)}</td><td class="vb ${vBand(r.V)[0]}">${fmt(fromSI('velocity', vu, r.V), 3)}</td><td>${fmt(r.Fr, 3)}</td></tr>`;
  }).join('')}</tbody>`;
}

// ---------------- Long section drawing ----------------
const svg = document.getElementById('profile');
const view = { x0: 0, x1: 100 };
const M = { l: 58, r: 14, t: 14, b: 44 };
let lastL = null;

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
  if (lastL !== S.L) { view.x0 = 0; view.x1 = S.L; lastL = S.L; }
  const pts = result?.points || [];
  if (!pts.length) { svg.innerHTML = ''; return; }
  const D = S.D;
  let yMin = Infinity, yMax = -Infinity;
  for (const p of pts) { yMin = Math.min(yMin, p.zInv); yMax = Math.max(yMax, p.egl, p.zInv + D); }
  const pad = (yMax - yMin) * 0.08 || 0.1;
  yMin -= pad; yMax += pad;
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const X = (x) => M.l + ((x - view.x0) / (view.x1 - view.x0)) * pw;
  const Y = (z) => M.t + (1 - (z - yMin) / (yMax - yMin)) * ph;
  const lu = defaultUnit('length', S.system), eu = defaultUnit('elevation', S.system);

  const path = (arr) => arr.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
  const inv = pts.map((p) => [p.x, p.zInv]);
  const crown = pts.map((p) => [p.x, p.zInv + D]);
  const top = pts.map((p) => [p.x, Math.min(p.hgl, p.zInv + D)]);
  const pipePoly = path(inv) + path(crown.slice().reverse()).replace('M', 'L') + 'Z';
  const waterPoly = path(inv) + path(top.slice().reverse()).replace('M', 'L') + 'Z';

  let g = `<defs><clipPath id="plot"><rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph + 24}"/></clipPath></defs>`;
  // grid & axes
  for (const t of niceTicks(yMin, yMax, 5)) g += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--rule)"/><text x="${M.l - 6}" y="${Y(t) + 4}" text-anchor="end">${fmt(fromSI('elevation', eu, t), 4)}</text>`;
  for (const t of niceTicks(view.x0, view.x1, Math.max(3, Math.floor(pw / 90)))) g += `<line x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${M.t + ph}" stroke="var(--rule)" stroke-dasharray="2 4"/><text x="${X(t)}" y="${H - 6}" text-anchor="middle">${fmt(fromSI('length', lu, t), 4)}</text>`;
  g += `<text x="${M.l - 6}" y="${M.t - 2}" text-anchor="end">${eu}</text><text x="${M.l - 6}" y="${H - 6}" text-anchor="end">${lu}</text>`;
  g += `<g clip-path="url(#plot)">`;
  g += `<path d="${pipePoly}" fill="var(--pipe-fill)" stroke="none"/>`;
  g += `<path d="${waterPoly}" fill="var(--water)" stroke="none"/>`;
  g += `<path d="${path(inv)}" fill="none" stroke="var(--pipe)" stroke-width="2"/><path d="${path(crown)}" fill="none" stroke="var(--pipe)" stroke-width="2"/>`;
  g += `<path d="${path(pts.map((p) => [p.x, p.hgl]))}" fill="none" stroke="var(--hgl)" stroke-width="2" stroke-dasharray="6 4"/>`;
  g += `<path d="${path(pts.map((p) => [p.x, p.egl]))}" fill="none" stroke="var(--egl)" stroke-width="2"/>`;
  // regime + velocity strips
  const sy = M.t + ph + 6;
  const regCol = { full: 'var(--full)', sub: 'var(--sub)', super: 'var(--super)', critical: 'var(--bad)' };
  const vCol = (v) => (v < 0.6 ? 'var(--low)' : v <= 3 ? 'var(--ok)' : v <= 6 ? 'var(--warn)' : 'var(--bad)');
  // merge consecutive points with the same category into one bar
  const strip = (key, y) => {
    const runs = [];
    for (let i = 1; i < pts.length; i++) {
      const k = key(pts[i]);
      const last = runs[runs.length - 1];
      if (last && last.k === k) last.x1 = pts[i].x;
      else runs.push({ k, x0: pts[i - 1].x, x1: pts[i].x });
    }
    return runs.map((r) => `<rect x="${X(r.x0)}" y="${y}" width="${Math.max(X(r.x1) - X(r.x0), 1)}" height="6" fill="${r.k}"/>`).join('');
  };
  g += strip((p) => regCol[p.regime === 'critical' ? 'super' : p.regime], sy);
  g += strip((p) => vCol(p.V), sy + 9);
  if (result.jump) g += `<line x1="${X(result.jump.x)}" x2="${X(result.jump.x)}" y1="${M.t}" y2="${M.t + ph}" stroke="var(--super)" stroke-dasharray="3 3"/><text x="${X(result.jump.x) + 4}" y="${M.t + 12}">Jump</text>`;
  g += `</g>`;
  g += `<text x="${M.l - 6}" y="${sy + 6}" text-anchor="end" style="font-size:9px">flow</text><text x="${M.l - 6}" y="${sy + 15}" text-anchor="end" style="font-size:9px">speed</text>`;
  g += `<line id="cross" y1="${M.t}" y2="${M.t + ph}" stroke="var(--muted)" visibility="hidden"/>`;
  svg.innerHTML = g;
  draw.X = X; draw.pw = pw;
}

// zoom / pan along the length axis only
const ptrs = new Map();
let pinch0 = null;
const clampView = () => {
  const span = Math.min(Math.max(view.x1 - view.x0, S.L / 5000), S.L);
  let x0 = Math.min(Math.max(view.x0, 0), S.L - span);
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
  svg.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, x0: view.x0, x1: view.x1 });
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.abs(a.x - b.x), mid: dataX((a.x + b.x) / 2), x0: view.x0, x1: view.x1 }; }
  svg.classList.add('dragging');
});
svg.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (p) {
    p.cur = e.clientX;
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
const endPtr = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; if (!ptrs.size) svg.classList.remove('dragging'); };
svg.addEventListener('pointerup', endPtr);
svg.addEventListener('pointercancel', endPtr);
svg.addEventListener('pointerleave', () => { document.getElementById('readout').hidden = true; const c = document.getElementById('cross'); if (c) c.setAttribute('visibility', 'hidden'); });
document.getElementById('fit').addEventListener('click', () => { view.x0 = 0; view.x1 = S.L; draw(); });
new ResizeObserver(() => draw()).observe(svg);

function showReadout(e) {
  if (!result?.points.length) return;
  const x = dataX(e.clientX);
  const ro = document.getElementById('readout');
  if (x < view.x0 || x > view.x1) { ro.hidden = true; return; }
  const p = at(result.points, x);
  const lu = defaultUnit('length', S.system), eu = defaultUnit('elevation', S.system), vu = defaultUnit('velocity', S.system);
  ro.textContent = `x    ${fmt(fromSI('length', lu, x), 4)} ${lu}\nfill ${fmt(p.fill * 100, 3)} %\nV    ${fmt(fromSI('velocity', vu, p.V), 3)} ${vu}\nHGL  ${fmt(fromSI('elevation', eu, p.hgl), 4)} ${eu}\nEGL  ${fmt(fromSI('elevation', eu, p.egl), 4)} ${eu}\n${regimeName(p.regime)}`;
  ro.hidden = false;
  const r = svg.getBoundingClientRect();
  const px = e.clientX - r.left;
  ro.style.left = (px > r.width / 2 ? px - ro.offsetWidth - 12 : px + 12) + 'px';
  const c = document.getElementById('cross');
  c.setAttribute('x1', draw.X(x)); c.setAttribute('x2', draw.X(x)); c.setAttribute('visibility', 'visible');
}

// ---------------- Unit system switch ----------------
for (const b of document.querySelectorAll('.system button')) {
  b.addEventListener('click', () => {
    S.system = b.dataset.system;
    for (const x of document.querySelectorAll('.system button')) x.setAttribute('aria-pressed', x === b);
    for (const f of NUM) if (f.q) units[f.id] = defaultUnit(f.q, S.system);
    for (const d of RES) units['r-' + d.id] = defaultUnit(d.q, S.system);
    buildInputs(); buildResults(); fillSelects(); recompute();
  });
}
document.getElementById('discBtn').addEventListener('click', () => document.getElementById('discDlg').showModal());

buildInputs();
buildResults();
fillSelects();
recompute();
