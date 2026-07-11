# isoequal roadmap

v0.1 is **correct-first**: three-tier engine, unforgeable dispatch, oracle-
fuzzed, adversarially reviewed (three rounds, every finding regression-
locked). Honest self-assessment of where it is NOT yet Book-quality, and the
planned rewrites.

## The structural critique of v0.1

Type semantics are stated THREE times — walk dispatch (`tier1.ts`), arena
label folding (`arena.ts`), exact verification (`solve.ts`) — kept consistent
by tests, not by construction. Review finding R6c ("verdict must not depend
on position: top-level vs inside residue") was precisely this seam leaking.
Secondary smells: the `branded*` comparators repeat one pattern five ways;
`comparePair` runs the same dispatch chain twice (proto fast path, then
instanceof fallback); the optimistic ordered phase re-walks from scratch on
escalation instead of reusing its deterministic prefix.

## v2 — "one schema, three interpreters" (the Book rewrite)

A single per-type descriptor:

```ts
interface TypeSchema<T> {
    brand(o: object): o is T                      // internal-slot probe
    label(o: T, fold: Fold): void                 // content → label lanes
    orderedEdges(o: T, emit: EmitSlot): void      // forced children
    unorderedEdges?(o: T): Iterable<unknown>      // multiset children
    // walk, arena build, and verify are DERIVED — stated once, correct
    // by construction in all three positions.
}
```

Success criterion: deleting any one semantic fact breaks exactly one line.
Bench criterion: no regression vs v0.1 (the schema must compile to the same
monomorphic loops — likely via per-type generated closures, not megamorphic
dispatch).

## reference implementation — the concise shareable version — ✅ SHIPPED (src/reference.ts)

~150 lines, zero performance engineering: pair-walk + explicit brute-force
bijection search over the residue (the test-kit oracle, essentially, promoted
to a readable artifact). Purpose: (1) the thing a reader can absorb in one
sitting and believe; (2) the differential-testing oracle for every future
optimized version; (3) the README's "here is the whole idea" link. Ship as
`src/reference.ts`, exported as `isoEqualReference`, tested against the main
engine on the full fuzz corpus.

## v3+ — performance strokes (measured handles, not speculation)

- Partner-map registration: one `Map<object, object>` A→B instead of two
  index maps (~10–15% on POJO-heavy paths).
- Hopcroft partition refinement (smaller-half worklists) if residue benches
  ever demand it — current hash-round refinement is O((n+e)·rounds).
- S1 engine (`sharingSensitive: false`): union-find + Paige–Tarjan
  bisimulation — hands back the sharing-registration tax, beats node
  everywhere, for callers who accept unfolding semantics.
- CFI fixture demonstrating the budget path honestly in docs.

## publishing

`npm publish` from this repo (needs Xyra's npm auth; `prepublishOnly` gates
on test+build). Then: announce with the ring-table receipts.
