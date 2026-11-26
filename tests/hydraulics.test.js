// Checks against published worked examples. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pipeFull, frictionFactor, circle, manningQ, normalDepth, criticalDepth, froude,
  hwSlope, momentum, G,
} from '../js/hydraulics.js';
import { solveProfile } from '../js/profile.js';
import { toSI, fromSI } from '../js/units.js';

const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: got ${a}, expected ${b}`);
const FT = 0.3048, CFS = 0.0283168466;

// Maurer, Hydraulics and Water Resources, Example 4.1
// 20 °C water, Q = 0.416 m3/s, L = 100 m, D = 0.5 m, ks = 0.046 mm
// -> V = 2.120 m/s, Re = 1.036e6, f = 0.0133, hf = 0.61 m (Example 4.4: hf 0.6 m gives Q 0.416)
test('Darcy-Weisbach: Maurer Example 4.1', () => {
  const r = pipeFull(0.416, 0.5, { eps: 0.000046, nu: 1.023e-6, method: 'DW' });
  near(r.V, 2.120, 0.002, 'velocity');
  near(r.Re, 1.036e6, 0.002, 'Reynolds');
  near(r.f, 0.0133, 0.01, 'friction factor');
  near(r.Sf * 100, 0.61, 0.02, 'head loss over 100 m');
});

test('Friction factor: laminar 64/Re', () => {
  near(frictionFactor(1000, 0.001), 0.064, 1e-9, 'laminar f');
});

// CED Engineering, Partially Full Pipe Flow Calculations, Example 7 (SI)
// D = 100 mm, y = 20 mm, S = 0.0085, n = 0.028 -> A = 0.001117 m2, P = 0.0927 m, Rh = 0.01205 m, Q = 0.000193 m3/s, V = 0.173 m/s
test('Circular geometry and Manning flow: CED Example 7', () => {
  const g = circle(0.02, 0.1);
  near(g.A, 0.001117, 0.003, 'area');
  near(g.P, 0.0927, 0.003, 'wetted perimeter');
  near(g.R, 0.01205, 0.003, 'hydraulic radius');
  const Q = manningQ(0.02, 0.1, 0.028, 0.0085);
  near(Q, 0.000193, 0.01, 'flow');
  near(Q / g.A, 0.173, 0.01, 'velocity');
});

// CED Example 8: D = 12 in, y = 10 in, S = 0.0085, n = 0.028 -> Q = 1.55 cfs, V = 2.22 ft/s
// CED Example 6: D = 12 in, y = 4 in,  S = 0.0085, n = 0.028 -> Q = 0.364 cfs, V = 1.59 ft/s
// Normal depth is checked by inverting these. (CED Examples 10-11 use depth-varying n, which this app does not.)
test('Manning flow and normal depth: CED Examples 6 and 8', () => {
  near(manningQ(10 / 12 * FT, FT, 0.028, 0.0085) / CFS, 1.55, 0.01, 'flow, more than half full');
  near(manningQ(4 / 12 * FT, FT, 0.028, 0.0085) / CFS, 0.364, 0.01, 'flow, less than half full');
  near(normalDepth(1.55 * CFS, FT, 0.028, 0.0085).y / FT * 12, 10, 0.01, 'normal depth, more than half full');
  near(normalDepth(0.364 * CFS, FT, 0.028, 0.0085).y / FT * 12, 4, 0.01, 'normal depth, less than half full');
});

test('Normal depth: flow above gravity capacity is reported as full', () => {
  const r = normalDepth(1, 0.3, 0.013, 0.001);
  assert.equal(r.full, true);
});

test('Maximum Manning flow occurs near 93.8% depth', () => {
  const D = 1, n = 0.013, S = 0.001;
  let best = 0, yBest = 0;
  for (let y = 0.80; y < 1; y += 0.0005) { const q = manningQ(y, D, n, S); if (q > best) { best = q; yBest = y; } }
  near(yBest, 0.938, 0.003, 'depth of maximum flow');
});

// Critical depth satisfies Q²T/(gA³) = 1 (Ponce, online channel calculator 07)
test('Critical depth: Froude number equals 1', () => {
  for (const [Q, D] of [[0.05, 0.3], [0.5, 1], [0.0278, 0.254]]) {
    const yc = criticalDepth(Q, D);
    near(froude(Q, yc, D), 1, 1e-4, `Fr at yc for Q=${Q}, D=${D}`);
  }
});

// Hazen-Williams: SI form cross-checked against the US form p[psi/ft] = 4.52 Q[gpm]^1.852 / (C^1.852 d[in]^4.8704)
test('Hazen-Williams: SI and US forms agree', () => {
  const Q = 0.05, D = 0.2, C = 120;
  const siSlope = hwSlope(Q, D, C);
  const gpm = Q / 6.30901964e-5, din = D / 0.0254;
  const psiPerFt = (4.52 * gpm ** 1.852) / (C ** 1.852 * din ** 4.8704);
  const usSlope = (psiPerFt * 6894.757) / (9806.65 * FT); // m water per m
  near(siSlope, usSlope, 0.01, 'friction slope');
});

test('Hydraulic jump: sequent depths have equal momentum', () => {
  const D = 0.6, Q = 0.15;
  const y1 = 0.12;
  const M1 = momentum(Q, y1, D);
  let lo = criticalDepth(Q, D), hi = 0.999 * D;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (momentum(Q, m, D) < M1) lo = m; else hi = m; }
  const y2 = (lo + hi) / 2;
  assert.ok(y2 > y1 && froude(Q, y2, D) < 1, 'sequent depth is subcritical');
});

// ---------- Profile behaviour ----------
const base = { L: 100, D: 0.254, zDown: 0, n: 0.009, eps: 1.5e-6, C: 150, Q: 100 / 3600, nu: 1.004e-6, rho: 998.2, pv: 2339, method: 'DW' };

test('Profile: pressurised pipe HGL rises by Sf·L', () => {
  const r = solveProfile({ ...base, S0: 0, end: { type: 'pressurised', pressure: 10000 } });
  const dh = r.points[0].hgl - r.points.at(-1).hgl;
  near(dh, r.full.Sf * base.L, 1e-6, 'head loss');
});

test('Profile: free fall on mild slope starts at critical depth and approaches normal depth', () => {
  const r = solveProfile({ ...base, L: 1000, S0: 0.002, end: { type: 'freefall' } });
  near(r.points.at(-1).y, r.yc, 0.002, 'outlet depth');
  near(r.points[0].y, r.yn.y, 0.01, 'inlet depth');
});

test('Profile: steady state gives normal depth throughout', () => {
  const r = solveProfile({ ...base, S0: 0.005, end: { type: 'steady' } });
  for (const p of r.points) near(p.y, r.yn.y, 1e-9, 'depth');
});

test('Profile: steep pipe with high tailwater forms a jump inside the pipe', () => {
  const r = solveProfile({ ...base, S0: 0.02, end: { type: 'level', level: 0.3 } });
  assert.ok(r.jump && r.jump.x > 0 && r.jump.x < base.L, 'jump inside pipe');
  assert.ok(r.jump.F1 > 1, 'supercritical before jump');
});

test('Profile: flat pipe with free fall fills toward the inlet', () => {
  const r = solveProfile({ ...base, S0: 0, end: { type: 'freefall' } });
  assert.equal(r.points[0].regime, 'full');
});

// ---------- Units ----------
test('Units: 100 m³/h converts to 27.78 L/s', () => {
  near(fromSI('flow', 'L/s', toSI('flow', 'm³/h', 100)), 27.7778, 1e-5, 'flow');
});
test('Units: 10 in is 254 mm, 68 °F is 20 °C', () => {
  near(fromSI('diameter', 'mm', toSI('diameter', 'in', 10)), 254, 1e-9, 'diameter');
  near(toSI('temperature', '°F', 68), 20, 1e-9, 'temperature');
});
