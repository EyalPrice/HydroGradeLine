// HydroGradeLine – multi-section profile solver (circular pipes).
//
// The run is a chain of sections listed from upstream to downstream. Distances:
//   s = chainage along the pipe axis (used for friction), x = horizontal chainage (used for drawing and markers).
// Method (as in HEC-RAS mixed-regime runs):
//   1. Subcritical pass: standard step from the downstream boundary to the inlet. Full-pipe reaches are
//      "sealed" (no air), so they stay full even below atmospheric pressure (siphon) unless an air vent
//      is open or the inlet is not submerged.
//   2. Supercritical passes: from every control (choked section, inlet of a steep reach, gate, orifice,
//      open vent) downstream on the supercritical branch.
//   3. At each node the regime with the larger specific force (momentum) wins; switches from
//      supercritical to subcritical are hydraulic jumps.
import {
  G, circle, pipeFull, manningSf, normalDepth, criticalDepth, froude, specificEnergy, momentum,
} from './hydraulics.js';

const NODES_PER_SECTION = 150;
const EPS = 1e-9;

// ---------- opening shapes for orifices and gates (width b(h) above the opening bottom) ----------
const pipeWidth = (D, h) => (h <= 0 || h >= D ? 0 : 2 * Math.sqrt(h * (D - h)));
export function openingShape(m, D) {
  if (m.type === 'orifice' && m.shape === 'square') {
    const a = Math.min(m.size, D);
    return { off: 0, top: a, b: () => a };
  }
  if (m.type === 'orifice') {
    const d = Math.min(m.size, D);
    return { off: 0, top: d, b: (h) => pipeWidth(d, h) };
  }
  if (m.type === 'gate' && m.gate === 'bottom') {
    const p = Math.min(Math.max(m.size, 0), D * 0.999);
    return { off: p, top: D - p, b: (h) => pipeWidth(D, p + h) };
  }
  // top gate: opening of height a above the invert
  const a = Math.min(Math.max(m.size, 0), D);
  return { off: 0, top: a, b: (h) => pipeWidth(D, h) };
}
function shapeArea(sh, y) {
  const top = Math.min(y, sh.top);
  if (top <= 0) return 0;
  const N = 64, h = top / N;
  let s = 0;
  for (let i = 0; i <= N; i++) s += (i === 0 || i === N ? 1 : i % 2 ? 4 : 2) * sh.b(i * h);
  return (s * h) / 3;
}
function shapeCentroid(sh) {
  const N = 64, h = sh.top / N;
  let m = 0, a = 0;
  for (let i = 0; i <= N; i++) {
    const w = (i === 0 || i === N ? 1 : i % 2 ? 4 : 2) * sh.b(i * h);
    m += w * i * h; a += w;
  }
  return a ? m / a : 0;
}
function shapeCritical(sh, Q) {
  const fr = (y) => { const A = shapeArea(sh, y), T = sh.b(y); return T > 0 && A > 0 ? Q / A / Math.sqrt((G * A) / T) : Infinity; };
  const hi = sh.top * 0.999;
  if (fr(hi) > 1) return null; // the opening would run full: orifice behaviour
  let lo = sh.top * 1e-6, h = hi;
  for (let i = 0; i < 80; i++) { const mid = (lo + h) / 2; if (fr(mid) > 1) lo = mid; else h = mid; }
  return (lo + h) / 2;
}

