# Changelog — @particlr/runtime

## 0.6.0 — 2026-08-15 (unreleased at time of writing)

Hardening release from the 2026-08-15 adversarial audit. Minor bump, not a
patch, because two changes are consumer-visible:

### Breaking

- **The validator now rejects documents it previously accepted.** Fields the
  TypeScript types declare required must be present: `circle.innerRadius`,
  `circle.arc`/`arcMode`/`arcSpeed`, `cone.arcMode`/`arcSpeed`
  (`missing-shape-field`), and the collision fields `killOnCollide` /
  `minKillSpeed` (`missing-collision-field`). Previously a partial (hand- or
  LLM-authored) document validated clean and then misbehaved silently at sim
  time (NaN sampling that blanked the layer). Errors carry the JSON path of
  each missing field. Additionally, gradient/curve tracks are capped at 64
  keys and burst `cycles`/`count` are capped (a document exceeding the caps
  is rejected rather than freezing the sim).
- **Sub-emitter output change:** two sub-emitter references sharing a trigger
  previously drew identical PRNG streams (visibly cloned children). Sibling
  streams are now decorrelated, so such documents render differently — and
  correctly.

### Fixed

- `step(dt)` rejects `NaN` dt (previously NaN slipped past both guards and
  permanently corrupted every live particle's position).
- Emitter displacement is scaled by `clampedDt/rawDt` when the 1/20 s dt
  clamp engages, so a lagging host no longer teleports world-space trails.
- Disabled layers still age (a re-enabled layer no longer bursts stale
  particles); disabled sub-emitter child layers are skipped entirely.
- Trail textures rebind on async decode in both the Pixi v8 and v7 adapters
  (trails no longer render with a placeholder texture after a slow decode).

### Migration

Documents exported by the particlr editor at `schemaVersion` 12 are already
complete and validate unchanged. If you construct `.prt` JSON by hand or via
an LLM, run it through `parseParticle` and fill any reported
`missing-shape-field` / `missing-collision-field` paths.

## 0.5.2 and earlier

See git history in the public mirror
(<https://github.com/brac/particlr-runtime>) and the project devlogs.
