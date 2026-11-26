// HydroGradeLine – units. Each quantity lists units as [label, factor to SI] (value_SI = value * factor).
// Temperature is affine and handled separately.
export const QUANTITIES = {
  length: { units: [['m', 1], ['km', 1000], ['ft', 0.3048], ['mi', 1609.344]], metric: 'm', us: 'ft' },
  elevation: { units: [['m', 1], ['ft', 0.3048]], metric: 'm', us: 'ft' },
  diameter: { units: [['mm', 0.001], ['cm', 0.01], ['m', 1], ['in', 0.0254], ['ft', 0.3048]], metric: 'mm', us: 'in' },
  roughness: { units: [['mm', 0.001], ['µm', 1e-6], ['in', 0.0254], ['ft', 0.3048]], metric: 'mm', us: 'in' },
  flow: {
    units: [['m³/h', 1 / 3600], ['m³/s', 1], ['L/s', 0.001], ['L/min', 0.001 / 60], ['gpm', 6.30901964e-5], ['ft³/s', 0.0283168466], ['MGD', 0.0438126364]],
    metric: 'm³/h', us: 'gpm',
  },
  velocity: { units: [['m/s', 1], ['ft/s', 0.3048]], metric: 'm/s', us: 'ft/s' },
  slope: { units: [['%', 0.01], ['‰', 0.001], ['m/m', 1], ['ft/ft', 1]], metric: '%', us: '%' },
  pressure: { units: [['kPa', 1000], ['bar', 1e5], ['m H₂O', 9806.65], ['Pa', 1], ['psi', 6894.757], ['ft H₂O', 2989.067]], metric: 'kPa', us: 'psi' },
  headloss: { units: [['m/100 m', 0.01], ['m/km', 0.001], ['ft/100 ft', 0.01], ['ft/1000 ft', 0.001], ['m/m', 1]], metric: 'm/100 m', us: 'ft/100 ft' },
  head: { units: [['m', 1], ['ft', 0.3048], ['mm', 0.001], ['in', 0.0254]], metric: 'm', us: 'ft' },
  temperature: { units: [['°C', null], ['°F', null]], metric: '°C', us: '°F' },
  percent: { units: [['%', 0.01]], metric: '%', us: '%' },
  ratio: { units: [['–', 1]], metric: '–', us: '–' },
  viscosity: { units: [['mm²/s', 1e-6], ['m²/s', 1], ['ft²/s', 0.09290304]], metric: 'mm²/s', us: 'ft²/s' },
  density: { units: [['kg/m³', 1], ['lb/ft³', 16.0184634]], metric: 'kg/m³', us: 'lb/ft³' },
};

export function toSI(q, unit, v) {
  if (q === 'temperature') return unit === '°F' ? ((v - 32) * 5) / 9 : v;
  const u = QUANTITIES[q].units.find((x) => x[0] === unit);
  return v * u[1];
}
export function fromSI(q, unit, v) {
  if (q === 'temperature') return unit === '°F' ? (v * 9) / 5 + 32 : v;
  const u = QUANTITIES[q].units.find((x) => x[0] === unit);
  return v / u[1];
}
export function defaultUnit(q, system) {
  return QUANTITIES[q][system === 'us' ? 'us' : 'metric'];
}
// Round to a sensible number of significant figures for display.
export function fmt(v, sig = 4) {
  if (v === null || v === undefined || !isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(sig - 1);
  const d = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
  return Number(v.toFixed(Math.min(d, 8))).toString();
}
