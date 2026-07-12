# Deep equality is secretly graph isomorphism

*How a years-old TODO in a utils folder turned into finding bugs in Node core.*

---

Every JavaScript deep-equality library asks the same question: are these two
values the same? And every one of them quietly refuses to answer it for the
values where the question gets interesting.

Take two Sets, each containing six objects linked in a cycle — a ring. Same
structure, different insertion order. Ask Node's own `util.isDeepStrictEqual`
whether they're equal:

```js
const ring = (k) => {
  const nodes = Array.from({ length: k }, () => ({}))
  for (let i = 0; i < k; i++) nodes[i].next = nodes[(i + 1) % k]
  return nodes
}

isDeepStrictEqual(new Set(ring(6)), new Set(shuffle(ring(6))))
// false. For every one of 24 insertion orders we tried.
```

These sets are equal by any reasonable definition. Node says no, every time.
The acyclic control passes, so this isn't a Set problem or a cycle problem —
it's specifically the combination. `dequal` doesn't even get that far: it
throws a `RangeError` on any cycle at all. `fast-deep-equal` returns a wrong
answer in 300 nanoseconds, which at least is efficient. Lodash survives the
rings but takes 1.09 *seconds* to compare two 10,000-element Sets, because
its matching is quadratic.

I had wanted this to work for years. There's a half-finished file in one of
my repos — `dequal3.ts`, dated optimism — full of comments sketching
"progressive serialization" and "permute the groups with backtracking."
The use case was comparing outputs of alternative implementations of the
same function: if version B returns the same data as version A but builds
its Sets in a different order, that should count as equal. No library agreed.

## The problem has a name

Here's the thing that half-finished file was circling without landing on:
**deep equality over cyclic structures with unordered collections is graph
isomorphism.** Not "like" graph isomorphism. Literally it.

A JavaScript value is a rooted, labeled, directed graph. Object properties
and array slots are *ordered* edges — position matters, so they force the
comparison deterministically. Set membership is an *unordered* edge bundle —
the comparison has to discover which element corresponds to which. Encode
any graph as sets-of-sets and deep equality decides isomorphism for you.
That makes the general problem GI-complete: no known polynomial algorithm,
and the best theoretical result (Babai 2016) is quasi-polynomial.

This sounds like bad news. It's actually the most useful fact in the whole
project, because it explains the entire ecosystem in one sentence: **nine
libraries independently invented greedy matching with memoization, and
greedy matching cannot decide graph isomorphism.** Node, lodash, dequal,
fast-deep-equal, chai's deep-eql, es-toolkit, remeda, Apollo's
@wry/equality, react-fast-compare — every one pairs each Set element with
the first plausible partner and never reconsiders. That's sound when
everything is ordered, or when nothing is cyclic. Combine cycles and Sets
and it collapses. Nobody was sloppy. Everybody hit the same wall, and the
wall has a name from the 1970s.

There's a second fact hiding here, and it's a fork in the road. What should
this return?

```js
const x = {}
deepEqual([x, x], [{}, {}])
```

One array holds the same object twice; the other holds two distinct empty
objects. If equality means "same infinite unfolding," they're equal — and
that version of the problem (it's bisimulation, the equality of Aczel's
non-well-founded sets) is solvable in polynomial time. If equality means
"same graph, sharing included," they're different — and that's the
GI-complete version. Most libraries answer `true` without ever having
decided which question they're answering. We chose sharing-sensitive
isomorphism as the default, because "these two data structures are
interchangeable" is the promise the benchmarking use case actually needs —
aliasing is observable the moment you mutate.

## The algorithm

Knowing the problem is GI-complete tells you what a solution has to look
like, because graph isomorphism is a solved problem *in practice* — that's
what nauty and its descendants have been demonstrating since 1981. The
recipe: solve the forced part exactly, refine the ambiguous part until it's
almost forced, search the tiny remainder, and verify everything.

isoequal runs in tiers:

**Tier 0: an ordered guess.** Compare everything as if Sets were ordered.
If that succeeds, the identity permutation witnesses the unordered answer —
done, in linear time. Real equal collections overwhelmingly share insertion
order (clones, rebuilds, serialization round-trips), so this wins constantly.

**Tier 1: the forced region.** Walk both values in lockstep, assigning each
object pair an index the first time it's visited. This partial map must be
a bijection — a revisited object must map to what it mapped to before, and
no two objects may share an image. That one discipline is the entire
cycle-and-sharing story. There's a trap here that our design doc originally
got wrong: you cannot shortcut when both sides are literally the same
object. If `s` appears in both values, the walk must still traverse it,
because an identical Set on both sides may need a *non-identity*
correspondence through its elements. The counterexample is three lines and
it killed a "clearly correct" optimization.

**Tier 1.5: shrink the residue.** Unordered collections get deferred, then
filtered: primitives match by membership, and any element already forced by
the ordered region drags its partner along. Most Sets dissolve entirely
here.

**Tiers 2–3: refine, search, verify.** What survives is genuine ambiguity —
elements that are mutually interchangeable as far as anyone can tell. Color
refinement (the Weisfeiler–Leman algorithm, 1968) propagates structural
fingerprints until interchangeable elements are provably grouped; if the
groups don't balance across the two sides, the answer is no. Then an
individualization search tries pairings within groups, with one crucial
property: **the algorithm can only say "equal" after an exact,
hash-free verification of a concrete bijection.** Hash collisions can merge
groups — costing time — but they can never manufacture a wrong answer.
On adversarial inputs the search can still go exponential, because it must;
you can set a work budget, and the library throws rather than guess.

