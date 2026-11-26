// HydroGradeLine – longitudinal profile solver (single section, circular pipe).
// x is measured from the upstream end (0) to the downstream end (L).
// S0 > 0 means the invert falls in the flow direction.
import {
  G, circle, pipeFull, manningSf, normalDepth, criticalDepth, froude,
  specificEnergy, momentum,
} from './hydraulics.js';

const FRAC = 0.04; // depth step as a fraction of the remaining gap
const MAX_STEPS = 4000;

export function solveProfile(p) {
  // p: { L, D, S0, zDown, n, eps, C, Q, nu, rho, method, end:{type, pressure, level} }
  const { L, D, S0, Q } = p;
  const warnings = [];
  const zInv = (x) => p.zDown + S0 * (L - x);
  const Afull = (Math.PI * D * D) / 4;
  const full = pipeFull(Q, D, { eps: p.eps, nu: p.nu, C: p.C, method: p.method });
  const yn = normalDepth(Q, D, p.n, S0);
  const yc = criticalDepth(Q, D);
  const ynVal = yn && !yn.full ? yn.y : null;
  const steep = ynVal !== null && ynVal < yc;

  const freePt = (x, y, regime) => {
    const g = circle(y, D);
    const V = Q / g.A;
    const z = zInv(x);
    const fr = froude(Q, y, D);
    return {
      x, zInv: z, y, hgl: z + y, egl: z + y + (V * V) / (2 * G), V, fill: y / D,
      Fr: fr, regime: regime || (Math.abs(fr - 1) < 0.02 ? 'critical' : fr > 1 ? 'super' : 'sub'),
    };
  };
  const fullPt = (x, hgl) => {
    const z = zInv(x);
    const V = full.V;
    return { x, zInv: z, y: D, hgl, egl: hgl + (V * V) / (2 * G), V, fill: 1, Fr: null, regime: 'full' };
  };

  // ---- march upstream in full (pressurised) state from (xs, hgl)
  function marchFullUp(xs, hgl, out) {
    const Sf = full.Sf;
    let xEnd = 0;
    let reopen = false;
    if (S0 > Sf) {
      const dist = (hgl - zInv(xs) - D) / (S0 - Sf);
      if (dist < xs) { xEnd = xs - Math.max(dist, 0); reopen = true; }
    }
    const n = 40;
    for (let i = 1; i <= n; i++) {
      const x = xs - ((xs - xEnd) * i) / n;
      out.push(fullPt(x, hgl + Sf * (xs - x)));
    }
    if (reopen && xEnd > 0) return { x: xEnd, y: D * 0.9995 };
    return null;
  }

  // ---- march upstream in free-surface (subcritical) state; returns hand-over state
  function marchFreeUp(xs, ys, out, { stopAtCritical = false } = {}) {
    let x = xs;
    let y = ys;
    let target = ynVal !== null ? ynVal : D;
    if (stopAtCritical && target < yc) target = yc;
    for (let k = 0; k < MAX_STEPS && x > 0; k++) {
      const gap = target - y;
      if (Math.abs(gap) < D * 1e-4) {
        if (target === D || (ynVal === null && target >= D * 0.999)) return { toFull: true, x };
        if (target === yc && stopAtCritical) return { hitCritical: true, x };
        out.push(freePt(0, y)); // uniform flow to the inlet
        return null;
      }
      let dy = gap * FRAC;
      const lim = D / 100;
      if (Math.abs(dy) > lim) dy = Math.sign(dy) * lim;
      if (Math.abs(dy) < D * 2e-5) dy = Math.sign(gap) * Math.min(Math.abs(gap), D * 2e-5);
      const y2 = Math.min(y + dy, D * 0.99999);
      const sf = 0.5 * (manningSf(Q, y, D, p.n) + manningSf(Q, y2, D, p.n));
      const dx = (specificEnergy(Q, y2, D) - specificEnergy(Q, y, D)) / (sf - S0);
      if (!(dx > 0) || !isFinite(dx)) {
        if (stopAtCritical) return { hitCritical: true, x };
        warnings.push('Profile reached critical depth before the inlet; upstream control assumed.');
        return null;
      }
      if (x - dx <= 0) {
        const f = x / dx;
        out.push(freePt(0, y + f * (y2 - y)));
        return null;
      }
      x -= dx;
      y = y2;
      out.push(freePt(x, y));
      if (y >= D * 0.9999) return { toFull: true, x };
    }
    return null;
  }

  // ---- generic upstream march from the downstream control
  function upstreamFrom(xs, state) {
    const out = [];
    let cur = state;
    let guard = 0;
    while (cur && guard++ < 20) {
      if (cur.full) {
        out.push(fullPt(cur.x, cur.hgl));
        const r = marchFullUp(cur.x, cur.hgl, out);
        cur = r ? { full: false, x: r.x, y: r.y } : null;
      } else {
        out.push(freePt(cur.x, cur.y));
        const r = marchFreeUp(cur.x, cur.y, out);
        cur = r && r.toFull ? { full: true, x: r.x, hgl: zInv(r.x) + D } : null;
      }
    }
    return out;
  }

  // ---- supercritical march downstream from the inlet (critical depth at entry)
  function superFromInlet() {
    const out = [];
    let x = 0;
    let y = yc * 0.999;
    out.push(freePt(0, y, 'super'));
    for (let k = 0; k < MAX_STEPS && x < L; k++) {
      const gap = ynVal - y;
      if (Math.abs(gap) < D * 1e-4) { out.push(freePt(L, y)); break; }
      let dy = gap * FRAC;
      if (Math.abs(dy) > D / 100) dy = Math.sign(dy) * (D / 100);
      if (Math.abs(dy) < D * 2e-5) dy = Math.sign(gap) * Math.min(Math.abs(gap), D * 2e-5);
      const y2 = y + dy;
      const sf = 0.5 * (manningSf(Q, y, D, p.n) + manningSf(Q, y2, D, p.n));
      const dx = (specificEnergy(Q, y2, D) - specificEnergy(Q, y, D)) / (S0 - sf);
      if (!(dx > 0) || !isFinite(dx)) break;
      if (x + dx >= L) { out.push(freePt(L, y + ((L - x) / dx) * (y2 - y))); break; }
      x += dx;
      y = y2;
      out.push(freePt(x, y));
    }
    return out;
  }

  const ptMomentum = (pt) => (pt.regime === 'full'
    ? (Q * Q) / (G * Afull) + Afull * (pt.hgl - pt.zInv - D / 2)
    : momentum(Q, pt.y, D));
  const at = (pts, x) => {
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].x) {
        const a = pts[i - 1], b = pts[i];
        const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
        const mix = {};
        for (const k of ['zInv', 'y', 'hgl', 'egl', 'V', 'fill']) mix[k] = a[k] + f * (b[k] - a[k]);
        return { ...b, ...mix, x, regime: f < 0.5 ? a.regime : b.regime };
      }
    }
    return pts[pts.length - 1];
  };

  let pts;
  let jump = null;
  const end = p.end || { type: 'pressurised', pressure: 0 };

  if (Q <= 0) {
    return { points: [], warnings: ['Enter a flow greater than zero.'], full, yn, yc, jump };
  }

  if (end.type === 'pressurised') {
    const hgl = p.zDown + D / 2 + end.pressure / (p.rho * G);
    pts = upstreamFrom(L, { full: true, x: L, hgl });
  } else if (end.type === 'steady') {
    if (ynVal === null) {
      warnings.push(S0 <= 0
        ? 'No normal depth on a flat or rising pipe; the pipe is taken as running full.'
        : 'Flow exceeds the pipe’s gravity capacity; the pipe runs full.');
      pts = upstreamFrom(L, { full: true, x: L, hgl: p.zDown + D });
    } else {
      pts = [freePt(0, ynVal), freePt(L, ynVal)];
    }
  } else {
    // free fall or set downstream level
    let yDown = end.type === 'level' ? end.level - p.zDown : yc;
    let outletFull = false;
    if (end.type === 'level') {
      if (yDown >= D) outletFull = true;
      else if (yDown < yc) {
        warnings.push('Downstream level is below critical depth; free outfall assumed at the outlet.');
        yDown = yc;
      }
    }
    if (steep) {
      const sup = superFromInlet();
      if (end.type === 'freefall' || (!outletFull && yDown <= yc * 1.0001)) {
        pts = sup;
      } else {
        // subcritical branch from the downstream control, then locate the jump
        const sub = [];
        let cur = outletFull ? { full: true, x: L, hgl: end.level } : { full: false, x: L, y: yDown };
        let guard = 0;
        while (cur && guard++ < 20) {
          if (cur.full) {
            sub.push(fullPt(cur.x, cur.hgl));
            const r = marchFullUp(cur.x, cur.hgl, sub);
            cur = r ? { full: false, x: r.x, y: r.y } : null;
          } else {
            sub.push(freePt(cur.x, cur.y));
            const r = marchFreeUp(cur.x, cur.y, sub, { stopAtCritical: true });
            cur = r && r.toFull ? { full: true, x: r.x, hgl: zInv(r.x) + D } : null;
          }
        }
        sub.sort((a, b) => a.x - b.x);
        const xs0 = sub[0].x;
        const f = (x) => ptMomentum(at(sup, x)) - ptMomentum(at(sub, x));
        if (f(L) > 0) {
          pts = sup; // jump swept out of the pipe
          warnings.push('Supercritical flow reaches the outlet; the hydraulic jump forms outside the pipe.');
        } else if (xs0 <= 1e-9 && f(0) <= 0) {
          pts = sub; // drowned inlet
        } else {
          let lo = xs0, hi = L;
          for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (f(mid) > 0) lo = mid; else hi = mid;
          }
          const xj = (lo + hi) / 2;
          const before = at(sup, xj);
          const after = at(sub, xj);
          const F1 = froude(Q, before.y, D);
          const beta = 0.0066 * Math.max(F1 - 1, 0) ** 1.4;
          jump = { x: xj, y1: before.y, y2: after.y, F1, airRatio: beta, airQ: beta * Q, full: after.regime === 'full' || after.y >= 0.99 * D };
          if (jump.full) warnings.push('The hydraulic jump fills the pipe (depth after the jump reaches the crown).');
          pts = [...sup.filter((q) => q.x < xj), { ...before, x: xj }, { ...after, x: xj }, ...sub.filter((q) => q.x > xj)];
        }
      }
    } else {
      pts = upstreamFrom(L, outletFull ? { full: true, x: L, hgl: end.level } : { full: false, x: L, y: yDown });
    }
  }

  pts.sort((a, b) => a.x - b.x);
  // pressure at crown (gauge), for sub-atmospheric warnings
  for (const q of pts) q.pCrown = q.regime === 'full' ? (q.hgl - (q.zInv + D)) * p.rho * G : 0;
  if (pts.some((q) => q.pCrown < -1)) warnings.push('Sub-atmospheric pressure in part of the pipe.');
  if (pts.some((q) => q.pCrown + 101325 < p.pv + 1000)) warnings.push('Pressure near vapour pressure: risk of column separation.');

  return { points: pts, warnings, full, yn, yc, jump, steep };
}
