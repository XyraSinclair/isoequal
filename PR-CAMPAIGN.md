# Dependency-swap PR campaign

Goal: land high-quality PRs replacing broken deep-equal dependencies with
isoequal, where the case is airtight enough that a maintainer accepts it as
RISK REMOVAL, not risk absorption.

## The trust problem, named honestly

isoequal is new and AI-authored. No maintainer will (or should) swap a
20M-download dependency on our say-so. The case must be entirely receipts:

1. **Their own test suite, green, with the swap** — the PR includes the diff
   AND a CI run showing zero behavioral change on everything they test.
2. **Behavioral compatibility matrix** — every input class where the old dep
   and isoequal AGREE (the overwhelming majority), and the exact enumerated
   cases where they differ, each difference being the old dep CRASHING
   (cycles → RangeError) or answering WRONG (multiset trap, sharing). No
   silent semantic drift: differences are strictly bug→fix.
3. **Perf on THEIR workload shape** — deep-compare-effect compares props
   objects: our tiny-object number (~0.7µs) vs dequal (~0.16µs) is the honest
   cost; the pitch is paying nanoseconds for not crashing on cyclic props
   (which React state with parent refs produces in the wild — link issues).
4. **Soundness receipts** — the probe table, the brute-force-oracle fuzz, the
   120-line reference implementation a reviewer can read in one sitting and
   diff against the engine's verdicts themselves.
5. **Maturity signals we must earn first (gate before any PR):**
   - [ ] v1.0.0 with a frozen semver contract (document exactly what
         equality means; semver-major any semantic change)
   - [ ] npm provenance (publish via GitHub Actions trusted publishing —
         also solves the 2FA/token dance permanently)
   - [ ] 2-4 weeks on npm without issues; a handful of real downloads
   - [ ] CI badge matrix (node 18/20/22/24), 100% test pass public
   - [ ] SECURITY.md + no-deps statement (zero runtime dependencies is a
         supply-chain ARGUMENT: swapping dequal→isoequal removes zero deps
         and adds zero)

## Compat audit results (2026-07-11, src/dequalCompat.test.ts)

The "are we missing dequal functionality" question is answered empirically:

- **Agreement everywhere it matters**: full explicit feature battery (dates,
  regexps, typed arrays, node Buffer, DataView, class instances, sets, maps,
  key order) + 8,000 acyclic fuzz pairs — zero unexplained disagreements.
- **Every disagreement is a dequal defect**, now FOUR classes, each pinned:
  1. Cycles → RangeError crash.
  2. Set multiset trap → false positive.
  3. Boxed primitives compared as empty objects → false positive
     (`new Number(1)` equals `new Number(2)` in dequal).
  4. **NEW (found by our fuzz): greedy-matching FALSE NEGATIVES** on
     genuinely equal Maps/Sets with duplicate-shaped keys —
     `Map([[{},1],[{},2]])` vs `Map([[{},2],[{},1]])` → dequal false.
     Adjudicated by two independent implementations (engine + brute-force
     reference). For use-deep-compare-effect this means SPURIOUS EFFECT
     RE-RUNS on equal deps — a live, user-visible bug, subtler than the
     crash and stronger for the PR pitch.
- **S2 sharing strictness measured**: on fuzz WITH aliasing, zero
  cross-direction surprises; and on fresh-per-render data (the React props
  shape) the sharing delta never fires. Drop-in risk is lower than feared;
  the S1 mode remains the belt-and-braces answer but is not a hard blocker
  for the udce PR (their docs make no sharing-semantics promise).
- Known intentional differences favoring us: invalid Dates equal each other
  (dequal: unequal, since NaN !== NaN); documented in the matrix.

## Targets, ranked by case strength

1. **kentcdodds/use-deep-compare-effect** — deps: `dequal ^2.0.2`. The
   dependency CRASHES on any cyclic value in the deps array (RangeError) and
   is unsound on Sets. Dormant since 2021 → PR may stall; file the
   issue-with-repro first, PR attached. Fallback: publish the comparison as
   a documented recipe (`createIsoEqual` + `useDeepCompareEffect` custom
   hook) in our README.
2. **Vitest `toEqual` on Sets** (vitest-dev/vitest, `@vitest/expect`
   iterableEquality) — greedy O(n²) set matching, wrong under sharing. Huge
   win, huge bar: propose as an opt-in `isoEquality` matcher first, not a
   default-swap. Needs a benchmark PR showing no regression on their
   perf suite.