// ---------- depth from specific energy ----------
function depthFromE(Q, D, E, branch, yc) {
  // subcritical branch: y in [yc, D); supercritical: y in (0, yc]
  let lo = branch === 'sub' ? yc : D * 1e-5;
  let hi = branch === 'sub' ? D * 0.99999 : yc;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const e = specificEnergy(Q, mid, D);
    if (branch === 'sub' ? e < E : e > E) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function solveRun(run) {
  const { Q, sections, markers = [], end, method, fluid } = run;
  const liquid = fluid.liquid !== false;
  const warnings = [];
  const notes = new Set();

  // ---- section geometry from the downstream invert upwards
  const secs = sections.map((s) => ({ ...s }));
  let zd = run.zDown;
  for (let i = secs.length - 1; i >= 0; i--) {
    const sc = secs[i];
    const c = 1 / Math.sqrt(1 + sc.S0 * sc.S0);
    sc.Lh = sc.L * c; // horizontal length
    sc.sinA = sc.S0 * c; // drop per unit length along the pipe
    sc.zDn = zd;
    sc.zUp = zd + sc.S0 * sc.Lh;
    zd = sc.zUp;
  }
  let xAcc = 0, sAcc = 0;
  for (const sc of secs) {
    sc.x0 = xAcc; sc.s0 = sAcc; xAcc += sc.Lh; sAcc += sc.L;
    sc.full = pipeFull(Q, sc.D, { eps: sc.eps, nu: fluid.nu, C: sc.C, method });
    sc.Af = (Math.PI * sc.D * sc.D) / 4;
    sc.yc = criticalDepth(Q, sc.D);
    sc.Ec = specificEnergy(Q, sc.yc, sc.D);
    sc.yn = normalDepth(Q, sc.D, sc.n, sc.sinA);
    sc.steep = !!(sc.yn && !sc.yn.full && sc.yn.y < sc.yc);
  }
  const totalX = xAcc;

  // ---- nodes
  const nodes = [];
  const mkNode = (sc, si, ls, marker, side) => ({
    sec: si, s: sc.s0 + ls, x: sc.x0 + (ls / sc.L) * sc.Lh, z: sc.zUp - ls * sc.sinA, D: sc.D, marker, side,
  });
  const sorted = markers
    .map((m) => ({ ...m, x: Math.min(Math.max(m.x, 0), totalX) }))
    .sort((a, b) => a.x - b.x);
  secs.forEach((sc, si) => {
    const mk = sorted
      .filter((m) => m.x >= sc.x0 - EPS && (m.x < sc.x0 + sc.Lh - EPS || (si === secs.length - 1 && m.x <= sc.x0 + sc.Lh + EPS)))
      .map((m) => ({ m, ls: Math.min(Math.max(((m.x - sc.x0) / sc.Lh) * sc.L, sc.L * 1e-4), sc.L * (1 - 1e-4)) }));
    const pos = [];
    for (let i = 0; i <= NODES_PER_SECTION; i++) pos.push({ ls: (sc.L * i) / NODES_PER_SECTION });
    for (const { m, ls } of mk) pos.push({ ls, m, side: 'u' }, { ls, m, side: 'd' });
    pos.sort((a, b) => a.ls - b.ls || (a.side === 'd') - (b.side === 'd'));
    for (const p of pos) nodes.push(mkNode(sc, si, p.ls, p.m, p.side));
  });
  const N = nodes.length;
  const secOf = (k) => secs[nodes[k].sec];

  // ---- state helpers
  const fullState = (k, hgl) => {
    const sc = secOf(k), V = Q / sc.Af;
    return { mode: 'full', y: sc.D, hgl, H: hgl + (V * V) / (2 * G), V };
  };
  const freeState = (k, y, mode = 'free') => {
    const nd = nodes[k], sc = secOf(k), A = circle(y, sc.D).A, V = Q / A;
    return { mode, y, hgl: nd.z + y, H: nd.z + y + (V * V) / (2 * G), V };
  };
  const Sf = (k, st) => (st.mode === 'full' ? secOf(k).full.Sf : manningSf(Q, st.y, secOf(k).D, secOf(k).n));
  const crown = (k) => nodes[k].z + nodes[k].D;
  // state on the subcritical side from a total energy level
  function subFromH(k, H, sealed) {
    const nd = nodes[k], sc = secOf(k);
    const Vf = Q / sc.Af;
    const hglFull = H - (Vf * Vf) / (2 * G);
    if (!liquid || sealed || hglFull >= crown(k)) return fullState(k, hglFull);
    const E = H - nd.z;
    if (E < sc.Ec) return { ...freeState(k, sc.yc, 'crit'), choke: true };
    return freeState(k, depthFromE(Q, sc.D, E, 'sub', sc.yc));
  }
  const momentumOf = (k, st) => {
    const sc = secOf(k);
    if (st.mode === 'full') return (Q * Q) / (G * sc.Af) + sc.Af * (st.hgl - nodes[k].z - sc.D / 2);
    return momentum(Q, st.y, sc.D);
  };

  // ---- steady state: normal depth in every section (no profile calculation)
  if (liquid && end.type === 'steady' && secs.every((sc) => sc.yn && !sc.yn.full)) {
    const points = nodes.map((nd) => {
      const sc = secs[nd.sec], y = sc.yn.y, A = circle(y, sc.D).A, V = Q / A, fr = froude(Q, y, sc.D);
      return { x: nd.x, s: nd.s, sec: nd.sec, zInv: nd.z, D: sc.D, y, hgl: nd.z + y, egl: nd.z + y + (V * V) / (2 * G), V, fill: y / sc.D, Fr: fr, regime: Math.abs(fr - 1) < 0.02 ? 'critical' : fr > 1 ? 'super' : 'sub', pCrown: 0, marker: nd.marker ? nd.marker.id : null, side: nd.side };
    });
    if (markers.length) warnings.push('Steady state assumes normal depth throughout; fittings and controls are ignored. Use another end condition to include them.');
    return { points, warnings, jumps: [], secs, ventsOpen: [], totalX, nodes };
  }

  // ---- downstream boundary
  const last = N - 1, lsc = secOf(last);
  let bc;
  if (!liquid || end.type === 'pressurised') bc = fullState(last, nodes[last].z + lsc.D / 2 + end.pressure / (fluid.rho * G));
  else if (end.type === 'steady') {
    if (lsc.yn && !lsc.yn.full) bc = lsc.steep ? freeState(last, lsc.yc, 'crit') : freeState(last, lsc.yn.y);
    else {
      bc = fullState(last, crown(last));
      warnings.push(lsc.sinA <= 0 ? 'No normal depth on a flat or rising last section; the outlet is taken as running full.' : 'Flow exceeds the last section’s gravity capacity; the outlet runs full.');
    }
  } else if (end.type === 'freefall') bc = freeState(last, lsc.yc, 'crit');
  else {
    const y = end.level - nodes[last].z;
    if (y >= lsc.D) bc = fullState(last, end.level);
    else if (y < lsc.yc) { bc = freeState(last, lsc.yc, 'crit'); warnings.push('Downstream level is below critical depth; free outfall assumed at the outlet.'); }
    else bc = freeState(last, y);
  }

  // ---- 1. subcritical pass
  const sub = new Array(N);
  const supStarts = [];
  const ventsOpen = new Set();
  const ventNodes = new Set();
  function stepUp(k, d, sealed) {
    // compute sub[k] from the downstream state d = sub[k+1]
    const a = nodes[k], b = nodes[k + 1];
    if (a.marker && a.side === 'u' && b.marker === a.marker) return markerUp(k, d, a.marker, sealed);
    const ds = b.s - a.s;
    let lossK = 0;
    if (ds <= EPS && a.sec !== b.sec) lossK = secs[b.sec].kJoint || 0;
    const local = (lossK * d.V * d.V) / (2 * G);
    let sf1 = Sf(k + 1, d), st;
    for (let it = 0; it < 6; it++) {
      const H = d.H + 0.5 * (sf1 + Sf(k + 1, d)) * ds + local;
      st = subFromH(k, H, sealed && d.mode === 'full');
      const n1 = Sf(k, st);
      if (Math.abs(n1 - sf1) < 1e-12) break;
      sf1 = n1;
    }
    return st;
  }
  function markerUp(k, d, m, sealed) {
    const sc = secOf(k), nd = nodes[k];
    const sealedHere = sealed && d.mode === 'full';
    if (m.type === 'loss') return subFromH(k, d.H + ((m.K || 0) * d.V * d.V) / (2 * G), sealedHere);
    if (m.type === 'vent') {
      if (d.mode === 'full' && d.hgl < crown(k)) {
        ventsOpen.add(m.id);
        ventNodes.add(k + 1);
        return fullState(k, crown(k));
      }
      return { ...d };
    }
    // orifice or gate
    const sh = openingShape(m, sc.D);
    if (m.type === 'gate' && m.gate !== 'bottom' && m.size >= sc.D * 0.999) return { ...d };
    if (m.type === 'gate' && m.gate === 'bottom' && m.size <= 0) return { ...d };
    const Cd = m.Cd || 0.61, Cc = m.Cc || 0.61;
    const Ao = shapeArea(sh, sh.top);
    const topLevel = nd.z + sh.off + sh.top;
    const jetDepth = () => {
      const Aj = Cc * Ao;
      let lo = sc.D * 1e-5, hi = sc.D * 0.99999;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (circle(mid, sc.D).A < Aj) lo = mid; else hi = mid; }
      return sh.off > 0 ? null : (lo + hi) / 2;
    };
    let H, control = false, superY = null;
    if (d.mode === 'full' || !liquid) {
      // pipe full on both sides: Borda–Carnot loss of the jet
      const Vj = Q / (Cc * Ao);
      H = d.H + ((Vj - d.V) ** 2) / (2 * G);
      return subFromH(k, H, sealedHere);
    }
    const ycO = shapeCritical(sh, Q);
    if (ycO !== null) {
      // free-surface constriction (weir-like): needs at least critical energy in the opening
      const Ao2 = shapeArea(sh, ycO);
      const Hcrit = nd.z + sh.off + ycO + (Q * Q) / (2 * G * Ao2 * Ao2);
      // when the tailwater drowns the opening, the loss is the expansion from the opening to the pipe
      const yIn = Math.max(d.y - sh.off, ycO);
      const Ain = shapeArea(sh, Math.min(yIn, sh.top));
      const Hpass = d.H + (Math.max(Q / Ain - d.V, 0) ** 2) / (2 * G);
      if (Hcrit > Hpass) { H = Hcrit; control = true; } else H = Hpass;
      if (control) {
        const E = H - nd.z;
        superY = E > sc.Ec ? depthFromE(Q, sc.D, E, 'super', sc.yc) : null;
      }
    } else if (d.hgl > topLevel && (sh.off > 0 || momentumOf(k + 1, d) >= momentum(Q, jetDepth(), sc.D))) {
      // tailwater above the opening and strong enough to hold the jump against it
      // drowned orifice / sluice
      const dh = (Q / (Cd * Ao)) ** 2 / (2 * G);
      const st = subFromH(k, d.hgl + dh + (d.V * d.V) / (2 * G), false);
      return st;
    } else {
      // free orifice / sluice discharging to a lower water level
      const Hfree = nd.z + sh.off + shapeCentroid(sh) + (Q / (Cd * Ao)) ** 2 / (2 * G);
      if (Hfree > d.H) { H = Hfree; control = true; superY = jetDepth(); } else H = d.H;
    }
    const st = subFromH(k, H, false);
    if (control) {
      m._active = true;
      if (superY !== null && superY < sc.yc) supStarts.push({ k: k + 1, y: superY, why: m.type });
      if (st.mode === 'full' && m.type !== 'gate') notes.add('orifice-full');
    }
    return st;
  }

  function marchUp(from, startState, sealedStart) {
    sub[from] = startState;
    let sealed = sealedStart;
    for (let k = from - 1; k >= 0; k--) {
      sub[k] = stepUp(k, sub[k + 1], sealed);
      if (sub[k].mode !== 'full') sealed = true; // a later full reach upstream is sealed from the air
    }
  }
  marchUp(last, bc, true);
  // inlet not submerged: air enters from the inlet, re-march the negative reach next to it
  for (let pass = 0; pass < 5 && liquid; pass++) {
    let j = -1;
    for (let k = 0; k < N; k++) {
      if (sub[k].mode === 'full' && sub[k].hgl < crown(k) - 1e-9) j = k; else break;
    }
    if (j < 0) break;
    if (j === last) { break; }
    // re-march from j+1 with air available
    for (let k = j; k >= 0; k--) {
      const d = sub[k + 1];
      sub[k] = stepUp(k, d, false);
    }
  }

  // open vents let air into the reach just downstream: re-march it with a free surface
  for (const kv of [...ventNodes].sort((a, b) => b - a)) {
    let j = kv - 1;
    while (j + 1 < last && sub[j + 1].mode === 'full' && sub[j + 1].hgl < crown(j + 1) - 1e-9) j++;
    if (j < kv) continue;
    for (let k = j; k >= kv; k--) sub[k] = stepUp(k, sub[k + 1], false);
  }

  // chokes become supercritical start points (inlet of steep reaches, breaks of slope)
  for (let k = 0; k < N; k++) {
    if (sub[k].choke && (k === 0 || !sub[k - 1].choke)) supStarts.push({ k, y: secOf(k).yc * 0.999, why: 'critical' });
    if (sub[k].choke && k > 0 && nodes[k].marker && nodes[k].side === 'u') notes.add('choke');
  }
  if (liquid && sub[0].mode !== 'full' && secs[0].steep) supStarts.push({ k: 0, y: secs[0].yc * 0.999, why: 'inlet' });

  // ---- 2. supercritical passes
  const sup = new Array(N).fill(null);
  function supStep(k, u) {
    // from upstream state u at node k to node k+1
    const a = nodes[k], b = nodes[k + 1];
    if (a.marker && a.side === 'u' && b.marker === a.marker) {
      const m = a.marker;
      if (m.type === 'vent') return { ...u };
      if (m.type === 'loss') {
        const H = u.H - ((m.K || 0) * u.V * u.V) / (2 * G);
        if (H - b.z < secOf(k + 1).Ec) { notes.add('choke-super'); return null; }
        return freeState(k + 1, depthFromE(Q, b.D, H - b.z, 'super', secOf(k + 1).yc));
      }
      return null; // supercritical flow meets an orifice or gate: a jump forms upstream of it
    }
    const ds = b.s - a.s;
    const lossK = ds <= EPS && a.sec !== b.sec ? secs[b.sec].kJoint || 0 : 0;
    let sf2 = Sf(k, u), st = null;
    for (let it = 0; it < 6; it++) {
      const H = u.H - 0.5 * (Sf(k, u) + sf2) * ds - (lossK * u.V * u.V) / (2 * G);
      const E = H - b.z, sc = secOf(k + 1);
      if (E < sc.Ec) return null;
      st = freeState(k + 1, depthFromE(Q, sc.D, E, 'super', sc.yc));
      const n2 = Sf(k + 1, st);
      if (Math.abs(n2 - sf2) < 1e-12) break;
      sf2 = n2;
    }
    return st;
  }
  if (liquid) {
    for (const st of supStarts.sort((a, b) => a.k - b.k)) {
      let u = freeState(st.k, Math.min(st.y, secOf(st.k).yc));
      if (!sup[st.k] || momentumOf(st.k, u) > momentumOf(st.k, sup[st.k])) sup[st.k] = u;
      for (let k = st.k; k < last; k++) {
        const nx = supStep(k, sup[k] && momentumOf(k, sup[k]) >= momentumOf(k, u) ? sup[k] : u);
        if (!nx) break;
        if (sup[k + 1] && momentumOf(k + 1, sup[k + 1]) >= momentumOf(k + 1, nx)) break;
        sup[k + 1] = nx;
        u = nx;
      }
    }
  }

  // ---- 3. choose regime by specific force, find jumps
  const pick = new Array(N);
  for (let k = 0; k < N; k++) {
    const s = sub[k], p = sup[k];
    pick[k] = p && (s.mode === 'crit' || momentumOf(k, p) > momentumOf(k, s)) ? { ...p, branch: 'super' } : { ...s, branch: 'sub' };
  }
  const jumps = [];
  for (let k = 0; k < last; k++) {
    if (pick[k].branch === 'super' && pick[k + 1].branch === 'sub' && pick[k + 1].mode !== 'crit') {
      const f0 = momentumOf(k, sup[k]) - momentumOf(k, sub[k]);
      const f1 = sup[k + 1] ? momentumOf(k + 1, sup[k + 1]) - momentumOf(k + 1, sub[k + 1]) : -f0;
      const t = f0 - f1 !== 0 ? Math.min(Math.max(f0 / (f0 - f1), 0), 1) : 1;
      const x = nodes[k].x + t * (nodes[k + 1].x - nodes[k].x);
      const y1 = sup[k].y, after = sub[k + 1];
      const F1 = froude(Q, y1, secOf(k).D);
      const beta = 0.0066 * Math.max(F1 - 1, 0) ** 1.4;
      const isFull = after.mode === 'full' || after.y >= 0.99 * secOf(k + 1).D;
      jumps.push({ x, k, y1, y2: after.y, F1, airRatio: beta, airQ: beta * Q, full: isFull });
      if (isFull) notes.add('jump-full');
    }
  }

  // ---- output points
  const points = nodes.map((nd, k) => {
    const st = pick[k], sc = secOf(k);
    const fr = st.mode === 'full' ? null : froude(Q, st.y, sc.D);
    const regime = st.mode === 'full' ? 'full' : Math.abs(fr - 1) < 0.02 || st.mode === 'crit' ? 'critical' : fr > 1 ? 'super' : 'sub';
    return {
      x: nd.x, s: nd.s, sec: nd.sec, zInv: nd.z, D: sc.D, y: st.y, hgl: st.hgl, egl: st.H, V: st.V, fill: st.y / sc.D,
      Fr: fr, regime, pCrown: st.mode === 'full' ? (st.hgl - crown(k)) * fluid.rho * G : 0, marker: nd.marker ? nd.marker.id : null, side: nd.side,
    };
  });

  // ---- warnings
  if (notes.has('choke')) warnings.push('A local loss chokes the flow: upstream depth was raised to critical depth plus the loss.');
  if (notes.has('choke-super')) warnings.push('A local loss in supercritical flow would drop the energy below critical: the flow chokes and a jump forms upstream of it.');
  if (notes.has('jump-full')) warnings.push('A hydraulic jump fills the pipe (depth after the jump reaches the crown).');
  if (ventsOpen.size) warnings.push(`Air vent${ventsOpen.size > 1 ? 's' : ''} open: pressure limited to atmospheric at the vent; the pipe runs partly full downstream of it.`);
  if (liquid && points.some((q) => q.pCrown < -1000)) warnings.push('Sub-atmospheric pressure in part of the run (siphon). Add an air vent if this is not intended.');
  if (liquid && points.some((q) => q.pCrown + 101325 < fluid.pv + 1000)) warnings.push('Pressure near vapour pressure: risk of column separation. The siphon cannot hold.');
  for (const m of sorted) if (m._active && m.type !== 'vent') notes.add('ctl');

  return { points, warnings, jumps, secs, ventsOpen: [...ventsOpen], totalX, nodes };
}

// Compatibility wrapper for a single section (used by tests and simple callers).
export function solveProfile(p) {
  const r = solveRun({
    Q: p.Q, zDown: p.zDown, method: p.method,
    fluid: { nu: p.nu, rho: p.rho, pv: p.pv ?? 2339 },
    sections: [{ L: p.L, D: p.D, S0: p.S0, n: p.n, eps: p.eps, C: p.C }],
    markers: p.markers || [],
    end: p.end || { type: 'pressurised', pressure: 0 },
  });
  const sc = r.secs[0];
  return { ...r, full: sc.full, yn: sc.yn, yc: sc.yc, steep: sc.steep, jump: r.jumps[0] || null };
}
