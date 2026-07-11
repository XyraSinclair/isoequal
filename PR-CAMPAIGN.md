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
- [ ] Maturity gate items (above) — BLOCKING all PRs
- [ ] Stroke 1: trusted publishing + v1.0.0
- [ ] Stroke 2: udce differential run
