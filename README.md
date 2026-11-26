# HydroGradeLine
Free web-based hydraulic calculator for pipes and channels. Computes velocity, head loss (Darcy-Weisbach, Hazen-Williams), Manning partial flow, critical depth and full grade-line profiles with jumps, vents, orifices and gates.

Live site: https://eyalprice.github.io/HydroGradeLine/

## Current version
- Single circular pipe section shown as a long section with energy and hydraulic grade lines.
- End conditions: pressurised, steady state (normal depth), free fall, set downstream water level.
- Gradually varied flow profile (direct step), automatic switch to pressurised flow when the pipe fills, hydraulic jump location by momentum, air entrainment estimate (Kalinske & Robertson).
- Fluids: water (by temperature), air (incompressible), custom.
- Every field has its own unit; Metric / US switch at the top.
- Velocity bands: below 0.6 m/s yellow, 0.6–3 green, 3–6 orange, above 6 red.

## Development
Plain HTML, CSS and JavaScript modules, no build step. Run tests with `npm test` (Node 20+). Tests compare results with published worked examples and run on every push.

## Disclaimer
For guidance only. Results must be checked by a qualified engineer. Provided as is, without warranty. The author accepts no liability for any use of the results.

## Licence
MIT