3. **TanStack Query `replaceEqualDeep`** — structural sharing; their
   function is bespoke, not a dep swap; the case is a bug-repro issue if we
   can find real inputs where it misbehaves (cycles in query data). Research
   stroke: fuzz replaceEqualDeep against isoequal first; NO PR without a
   confirmed defect.

## Execution plan (per target, one PR = one stroke)

1. Clone target, swap dep, run THEIR suite → record green run.
2. Build the compat matrix by differential fuzz: their old dep vs isoequal
   over our generator corpus + their test fixtures; classify every
   disagreement (must all be old-dep crashes/known-wrongs).
3. Write the PR: one-paragraph pitch, matrix table, crash repro their users
   can run, perf table on their shape, link to DESIGN.md + reference.ts.
4. Open issue first with the crash repro; PR referencing it same day.

## Status

- [x] Recon: use-deep-compare-effect confirmed on dequal ^2.0.2 (2026-07-11)
- [x] Compat audit: parity verified + FOURTH dequal defect found (see above)
- [x] **THE receipt: udce's own suite green with the swap** — 8/8 tests,
      2/2 snapshots, ~equal runtime (0.98s vs 1.09s baseline); typecheck
      deltas none (pre-existing @types/node noise identical both sides).
      Swap tested from a packed tarball including the dual CJS build.
- [x] Dual ESM+CJS build (their 2021 jest toolchain requires CJS)
- [x] v1.0.0 semantics freeze + CHANGELOG (in repo; publish pending)
- [x] Issue + PR texts drafted: drafts/udce-issue.md, drafts/udce-pr.md
- [x] **isoequal@1.0.0 PUBLISHED** (2026-07-11, agent-run, zero-touch —
      Xyra's auth window made the release script sail through)
- [x] Issue filed: kentcdodds/use-deep-compare-effect#69
- [x] **PR OPEN: kentcdodds/use-deep-compare-effect#70** — 2-line diff
      (import + dependency), body carries the full receipts case
- [x] Upstream bug filed: lukeed/dequal#41 (Map false-negative class;
      distinct from their #31 set false-positive — both cited)
- [ ] Monitor #69/#70/#41 for maintainer response; repo is dormant since
      2021 so patience or a gentle ping in a few weeks
- [ ] Next targets when energy allows: Vitest opt-in matcher (research
      their iterableEquality first), TanStack replaceEqualDeep fuzz

## Hunt round 2 (2026-07-11, hunt/differential.mjs + hunt/round2.mjs)

Differential harness (signature cases + 3000-pair fuzz per lib, adjudicated
by engine + brute-force reference — the two never split once):

| library | defects found | filed |
|---|---|---|
| **nodejs core** (util/assert deep equal) | **NEW CRASH**: TypeError on Maps with null keys (2-entry repro, v24+v26, all 3 APIs); plus the known ring false-negative | **nodejs/node#64433** (crash) |
| **es-toolkit** isEqual | Map dup-shaped-key false negatives (~10% of equal collection pairs in fuzz); deviates from lodash | **toss/es-toolkit#1881** |
| remeda isDeepEqual | RangeError on cycles; dup-key FN; boxed-primitive FALSE POSITIVE (new Number(1) ≡ new Number(2)); ~10% fuzz FN | next wave |
| @wry/equality (Apollo) | ring FN; dup-key FN; 17% fuzz FN rate | next wave |
| react-fast-compare | SILENT false on self-cycles (no crash — worse); ring FN; dup-key FN | next wave |
| deep-eql (chai) | ACYCLIC: exonerated — zero defects in 3000-pair fuzz, coherent S1 semantics, strongest incumbent. CYCLIC+UNORDERED: **collapses — 287/300 (96%) false negatives** on shuffled clones of random cyclic graphs with Sets (hunt/deepEqlBoundary.mjs); hand-picked symmetric cases (self-cycles, uniform rings) pass, general case does not. Never false-accepts (0/300 mutants). Perf: 5.5× slower on 10k primitive sets, 7.5× on object sets. Chai documents circular support → strong candidate filing | next wave |

Notes: Vitest's expect uses jasmine-derived equals, NOT deep-eql — still
needs its own probe. The hunt harness lives in hunt/ and points at any lib
in minutes; the "found bugs in node core" line is now a credibility asset
for every future filing.
