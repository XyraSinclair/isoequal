# Changelog

## 1.0.0 — 2026-07-11

**Semantics freeze.** From 1.0.0, what `isoEqual` means is a frozen contract
(DESIGN.md §1/§6): sharing-sensitive isomorphism of reachable object graphs —
cycles supported, Set/Map unordered, SameValue primitives with SameValueZero
collection membership, prototype-identity types with internal-slot brands,
identity semantics for functions/Weak*/Promise, the
`Symbol.for('unordered-collection')` multiset protocol. Any semantic change
is a major version.

Added since 0.1.0:

- **Dual ESM + CJS build** (`exports` with `import`/`require`) — drop-in for
  CommonJS toolchains; verified against a 2021 jest/babel consumer.
- **dequal compatibility audit** (`src/dequalCompat.test.ts`): explicit
  feature battery + 8,000-pair differential fuzz. Zero unexplained
  disagreements; every delta is a pinned dequal defect (cycles crash,
  multiset false positive, boxed-primitive false positive, and a
  newly-discovered greedy-matching FALSE NEGATIVE class on equal Maps/Sets
  with duplicate-shaped keys).

## 0.1.0 — 2026-07-11

Initial release: three-tier engine (optimistic ordered pass; deterministic
walk + residue filtering; color refinement + individualization search with
exact verification), 120-line reference implementation shipped as
`isoEqualReference`, brute-force-oracle fuzz suite, five-way benchmarks.
