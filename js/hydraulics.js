// HydroGradeLine – core hydraulics. All values in SI (m, s, m3/s, Pa).
export const G = 9.80665;

// ---------- Fluids ----------
// Water properties vs temperature (°C), linear interpolation of standard tables.
const WATER = [
  // T, rho kg/m3, nu m2/s, vapour pressure Pa
  [0, 999.8, 1.787e-6, 611],
  [10, 999.7, 1.307e-6, 1228],
  [20, 998.2, 1.004e-6, 2339],
  [30, 995.7, 0.801e-6, 4246],
  [40, 992.2, 0.658e-6, 7384],
  [60, 983.2, 0.475e-6, 19940],
  [80, 971.8, 0.365e-6, 47390],
  [100, 958.4, 0.294e-6, 101325],
];
function interp(table, t, col) {
  if (t <= table[0][0]) return table[0][col];
  for (let i = 1; i < table.length; i++) {
    if (t <= table[i][0]) {
      const [t0, t1] = [table[i - 1][0], table[i][0]];
      const f = (t - t0) / (t1 - t0);
      return table[i - 1][col] + f * (table[i][col] - table[i - 1][col]);
    }
  }
  return table[table.length - 1][col];
}
export function waterProps(tC = 20) {
  return { rho: interp(WATER, tC, 1), nu: interp(WATER, tC, 2), pv: interp(WATER, tC, 3) };
}

// ---------- Materials ----------
// n: Manning, eps: absolute roughness (m), C: Hazen-Williams. Typical values, editable in UI.
export const MATERIALS = {
  PVC: { n: 0.009, eps: 0.0000015, C: 150 },
  HDPE: { n: 0.009, eps: 0.000007, C: 150 },
  'Ductile iron (lined)': { n: 0.012, eps: 0.00003, C: 140 },
  Steel: { n: 0.012, eps: 0.000045, C: 130 },
  Concrete: { n: 0.013, eps: 0.0003, C: 120 },
  GRP: { n: 0.009, eps: 0.00001, C: 150 },
  'Cast iron': { n: 0.013, eps: 0.00026, C: 110 },
  Clay: { n: 0.013, eps: 0.0006, C: 110 },
};

// ---------- Circular geometry ----------
// y: depth from invert, D: diameter
export function circle(y, D) {
  if (y <= 0) return { A: 0, P: 0, T: 0, R: 0 };
  if (y >= D) return { A: (Math.PI * D * D) / 4, P: Math.PI * D, T: 0, R: D / 4 };
  const th = 2 * Math.acos(1 - (2 * y) / D);
  const A = ((th - Math.sin(th)) * D * D) / 8;
  const P = (th * D) / 2;
  const T = D * Math.sin(th / 2);
  return { A, P, T, R: A / P };
}
// First moment of flow area about the free surface (A·ȳ), numeric.
export function circleMoment(y, D) {
  const N = 60;
  const h = y / N;
  let s = 0;
  for (let i = 0; i <= N; i++) {
    const eta = i * h;
    const b = 2 * Math.sqrt(Math.max(0, eta * (D - eta)));
    const w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
    s += w * (y - eta) * b;
  }
  return (s * h) / 3;
}

// ---------- Pressurised flow ----------
export function frictionFactor(Re, relRough) {
  if (Re < 1e-9) return 0;
  if (Re < 2300) return 64 / Re;
  // Colebrook-White, iterated from Swamee-Jain start
  let f = 0.25 / Math.log10(relRough / 3.7 + 5.74 / Re ** 0.9) ** 2;
  for (let i = 0; i < 50; i++) {
    const rhs = -2 * Math.log10(relRough / 3.7 + 2.51 / (Re * Math.sqrt(f)));
    const fn = 1 / (rhs * rhs);
    if (Math.abs(fn - f) < 1e-12) { f = fn; break; }
    f = fn;
  }
  return f;
}
// Darcy-Weisbach friction slope for a full section with hydraulic diameter Dh, area A.
export function dwSlope(Q, A, Dh, eps, nu) {
  const V = Q / A;
  const Re = (Math.abs(V) * Dh) / nu;
  const f = frictionFactor(Re, eps / Dh);
  return { Sf: (f * V * Math.abs(V)) / (Dh * 2 * G), f, Re, V };
}
export function hwSlope(Q, D, C) {
  return (10.67 * Math.abs(Q) ** 1.852) / (C ** 1.852 * D ** 4.8704);
}
export function pipeFull(Q, D, opts) {
  const A = (Math.PI * D * D) / 4;
  const dw = dwSlope(Q, A, D, opts.eps, opts.nu);
  const Sf = opts.method === 'HW' ? hwSlope(Q, D, opts.C) : dw.Sf;
  return { A, V: dw.V, Re: dw.Re, f: dw.f, Sf };
}

// ---------- Manning partial flow ----------
export function manningQ(y, D, n, S) {
  const g = circle(y, D);
  if (g.A === 0 || S <= 0) return 0;
  return (g.A * g.R ** (2 / 3) * Math.sqrt(S)) / n;
}
export function manningSf(Q, y, D, n) {
  const g = circle(y, D);
  return (n * n * Q * Q) / (g.A * g.A * g.R ** (4 / 3));
}
function bisect(fn, lo, hi, it = 100) {
  let flo = fn(lo);
  for (let i = 0; i < it; i++) {
    const mid = (lo + hi) / 2;
    const fm = fn(mid);
    if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}
export const Y_QMAX = 0.9382; // depth ratio of maximum Manning flow, circular
// Normal depth; returns null if S<=0, or {full:true} if Q exceeds capacity.
export function normalDepth(Q, D, n, S) {
  if (S <= 0 || Q <= 0) return null;
  const Qmax = manningQ(Y_QMAX * D, D, n, S);
  if (Q > Qmax) return { full: true, Qmax };
  const y = bisect((y) => manningQ(y, D, n, S) - Q, 1e-9 * D, Y_QMAX * D);
  return { full: false, y, Qmax };
}
export function froude(Q, y, D) {
  const g = circle(y, D);
  if (g.T <= 0) return 0;
  const V = Q / g.A;
  return V / Math.sqrt((G * g.A) / g.T);
}
export function criticalDepth(Q, D) {
  if (Q <= 0) return 0;
  const yHi = 0.9999 * D;
  if (froude(Q, yHi, D) > 1) return yHi; // flow too large: critical at crown
  return bisect((y) => froude(Q, y, D) - 1, 1e-9 * D, yHi);
}
export function specificEnergy(Q, y, D) {
  const A = circle(y, D).A;
  return y + (Q / A) ** 2 / (2 * G);
}
export function momentum(Q, y, D) {
  const A = circle(y, D).A;
  return (Q * Q) / (G * A) + circleMoment(y, D);
}
// Filling table: rows of filling % -> Q, V
export function fillingTable(D, n, S, steps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 93.82, 99.99]) {
  return steps.map((p) => {
    const y = (p / 100) * D;
    const Q = manningQ(y, D, n, S);
    const A = circle(y, D).A;
    return { pct: p, y, Q, V: A ? Q / A : 0 };
  });
}