The whole engine, stripped of its engineering, is ten lines of idea:

```js
function eq(a, b, φ, ψ, trail) {
  if (a === null || typeof a !== 'object') return Object.is(a, b)
  if (φ.has(a)) return φ.get(a) === b        // consistent…
  if (ψ.has(b)) return false                  // …and injective
  φ.set(a, b); ψ.set(b, a); trail.push(a)    // register BEFORE recursing ⇒ cycles terminate
  if (a instanceof Set)                       // unordered: guess a pairing, retract failures
    return matchSomePairing([...a], [...b], eq, trail)
  return sameShape(a, b) && everyChild(a, b, eq)
}
```

One partial bijection. Extend it by guessing, check by recursion, retract
via a trail when a guess fails. The package ships a
[readable ~120-line version](https://github.com/XyraSinclair/isoequal/blob/main/src/reference.ts)
of exactly this, and the optimized engine is differentially tested against
it — thousands of random cyclic graphs, adjudicated by an exhaustive
brute-force oracle as a third opinion. Across roughly thirty thousand
adjudications, the three implementations have never disagreed.

## What the fuzzer found in everyone else

Once you have an oracle, differential testing is almost free: generate
random data, ask every library, and flag whoever disagrees with the
brute-force answer. This got out of hand in the best way.

The fuzzer found a **crash in Node core**: `assert.deepStrictEqual`,
`assert.notDeepStrictEqual`, and `util.isDeepStrictEqual` all throw a raw
`TypeError` on two-entry Maps with `null` keys — filed as
[nodejs/node#64433](https://github.com/nodejs/node/issues/64433). It found
a previously unreported **false-negative class in dequal**
([#41](https://github.com/lukeed/dequal/issues/41)): equal Maps whose keys
are structurally identical get rejected by greedy pairing —

```js
dequal(new Map([[{}, 1], [{}, 2]]), new Map([[{}, 2], [{}, 1]]))
// false — same multiset of entries
```

— which, flowing through `use-deep-compare-effect`, means React effects
re-running on deps that didn't change
([kentcdodds/use-deep-compare-effect#69](https://github.com/kentcdodds/use-deep-compare-effect/issues/69),
with a two-line fix in [PR #70](https://github.com/kentcdodds/use-deep-compare-effect/pull/70)).
It found the same class in es-toolkit, where it also breaks their stated
lodash parity ([toss/es-toolkit#1881](https://github.com/toss/es-toolkit/issues/1881)).

Honorable mention to chai's deep-eql, the one incumbent that earned real
respect: flawless on acyclic data across our whole corpus, and its one
philosophical disagreement with us is a coherent choice of the unfolding
semantics. But on random cyclic graphs containing Sets it returns false for
96% of genuinely equal pairs. Its cyclic support is real for self-loops and
symmetric toy cases, and a mirage past them — which is roughly the story of
the whole ecosystem in miniature.

## Sets you define yourself

One more thing fell out of the design. Once the engine treats "unordered
collection" as a property rather than a hardcoded type check, any iterable
can declare it:

```js
const UNORDERED = Symbol.for('unordered-collection')

class MultiSet {
  get [UNORDERED]() { return true }
  *[Symbol.iterator]() { yield* this.items }
}

isoEqual(new MultiSet([1, 1, 2]), new MultiSet([2, 1, 1])) // true — multiplicity counts
```

A declared collection compares as the multiset of its iterated values,
with full cycle and sharing support. Multimaps need no special case at all:
their iterators yield `[key, value]` pairs, and pairs are just values. The
symbol is deliberately package-neutral — `'unordered-collection'`, not
`'isoequal.anything'` — in the spirit of `Symbol.iterator`: any equality or
serialization library could honor it.

## The honest scorecard

isoequal is the fastest option we measured on flat arrays and large
primitive Sets, and within ~1.5× of Node on plain object trees — that gap
is the bookkeeping that makes sharing and cycles correct, and the libraries
without it are the ones answering the ring question wrong. On the workloads
where the incumbents are also correct, it's competitive; on the workloads
where they aren't, it's alone.

```
npm i isoequal
```

Zero dependencies, dual ESM/CJS, MIT. The
[design document](https://github.com/XyraSinclair/isoequal/blob/main/DESIGN.md)
has the proofs, the prior art (Weisfeiler–Leman, McKay's nauty,
Paige–Tarjan, Adams & Dybvig's R6RS `equal?` — this project's components
are all classical; the synthesis just hadn't been done for JS values), and
the complete probe tables. The fuzz harness that found the Node bug is in
[`hunt/`](https://github.com/XyraSinclair/isoequal/tree/main/hunt) — point
it at your favorite equality function and see what falls out.

The TODO sat in that utils folder for years because it looked like a
weekend of fiddly edge cases. It turned out to be a genuinely hard problem
wearing a mundane disguise — the best kind. The moment it got its real name,
fifty years of graph-isomorphism literature snapped into place behind it,
and the "fiddly edge cases" became theorems with proofs. If you have a
half-finished file like that somewhere, maybe check what your problem is
actually called.
