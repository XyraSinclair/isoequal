<!-- PR body for kentcdodds/use-deep-compare-effect. Open AFTER the issue; reference it. -->

# Swap `dequal` → `isoequal`: fixes spurious re-runs and cyclic-deps crash

Fixes #<issue>.

One-line diff (plus the dependency entry): `dequal` has two defects that
surface through this hook — greedy-matching **false negatives** on equal
Maps/Sets (effect re-runs when deps didn't change) and a **RangeError crash**
on any cyclic value in deps. Repros in the linked issue.

## Why this is safe

- **This repo's own suite: green, unchanged** — 8/8 tests, 2/2 snapshots
  (same as with `dequal`; also ~equal runtime). Typecheck deltas: none
  (pre-existing `@types/node` noise identical on both sides).
- **Behavioral compatibility, verified not asserted**: an explicit feature
  battery plus 8,000-pair differential fuzz against `dequal` shows zero
  disagreements outside `dequal`'s pinned defect classes
  ([audit source](https://github.com/XyraSinclair/isoequal/blob/main/src/dequalCompat.test.ts)).
  Every difference is `dequal` crashing or answering provably wrong — never
  silent semantic drift.
- **Independently checkable**: isoequal ships a
  [120-line reference implementation](https://github.com/XyraSinclair/isoequal/blob/main/src/reference.ts)
  you can read in one sitting; the optimized engine is differentially tested
  against it and against a brute-force isomorphism oracle on thousands of
  seeded random graphs.
- **Supply-chain neutral**: zero runtime dependencies (same as `dequal`),
  MIT, dual ESM/CJS, types included.

## Cost, stated honestly

`isoequal` compares tiny flat objects in ~0.7µs vs `dequal`'s ~0.16µs (it
tracks object identity to get cycles and aliasing right — that bookkeeping is
the fix). For a hook that runs per-render on deps arrays, this is noise; the
crash and the spurious re-runs are not.
