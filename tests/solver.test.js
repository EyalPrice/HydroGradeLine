// Behaviour of the multi-section solver: sections, fittings, vents, orifices, gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveRun } from '../js/solver.js';
import { G } from '../js/hydraulics.js';

const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: got ${a}, expected ${b}`);
const fluid = { nu: 1.004e-6, rho: 998.2, pv: 2339 };
const pvc = { n: 0.009, eps: 1.5e-6, C: 150 };
const D = 0.254, Q = 100 / 3600;
const run = (o) => solveRun({ Q, zDown: 0, method: 'DW', fluid, end: { type: 'pressurised', pressure: 10000 }, markers: [], ...o });
// ground pipe, riser 10 m up, bridge, 10 m drop, ground pipe to the outlet
const bridge = [
  { L: 200, D, S0: 0, ...pvc }, { L: 10, D, S0: -10, ...pvc }, { L: 50, D, S0: 0.002, ...pvc },
  { L: 10, D, S0: 10, ...pvc }, { L: 200, D, S0: 0.001, ...pvc },
];

test('Two sections in series: head loss adds up', () => {
  const one = run({ sections: [{ L: 100, D, S0: 0, ...pvc }] });
  const two = run({ sections: [{ L: 60, D, S0: 0, ...pvc }, { L: 40, D, S0: 0, ...pvc }] });
  near(two.points[0].hgl, one.points[0].hgl, 1e-9, 'inlet HGL');
});

test('Joint K and ruler K add K·v²/2g with the downstream velocity', () => {
  const base = run({ sections: [{ L: 100, D, S0: 0, ...pvc }] });
  const V = base.points[0].V;
  const k = run({ sections: [{ L: 100, D, S0: 0, ...pvc }], markers: [{ id: 'k', type: 'loss', x: 40, K: 2 }] });
  near(k.points[0].hgl - base.points[0].hgl, (2 * V * V) / (2 * G), 1e-6, 'ruler K');
  const j = run({ sections: [{ L: 50, D, S0: 0, ...pvc }, { L: 50, D, S0: 0, ...pvc, kJoint: 2 }] });
  near(j.points[0].hgl - base.points[0].hgl, (2 * V * V) / (2 * G), 1e-6, 'joint K');
});

test('Expansion to a larger pipe uses the downstream (larger pipe) velocity', () => {
  const r = run({ sections: [{ L: 50, D: 0.2, S0: 0, ...pvc }, { L: 50, D: 0.4, S0: 0, ...pvc, kJoint: 1 }] });
  const i = r.points.findIndex((p, k) => k > 0 && p.sec === 1 && r.points[k - 1].sec === 0);
  const up = r.points[i - 1], dn = r.points[i];
  near(up.egl - dn.egl, (dn.V * dn.V) / (2 * G), 1e-6, 'joint loss');
});

test('Pipe bridge without a vent runs as a siphon (below atmospheric at the top)', () => {
  const r = run({ sections: bridge, end: { type: 'pressurised', pressure: 5000 } });
  const minP = Math.min(...r.points.map((p) => p.pCrown));
  assert.ok(minP < -50000, `crown pressure ${minP}`);
  assert.ok(r.warnings.some((w) => /Sub-atmospheric/.test(w)));
});

test('Pipe bridge with a vent: pressure held at atmospheric, partly full downstream, jump below', () => {
  const r = run({ sections: bridge, markers: [{ id: 'v', type: 'vent', x: 250.5 }], end: { type: 'pressurised', pressure: 5000 } });
  assert.deepEqual(r.ventsOpen, ['v']);
  const minP = Math.min(...r.points.map((p) => p.pCrown));
  assert.ok(minP > -1000, `crown pressure ${minP}`);
  assert.ok(r.points.some((p) => p.regime === 'super'), 'supercritical on the drop');
  assert.equal(r.jumps.length, 1);
  assert.ok(r.jumps[0].x > 250 && r.jumps[0].x < 260, `jump at ${r.jumps[0].x}`);
  // upstream of the vent the grade line sits at the crown of the vent
  const v = r.points.find((p) => p.marker === 'v' && p.side === 'u');
  near(v.hgl, v.zInv + D, 1e-9, 'HGL at vent');
});

test('Vent stays closed when pressure is positive', () => {
  const r = run({ sections: [{ L: 100, D, S0: 0, ...pvc }], markers: [{ id: 'v', type: 'vent', x: 50 }] });
  assert.deepEqual(r.ventsOpen, []);
});

test('Orifice in a full pipe: Borda–Carnot loss of the contracted jet', () => {
  const base = run({ sections: [{ L: 100, D: 0.3, S0: 0, ...pvc }] });
  const r = run({ sections: [{ L: 100, D: 0.3, S0: 0, ...pvc }], markers: [{ id: 'o', type: 'orifice', shape: 'circle', size: 0.1, x: 50, Cd: 0.61, Cc: 0.61 }] });
  const V = base.points[0].V, Vj = Q / (0.61 * Math.PI * 0.01 / 4);
  near(r.points[0].hgl - base.points[0].hgl, (Vj - V) ** 2 / (2 * G), 0.01, 'orifice loss');
});

test('Free orifice in a partly full pipe: Q = Cd·A·√(2gh), jet then jump downstream', () => {
  const sec = [{ L: 100, D: 0.4, S0: 0.002, ...pvc }];
  const r = run({ sections: sec, markers: [{ id: 'o', type: 'orifice', shape: 'circle', size: 0.1, x: 50, Cd: 0.61, Cc: 0.61 }], end: { type: 'freefall' } });
  const u = r.points.find((p) => p.marker === 'o' && p.side === 'u');
  const Ao = Math.PI * 0.01 / 4;
  const h = u.egl - (u.zInv + 0.05); // head over the orifice centre
  near(0.61 * Ao * Math.sqrt(2 * G * h), Q, 0.02, 'orifice flow');
  assert.equal(r.jumps.length, 1);
  assert.ok(r.jumps[0].x > 50, 'jump downstream of the orifice');
});

test('Top gate above the water surface has no effect', () => {
  const sec = [{ L: 100, D: 0.4, S0: 0.002, ...pvc }];
  const a = run({ sections: sec, end: { type: 'freefall' } });
  const b = run({ sections: sec, markers: [{ id: 'g', type: 'gate', gate: 'top', size: 0.39, x: 50 }], end: { type: 'freefall' } });
  near(b.points[0].hgl, a.points[0].hgl, 1e-3, 'inlet level');
});

test('Bottom gate raises the upstream level by at least its crest height', () => {
  const sec = [{ L: 100, D: 0.4, S0: 0.002, ...pvc }];
  const r = run({ sections: sec, markers: [{ id: 'g', type: 'gate', gate: 'bottom', size: 0.15, x: 50 }], end: { type: 'freefall' } });
  const u = r.points.find((p) => p.marker === 'g' && p.side === 'u');
  assert.ok(u.y > 0.15, `upstream depth ${u.y}`);
});

test('Mild section into a steep section passes critical depth at the break', () => {
  const r = run({ sections: [{ L: 100, D, S0: 0.001, ...pvc }, { L: 100, D, S0: 0.03, ...pvc }], end: { type: 'freefall' } });
  const brk = r.points.filter((p) => Math.abs(p.x - 100) < 1e-3);
  assert.ok(brk.some((p) => p.regime === 'critical'), 'critical at the break');
  assert.equal(r.points.at(-1).regime, 'super');
});
