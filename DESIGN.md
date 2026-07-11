# isoequal — design

> Ported 2026-07-11 from the priorsio repo where this engine was built as
> "dequal4" (that name survives below in historical narrative; the shipped
> API is `isoEqual`/`createIsoEqual`/`isoEqualStrict`/`UNORDERED`).

# isoequal — cyclic + unordered deep equality, done right

Design for the next (and intended-final) in-house dequal: deep equality over
arbitrary JS values including **cyclic structures** and **unordered
collections** (Set / Map / multiset / unordered symbol props), fast enough to
call in hot paths, and *provably* correct.

This doc names the problem precisely, proves what's possible, shows that the
approaches sketched in `dequal3.ts` / `.archiveDequal/dequal.old2.ts` were
converging on the canonical algorithms from the graph-isomorphism literature,
and specifies the concrete architecture. Prior art in this directory maps onto
it as follows:

| existing artifact | what it actually is |
|---|---|
| `seenA`/`seenB` index-pairing walk (old2 `_dequal`) | canonical numbering of the *deterministic* (ordered) region — Tier 1 |
| "defer unordered collections to the end" (old2, dequal3) | residue minimization — correct and kept |
| "progressively serialize breadth-first, sort, group by equal prefix" (dequal3 header) | **color refinement / 1-dim Weisfeiler–Leman** — Tier 2 |
| "permute the groups, backtrack across collections" (dequal3 header) | **individualization–refinement** (nauty's search) — Tier 3 |
| `dequalSerializer.ts` `@seenIndex` back-refs | DFS canonical form — canonical **only** when traversal order is canonical; unorderedness is precisely what breaks it, and Tiers 2–3 exist to *construct* a canonical order |
| `dequalTest.ts` (`isomorphic(a,b)`, shuffle-clone metamorphic test, trick graphs) | already the right oracle harness — kept nearly as-is |

---

## 1. Semantics: precommit before optimizing

Model a JS value as a **rooted, node-labeled directed graph**:

- **Nodes** = reachable objects. **Labels** = everything locally comparable:
  type tag, constructor (realm-nuanced), primitive content (Date epoch, RegExp
  source+flags, TypedArray bytes, function source, boxed primitive value),
  arity/size, extensibility, descriptor flags.
- **Ordered edges** (position-significant): array slots, Map-entry `key`/`value`
  slots, string-keyed props (keys are strings — matchable by name, never
  speculative, exactly as the dequal3 note says).
- **Unordered edge multisets**: Set elements, Map entries (each entry a virtual
  node with two ordered out-edges `key`, `value`), multiset/multimap entries,
  same-description symbol-keyed props.
- Primitives are label data, not nodes (compared by SameValue, with the
  collection-membership caveat in §6).

Two candidate meanings of "deep equal" for cyclic graphs:

**(S1) Unfolding / bisimulation equality.** `A ≡ B` iff their infinite tree
unfoldings are equal. `[a,a] ≡ [b,a]` (both unfold to `[[],[]]`).

**(S2) Isomorphism (sharing-sensitive) equality.** `A ≡ B` iff there is a
bijection `φ : Reach(A) → Reach(B)` with `φ(A)=B`, preserving labels, ordered
edges positionally, and unordered edge multisets setwise.

dequal3's own hard requirement — `dequal([a1,a2,a1], [b1,b1,b2])` **must be
false** — and `dequalTest.ts`'s name `isomorphic` both pin the default to
**(S2)**. (S1) accepts that pair. So:

> **Default semantics: (S2), reachable-subgraph isomorphism.**
> **(S1) is offered as an opt-in** (`sharingSensitive: false`) because it is
> radically cheaper — see §3.

Corollary worth internalizing (already noted in old2's comments): under (S2),
`aObj === bObj` does **not** imply equal-in-context. Identity is only usable
after both sides are cycle-registered with matching indices (old2 got this
right: register first, then early-out on identity).

## 2. Hardness: what "amazingly fast" can possibly mean

**Theorem.** dequal under (S2) is GI-complete (polynomial-time equivalent to
graph isomorphism).

*Proof sketch (hardness).* Given undirected graphs `G`, `H` on `n` vertices:
for each vertex `v` create an empty `Set` node `S_v`; add `S_u ∈ S_v` for every
edge `uv` (both directions — cycles are allowed and expected); let the root be
`root_G = new Set([...all S_v])`. Then `dequal(root_G, root_H)` iff `G ≅ H`:
any label/edge-preserving bijection fixing the roots restricts to a bijection
on vertex-sets preserving adjacency, and conversely. `createTrickGraphs0()` in
`dequalTest.ts` is a small instance of exactly this embedding. Membership in
GI is by the same encoding in reverse. ∎

No polynomial worst-case algorithm is known for GI (best known:
quasi-polynomial, Babai 2016). **Consequence:** the design target is not
"polynomial always" — it is the nauty/bliss/Traces target:

> **Linear-ish on everything that occurs in practice; complete (never wrong,
> always terminating) on adversarial symmetric inputs, degrading there to a
> pruned exponential search that real data never triggers.**

Practical GI on structured inputs is a *solved* problem in this sense: color
refinement alone discriminates almost all graphs (Babai–Erdős–Selkow: all but
an exponentially small fraction of random graphs are refinement-discrete), and
real JS data is far more labeled (types, sizes, primitive content) than the
bare graphs that stress nauty.

## 3. The beautiful dichotomy: (S1) is cheap, even cyclic + unordered

Under (S1), cyclic-with-unordered-edges equality is **partition refinement**,
solved by Paige–Tarjan in `O(m log n)`: compute the coarsest bisimulation on
the disjoint union of both graphs; `A ≡ B` iff root blocks coincide. Unordered
edges are the *native* case for bisimulation. No search, ever.

Also under (S1), the classic Hopcroft–Karp union-find trick ("assume the pair
equal on re-encounter, merge classes") gives near-linear ordered-cyclic
equality with zero setup — worth having as the `sharingSensitive: false` fast
engine.

So the option surface is honest about the complexity cliff:

| semantics | cycles | unordered | worst case | engine |
|---|---|---|---|---|
| (S1) bisim | ✓ | ✓ | `O(m log n)` guaranteed | Paige–Tarjan / union-find |
| (S2) iso | ✓ | ✗ (all ordered) | `O(n + m)` guaranteed | Tier 1 alone |
| (S2) iso | ✗ (finite unfolding, tree regions) | ✓ | `O(m log m)` guaranteed | bottom-up canonical hashing |
| (S2) iso | ✓ | ✓ | GI-complete; linear-ish in practice | Tiers 1→2→3 |

## 4. The (S2) algorithm: three tiers

### Tier 0.5 — optimistic ordered pass (added during implementation)

An ordered match is a sound WITNESS for the unordered semantics: if the whole
comparison succeeds with Sets/Maps compared positionally, the identity
permutation satisfies every collection constraint. And real-world equal
collections overwhelmingly share insertion order (clones, dedups, rebuilds,
serialization round-trips). So run the entire comparison in ordered mode
first — pure linear Tier 1, no speculation ever — and only an ordered
MISMATCH involving at least one collection escalates to the full machinery.
Rejects involving collections pay ≤ 2×; aligned accepts (the common case) run
at ordered speed. This is the same interleaving philosophy as Adams–Dybvig's
`equal?`. Measured effect: Set-of-200-objects accept went 165µs → 29µs.

### Tier 1 — synchronized pair-walk (the deterministic region)

The old2 skeleton, kept: walk `(a, b)` pairs with an explicit stack;
`seenA: Map<object, u32>`, `seenB: Map<object, u32>` sharing one counter.

- On visiting a pair: if either is seen, require `seenA.get(a) === seenB.get(b)`
  (this enforces that the accumulated partial map is a bijection — injectivity
  in both directions — which is what makes `[a1,a2,a1] ≠ [b1,b1,b2]` fall out
  for free). Else register both with the next index — and KEEP TRAVERSING even
  when `a === b`.

  **Correction (found during implementation; the earlier revision of this doc
  claimed a register-then-early-out-on-identity was sound — it is not).**
  Counterexample: `x = []`, `y = []` (a clone), `s = [x]`; compare
  `A = [s, x]` vs `B = [s, y]`. Early-outing on the identical pair `(s, s)`
  skips registering `x` on both sides, and `(x, y)` then compares clean —
  but `|Reach(A)| = 3 ≠ 4 = |Reach(B)|`: not isomorphic. Traversing the
  identical pair registers `x` at the same index on both sides, and `(x, y)`
  correctly fails the index check. Identity is only a sound early-out at the
  TOP LEVEL, where the identity bijection witnesses the whole comparison.
  Functions and identity-only objects (WeakMap/WeakSet/Promise) are exempt:
  under identity equality, distinct-but-equal instances cannot exist, so
  their sharing structure can never diverge.
- Compare labels; recurse ordered edges immediately.
- Unordered collections: compare label (size, custom props) now; push the
  *pair* `(collA, collB)` onto a deferred list; do not enter elements.

**Lemma (Tier 1 sound & complete on ordered-only graphs).** If all edges are
ordered, the synchronized walk visits nodes of both graphs in the same
canonical (root + edge-order determined) sequence; the walk succeeds iff the
first-visit indexing is an isomorphism, and any isomorphism must equal that
indexing (a rooted graph with fully ordered edges has at most one isomorphism
onto another — φ is forced along every edge from the root). Hence linear-time
exact equality for the ordered fragment, cycles included. ∎

This is why deferral is not merely an optimization: it *partitions* the
problem into a forced region (solved exactly, linear) and a speculative
residue (usually tiny, often empty).

### Tier 1.5 — residue filtering (from old2's `simplifyDeferred`, completed)

For each deferred pair `(collA, collB)`, partition elements:

1. **Primitives** — match by collection membership (§6 equality caveats).
   Mismatch → false.
2. **Anchored objects** — elements already in `seenA`/`seenB`: element
   `a` with index `i` must match an element of `collB` with index `i`
   (via an inverse `index → object` view of `seenB`, maintained
   incrementally as an array — never rebuilt, fixing old2's staleness `!`
   comment). Mismatch → false.
3. **Free objects** — unseen on both sides. These are the true residue.

If every deferred pair empties → **true**, done. In practice this is the
overwhelmingly common exit: sets of primitives, sets of already-distinguished
objects.

Also here: **tree-region shortcut**. Free elements whose reachable subgraph is
acyclic, disjoint from the residue and from other free elements' regions
(checkable cheaply: no node revisited, no node in `seenA/B`, no unordered
descendant that isn't itself fully tree) can be **canonically hashed
bottom-up** (sort child hashes within unordered nodes) and matched
hash-to-hash, with exact recursive verification per matched pair to
absorb hash collisions. This is exact for trees — sharing is what breaks
bottom-up hashing as a canonical form ([a1,a2,a1] again), and tree regions
have none. Everything left goes to Tier 2.

### Tier 2 — color refinement on the union (the dequal3 "progressive serialization", properly)

Build one arena over both sides' residue subgraphs (arrays + typed arrays; no
per-node objects):

- Nodes: every object reachable from free residue elements, stopping at
  anchored nodes.
- **Initial color** = hash of the full local label (§1) — and for anchored
  nodes, their seen-index (they arrive pre-individualized, a huge head start
  no bare-graph GI solver gets).
- **Refinement round:** `newColor(v) = H(color(v), (slotᵢ, color(childᵢ))…, M{color(u) : u ∈ unordered(v)})` where `M` is a multiset hash
  (sort-free commutative combine of per-color hashes, or sorted-run hash).
- Iterate to fixpoint. With Hopcroft-style "process the smaller half"
  worklists over the partition structure: `O((n + m) log n)` total. Rounds
  needed ≤ diameter of the residue.

After every round, two **soundness checks**, both rejection-complete:

- **Global balance:** every color class must contain equally many A-side and
  B-side nodes.
- **Per-collection balance:** for each deferred pair, the color multiset of
  `collA`'s free elements must equal `collB`'s.

**Lemma (refinement colors are isomorphism-invariant).** By induction on
rounds: initial colors depend only on labels and anchor indices (both
preserved by any admissible φ, since anchors were forced in Tier 1); the
update preserves invariance. Hence imbalance at any round ⟹ not isomorphic ⟹
rejecting is sound. ∎

**Lemma (hash collisions are one-sided-safe).** A collision only *merges*
color classes, i.e. coarsens the partition. A coarsening of a balanced
partition stays balanced, so collisions can never manufacture the imbalance
we reject on; and acceptance is never granted by Tier 2 alone (only by Tier
3's verified bijection). Collisions therefore cost time (weaker pruning),
never correctness. This is what licenses fast 64-bit hashing with no escape
hatch needed. ∎

If refinement goes **discrete** (all classes singletons) — the generic case —
the color pairing *is* the candidate bijection: verify it edge-by-edge in
`O(n + m)` and return. Verification also covers the CFI-style caveat that
stable+balanced does not imply isomorphic.

### Tier 3 — individualization–refinement (the "permute the groups" endgame)

Only reached when the residue has genuine symmetry (equal-colored,
WL-indistinguishable elements). This is dequal3's "permute each group,
backtrack across groups", upgraded with propagation:

```
search(partition):
  if unbalanced: return false
  if discrete:   return verify(bijection)          // O(n+m)
  C ← smallest non-singleton class (fewest branches)
  a ← the fixed A-side element of C                 // fixing one side loses nothing:
                                                    // any iso maps a to SOME b ∈ C
  for b in B-side elements of C:
     refine(partition with a,b individualized to a fresh shared color)
     if search(...): return true                    // undo via trail, as in
  return false                                      // old2's seenStack truncation
```

**Completeness.** If φ is an isomorphism, then at every branch node φ(a) is
among the tried `b`s (φ preserves refinement colors by the invariance lemma),
so the branch containing φ survives to a discrete partition whose bijection
verify() accepts. If none exists, every leaf fails verify or balance →
false. Termination: each individualization strictly refines the partition;
depth ≤ n. ∎

Worst case exponential — necessarily so (§2) — but each individualization
re-runs refinement, which in labeled real-world data collapses the partition
immediately. The known bad inputs (CFI constructions, large regular
structures of *identical* unlabeled nodes) do not occur as program state;
even `dequalTest.ts`'s 100-node dense random graphs are refinement-discrete
in 2–3 rounds with high probability.

Optional refinements, deliberately deferred: orbit pruning via discovered
automorphisms (nauty's big gun; only pays on pathological symmetry),
component-wise decomposition of the residue (cheap, do it: disjoint residue
components search independently — turns products of costs into sums).

## 5. Why not X — dead ends, named

- **Full serialize-then-compare (`dequalSerializer.ts`)**: canonical only if
  traversal order is canonical; Sets force a choice of order, which is the
  whole problem. Kept only as a *hash* producer (Tier 2 initial colors,
  tree-region hashing) where order-sensitivity is repaired by sorting child
  hashes — never as the decision procedure.
- **Per-set greedy matching (old1 `_findDequalObjKey`)**: first-match-wins is
  wrong under sharing (old2's header admits this: "setA([1,2],[1,2],[3,4]) vs
  setB([1,2],[3,4],[3,4])") and O(n²·cost) besides. Subsumed.
- **Per-class bipartite matching instead of IR**: unsound — choices interact
  globally through shared/cyclic substructure; a perfect matching per class
  need not assemble into one bijection. (Matching *is* valid exactly in the
  independent tree-region case, which Tier 1.5 already handles by hashing.)
- **Blind `n!` permutation with cross-collection backtracking (dequal3
  header)**: IR is precisely this with (a) groups pre-shrunk to color classes,
  (b) constraint propagation between guesses, (c) early balance rejection. It
  never does more work than the blind version.
- **`===` fast-path before cycle registration**: wrong under (S2), see §1.

## 6. JS-specific equality nuances (decide once, here)

- **Primitive equality**: SameValue (`NaN ≡ NaN`, `-0 ≢ 0`) for values in
  ordered positions — but **SameValueZero for Set membership / Map keys**,
  because JS collections themselves cannot distinguish `0`/`-0` as members
  (a Set cannot contain both): `new Set([0]) ≡ new Set([-0])` is the only
  answer consistent with the collections' own semantics.
- **Map** = unordered multiset of entry-nodes, each with ordered `key`,
  `value` edges. Values hang off entries — a map key may be forced by a
  primitive/anchored key even when other keys are speculative.
- **Symbol props** (shipped 2026-07-11 as opt-in `checkSymbolProps`; also in
  `isoEqualStrict`): matched by symbol IDENTITY — the module-constant pattern,
  which covers `Symbol.for` automatically since the registry returns the same
  object. Distinct same-description symbols do NOT match. Off by default:
  `getOwnPropertySymbols` costs ~27ns/object even when symbol-free (+~25% on
  POJO-heavy paths). The dequal3 aspiration — same-description unique symbols
  as unordered entry-node collections — remains future work and slots
  cleanly into the residue machinery if ever wanted.
- **Boxed types / Date / RegExp / TypedArray / ArrayBuffer / DataView**:
  label data, compared in Tier 1 (old2's `_dequal*` leaf comparators are
  correct; keep the constructor-`switch` monomorphic dispatch).
- **Arrays, exactly** (decided 2026-07-11): holes ≠ `undefined` and are
  compared exactly BY DEFAULT — a hole can only hide where the slot read
  yields `undefined`, so the `i in a` probe costs nothing on dense data.
  Custom (non-index) own props are opt-in (`checkArrayOwnProps`): detecting
  them requires `Object.keys()` per array — an O(n) string allocation that
  measured 16× on the 10k flat-array hot path. Node dodges this only via the
  V8-internal `getOwnNonIndexProperties` binding, which userland lacks.
  Set/Map custom own props ARE compared by default (their `Object.keys()` is
  exactly the custom props — elements/entries are not properties — so it is
  always cheap).
- **Functions**: identity, plus optional source-string equality (old2) —
  label data either way; own props traversed like POJOs per options.
- **Realms**: constructor identity fails cross-realm; compare
  `Symbol.toStringTag`/`constructor.name` chain when `crossRealm: true`.
- **The UNORDERED protocol** (shipped 2026-07-11; supersedes dequal3's
  `shouldSupportMultisetsMultimaps` + detector aspiration with something
  strictly more general): any ITERABLE object carrying
  `Symbol.for('unordered-collection')` — own or inherited, so a class declares
  it once on its prototype — or matched by the `isUnorderedCollection`
  detector option, compares as the MULTISET of its iterated values under
  full S2. The generalization DISSOLVES the multimap case: entries-style
  collections yield `[k, v]` pairs from their iterators, and pairs are just
  values. Semantics: same prototype required; multiplicity significant
  (true multisets — COLL verification counts φ-images rather than setting
  them); primitives SameValue (custom collections CAN hold both 0 and -0,
  unlike Set, so SVZ would be lossy); own props are NOT identity (contents
  are); iteration must be repeatable. Cost of the universal declaration
  check: one negative symbol read per side per pair, measured 1.6–2.4ns —
  V8's descriptor cache makes "check everything" affordable, which is what
  licenses the simple contract. The residue machinery needed almost nothing
  new: Kind.UNORD arena nodes and count-based (rather than set-based)
  anchored filtering and COLL verification.
- **Options** (trimmed from dequal3's list; each maps cleanly onto labels or
  edge sets, none perturb the core): `areMapsSetsOrdered` (applies to
  declared collections too), `areObjectKeysOrdered`, `sharingSensitive`
  (S2 vs S1), `isUnorderedCollection`, descriptor/proto/symbol/
  non-enumerable traversal toggles, extensibility.

## 6.5 Hostile-shape hardening (adversarial review, 2026-07-11)

First external review produced six confirmed wrong-verdict/throw repros, all
one root cause: dispatching on `.constructor`, an ordinary shadowable own
prop. `{constructor: Array, x: 1}` (a shape that occurs in REAL data — any
JSON with a "constructor" field) steered plain objects into the array
comparator; `{constructor: Set}` threw; `Object.create(Number.prototype)`
crashed `valueOf`; null-proto identity was conflated.

The durable invariant, enforced in `intrinsics.ts`:

> Every type decision and every content read goes through internal-slot-backed
> operations — `getPrototypeOf` dispatch, `Array.isArray`/`ArrayBuffer.isView`,
> index reads, and cached PROTOTYPE getters/methods that throw unless the
> internal slot ([[SetData]], [[DateValue]], …) is genuinely present. Own
> properties can never redirect control, crash a comparator, or forge content;
> they only ever surface as ordinary own-prop data, compared as such.

Consequences: prototype-only fakes (`Object.create(Set.prototype)`) compare
as plain objects; a real instance never equals a fake; shadowed `set.has`/
`size`/`Symbol.iterator`/`date.getTime` cannot lie. Perf is preserved by
cleanliness probes that gate unshadowed collections (i.e. all real data) back
into V8's direct for-of/`has` fast paths — manual intrinsic iterators
measured 4× slower and are reserved for actually-shadowed inputs.
Cost of unforgeable dispatch on the POJO-tree bench: ~14%.

Second review round (R5/R7, same day) tightened two more screws:

- **R5 (WRONG-SHAPE PERF + THROW):** IR search recursion depth equaled the
  symmetry-class size — a Set of m interchangeable elements ran quadratically
  and died in a raw RangeError at m≈20k (bypassing the typed budget error,
  since the default budget is ∞). Fixed by (a) GREEDY-FIRST verification at
  every stable partition: pair class members arbitrarily and run the exact
  verifier — symmetric-but-equal inputs accept in O(n+m) with zero branching
  (m=20k: 19s+crash → ~1s), sound because acceptance still only comes from
  verify, complete because failure falls through to the search; and (b) an
  explicit-stack search, so depth can never overflow the call stack.
- **R7:** cleanliness probes checked own props only; a SUBCLASS override
  lives on the subclass prototype and slipped through — probes now also
  require the RESOLVED method to be the intrinsic. The clean ordered path
  called unchecked `.values()`/`.entries()`; it now iterates via the checked
  `Symbol.iterator` only. Detached ArrayBuffers (view construction throws)
  compare as content-free: detached twins equal, detached vs live unequal.

## 7. Performance engineering

- **Zero-allocation fast path**: primitives, and objects of leaf types,
  decided before any context exists. Context (maps, deferred list) created
  lazily on first non-leaf object; pooled/reset for reuse (old2's
  `createContext`/`resetContext`).
- **Tier 1** is the hot loop: explicit stack (no recursion), constructor
  `switch` with per-type duplicated loops for inline-cache monomorphism
  (already the house style — see `_dequalTypedArrays`, `dequalTest`'s
  duplicated `stack.push`).
- **No strings in Tier 2**: colors are u32/f64-lane hashes in typed arrays;
  partition = the classic three-array structure (element array, position
  index, class boundaries) giving O(1) splits and smaller-half worklists.
  The string serializer never runs unless hashing/debug output is asked for.
- **Budgeted escalation**: Tier 3 carries a step budget option
  (`maxSpeculativeSteps`); on exhaustion throw a typed error rather than
  silently answer — honest about the GI cliff, and callers comparing
  benchmark outputs (the motivating use case) can catch and fall back.
- **Bench targets**: parity with `dequal` (npm) on the ordered/acyclic 99%
  (it does no cycle or unordered work — matching it while carrying a lazily
  allocated context is the bar); residue benches from `dequalTest`'s
  generator at n=100..2000; adversarial CFI pair to demonstrate the budget.

## 8. Correctness harness

`dequalTest.ts` is already the right shape; extend:

1. **Metamorphic accept**: random graph → `structuredClone` + shuffle every
   Set (existing). Add: rebuild Maps in shuffled entry order; clone into
   cross-realm (node `vm`) when that option lands.
2. **Metamorphic reject**: single flipped edge (existing); add single label
   perturbation, single sharing change (split a shared node into two clones —
   catches (S1)/(S2) confusion, the `[a,a]`/`[b,a]` battery).
3. **Brute-force oracle** for residues ≤ 7 elements via
   `forAllPermutations_nonLexiographic`: check Tier 2/3 against exhaustive
   permutation on thousands of small random cases.
4. **Adversarial fixtures**: `createTrickGraphs0` (existing), a CFI pair, the
   old2 header's multiset trap, `-0`/`NaN` in every position class,
   same-description unique symbols.
5. **Tier isolation**: force-skip Tier 1.5 shortcuts in tests to exercise
   Tiers 2–3 on inputs that would normally short-circuit.

## 9. Implementation plan & status (v1 SHIPPED 2026-07-11)

Shipped layout (arena build and the solver wanted shared state, so the
refine/search split collapsed into `arena.ts` + `solve.ts`):

```
dequal/
  DESIGN.md      (this doc)
  dequal4.ts             ✅ public API: createIsoEqual(opts) → isoEqual(a, b);
                            optimistic-ordered phase (Tier 0.5), pooled ctx
  tier1.ts               ✅ pair-walk + leaf comparators + residue filtering
                            (Tiers 1 + 1.5)
  arena.ts               ✅ residue → flat CSR graph, labels, COLL/ENTRY
                            virtual nodes (Tier 2 substrate)
  solve.ts               ✅ refinement + balance rejection + IR search +
                            exact verify (Tiers 2–3)
  hashes.ts              ✅ 32-bit mixing, SameValue/SVZ primitive hashing
  intrinsics.ts          ✅ cached prototype intrinsics + brand probes (§6.5)
  testKit.ts       ✅ seeded PRNG, graph gen, shuffled clone,
                            brute-force S2 oracle (test-only)
  isoequal.test.ts        ✅ 31 tests: unit battery, probe-table cases,
                            oracle cross-validation (2k+ fuzz), metamorphic,
                            budget behavior
  isoequal.bench.test.ts  ✅ opt-in (BENCH=1) vs npm dequal + node iDSE
```

Deviations from the plan, all recorded above: Tier 0.5 added (§4); the
register-then-`===`-early-out claim corrected (§4); refinement uses hash
rounds with (oldColor, hash) monotone keys rather than the Hopcroft partition
structure (§7's upgrade path still open); tree-region bottom-up hashing
(Tier 1.5 shortcut) not yet needed — refinement handles those cases fast.

Benchmarks (2026-07-11, Node 24; table in isoequal.bench.test.ts): fastest of
{npm dequal, node isDeepStrictEqual, dequal4} on flat arrays (5.6µs vs 10/44),
parity on primitive sets, 1.3× node on object sets (npm: 52× slower and
unsound), 1.25× node on POJO trees — the full-sharing-registration tax that
buys S2 correctness node doesn't have.

Coverage strokes landed 2026-07-11 (after v1): exact sparse-array holes
(default, zero-cost), Set/Map custom own props (default), array custom props
(`checkArrayOwnProps`, opt-in — §6 records why), symbol-keyed props
(`checkSymbolProps`, opt-in, identity-matched), `isoEqualStrict` preset.

Remaining strokes:

1. **(S1) engine** (`sharingSensitive: false`): full-graph refinement to the
   coarsest (size-respecting) bisimulation — the existing refinement engine
   over a whole-graph arena with no anchors, plus a final exact-signature
   pass per class to discharge hash collisions (S1 accepts are not otherwise
   verified). Recovers the sharing-registration tax for callers who accept
   unfolding semantics.
2. Options long tail (descriptors, prototypes, realms, multisets, getter
   policy, same-description symbol grouping), then swap live-code imports
   off npm `dequal` where cyclic/unordered semantics are wanted.
3. Perf polish: Hopcroft partition refinement if residue benches demand;
   per-type walk loop splitting; CFI fixture for the budget path; chase the
   remaining ~1.25× vs node on POJO trees (seen-map registration constant).
4. Packaging: extract as a standalone repo/npm package with the README
   telling the §10 story (probe table = the pitch); React/Vitest/immutable-
   state audiences care exactly about diffing with unordered collections.

## 10. Prior art & novelty position (checked 2026-07-11)

**Theory — all components classical, deliberately so:**

- (S1) *is* hyperset equality: Aczel's AFA defines equality of non-well-founded
  sets as bisimulation; Dovier–Piazza–Policriti, "An efficient algorithm for
  computing bisimulation equivalence" (TCS 311, 2004) solves exactly
  cyclic-sets-of-sets under (S1) — our S1 engine, pre-invented.
- Tiers 2–3 = color refinement (Weisfeiler–Leman 1968) + individualization–
  refinement (McKay's nauty 1981; bliss, Traces). CFI 1992 gives the
  WL-indistinguishable counterexamples that force Tier 3's existence.
- Nearest PL-practice ancestor: Adams & Dybvig, "Efficient Nondestructive
  Equality Checking for Trees and Graphs" (ICFP 2008) — R6RS `equal?` on
  cycles via union-find + interleaving. Ordered structures only, (S1)
  semantics: they solved the easy quadrant excellently; this design targets
  the GI-complete quadrant.
- Near-neighbor on our graph class: "Hyperset Individualisation Algorithms"
  (ResearchGate 396510123, ~2025) — IR aimed at set-membership graphs.
- Heap canonicalization in model checking (Iosif 2002; Musuvathi & Dill,
  CMC): canonical heap orderings for state hashing — ordered fields only,
  punts on unordered containers.

**Practice — empty or wrongly occupied.** Probe receipts (node v24, 2026-07-11,
`./ecosystemProbe.mjs` — rerun with `node ecosystemProbe.mjs`, cases from §8;
lodash and fast-deep-equal added to the table 2026-07-11 after installing
them as bench devDeps):

| case | `dequal` npm | fast-deep-equal/es6 | lodash isEqual | node `isDeepStrictEqual` | correct (S2) |
|---|---|---|---|---|---|
| sharing `[a1,a2,a1]` vs `[b1,b1,b2]` | true ✗ | true ✗ | true ✗ | true ✗ | false |
| multiset trap (acyclic) | **true ✗** | false ✓ | false ✓ | false ✓ | false |
| cyclic shuffled sets | RangeError ✗ | **false ✗** | true ✓ | true ✓ | true |
| trick graphs (§8) | RangeError ✗ | false ✓ | false ✓ | false ✓ | false |
| self-cycle | RangeError ✗ | RangeError ✗ | true ✓ | true ✓ | true |

`dequal` npm is unsound even acyclically (no multiplicity counting) and
crashes on every cycle; fast-deep-equal crashes on self-cycles AND returns a
false NEGATIVE on genuinely-equal cyclic shuffled sets (its Set support is
membership-only) — in the object-set benchmark it produces that wrong answer
in 0.3µs, the fastest wrong answer in the west; lodash and node are the
strongest incumbents but implement (S1)-flavored semantics with
recursion-stack-only cycle tracking (both answer true on the sharing case,
which S1 permits and S2 forbids); lodash's set matching is additionally
O(n²) — 1.09 SECONDS on a 10k-primitive set where isoequal takes 123µs.
isoequal is the only implementation correct on all five cases, while being
the fastest on flat arrays and primitive sets (five-way numbers in
isoequal.bench.test.ts). Untested still: ramda/jest (same greedy family).

**Defensible novelty claims:** (1) identifying PL deep-equality-with-Sets as
GI-complete and exposing the S1/S2 dichotomy as an API-level semantics choice;
(2) anchored tiering — the forced ordered region pre-individualizes the IR
search; (3) the artifact: a sound-and-complete implementation where every
incumbent crashes or is quietly wrong. Adams–Dybvig-shaped contribution:
old gears, new machine — tool-paper or flagship-README grade, not new theory.

## 11. Complexity summary

- Ordered/cyclic region: `O(n + m)` — exact, Tier 1.
- Unordered residue, generic data: one-to-few refinement rounds,
  `O((r + e) log r)` on residue size `r` — refinement goes discrete, verify
  `O(r + e)`.
- Unordered residue, symmetric adversarial: IR search, exponential worst case
  (unavoidable: GI-complete), budgeted, never wrong.
- (S1) opt-in: `O(m log n)` unconditional.
