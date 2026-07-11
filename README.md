# isoequal

Deep equality that actually handles **cyclic structures** and **unordered
collections** — `Set`, `Map`, and anything declaring the
[unordered-collection protocol](#the-unordered-collection-protocol) — under
sound, sharing-sensitive **isomorphism semantics**.

```ts
import { isoEqual } from 'isoequal'

isoEqual(new Set([{ a: 1 }, [2, 3]]), new Set([[2, 3], { a: 1 }])) // true

const ring = (k) => {
    const nodes = Array.from({ length: k }, () => ({}))
    for (let i = 0; i < k; i++) nodes[i].next = nodes[(i + 1) % k]
    return nodes
}
isoEqual(new Set(ring(6)), new Set(shuffle(ring(6)))) // true  — node says FALSE
isoEqual(new Set([...ring(3), ...ring(3)]), new Set(ring(6))) // false — correctly
```

## Why this library exists

Comparing values that contain **both cycles and unordered collections** is
graph isomorphism — a genuinely hard problem that every mainstream deep-equal
punts on, each in its own way. Receipts (Node 24; reproduce with
`node ecosystemProbe.mjs` in the repo):

| case | `dequal` | `fast-deep-equal/es6` | `lodash.isEqual` | `util.isDeepStrictEqual` | **isoequal** |
|---|---|---|---|---|---|
| sharing: `[a,a]` vs `[b,a2]` | ✗ true | ✗ true | ✗ true | ✗ true | ✓ false |
| set multiset trap | ✗ **true** | ✓ | ✓ | ✓ | ✓ |
| cyclic shuffled sets | 💥 RangeError | ✗ **false** | ✓ | ✓ | ✓ |
| trick graphs (similar, non-isomorphic) | 💥 | ✓ | ✓ | ✓ | ✓ |
| self-cycle | 💥 | 💥 | ✓ | ✓ | ✓ |
| **6-ring vs shuffled 6-ring in a Set** | 💥 | ✗ | ✓ | ✗ **false, 24/24 orders** | ✓ |

That last row deserves a sentence: give Node's `util.isDeepStrictEqual` two
Sets containing two genuinely equal six-node cyclic rings, in different
insertion orders, and it returns **false — for every one of 24 insertion
orders tried** (8/24 wrong at ring size 3, 17/24 at size 4; the acyclic
control passes). The most trusted incumbent cannot reliably compare cyclic
unordered collections *at all*. `lodash` survives rings but is quadratic in
set size (below), sharing-insensitive, and semantically undocumented.

## What "correct" means here

isoequal decides **isomorphism of reachable object graphs**: `isoEqual(A, B)`
is true iff there is a one-to-one correspondence between the objects reachable
from `A` and from `B` that maps `A` to `B` and preserves every type, value,
ordered field, and unordered membership — with **sharing significant**:

```ts
const x = {}
isoEqual([x, x], [{}, {}]) // false — one shared object vs two distinct ones
isoEqual([x, x], [x, x])   // true
```

- `NaN` equals `NaN`; `-0` differs from `0` (SameValue) — except inside
  `Set`/`Map` keys, which use the collections' own SameValueZero
  (`new Set([0])` equals `new Set([-0])`, because a `Set` cannot hold both).
- Functions, `WeakMap`/`WeakSet`, `Promise` compare by identity.
- Sparse-array holes differ from stored `undefined` (checked at zero cost).
- Type identity is prototype-based and **unforgeable**: `{constructor: Array}`
  is just an object with a property, `Object.create(Set.prototype)` has no
  Set internals and compares as a plain object, and a subclass that lies
  about `size`/`has`/`Symbol.iterator` cannot forge a verdict — every type
  decision and content read goes through internal-slot-backed intrinsics.

## The unordered-collection protocol

Any **iterable** can declare that its iteration order is meaningless:

```ts
const UNORDERED = Symbol.for('unordered-collection')

class MultiSet<T> {
    #items: T[]
    get [UNORDERED]() { return true }          // once, on the prototype
    *[Symbol.iterator]() { yield* this.#items }
}

isoEqual(new MultiSet([1, 1, 2]), new MultiSet([2, 1, 1])) // true — multiplicity counts
isoEqual(new MultiSet([1, 1, 2]), new MultiSet([1, 2, 2])) // false
```

A declared collection compares as the **multiset of its iterated values**,
under full isomorphism semantics — duplicates, sharing, nesting, and cycles
all significant. Entries-style collections (multimaps) need nothing extra:
their iterators yield `[key, value]` pairs, and pairs are just values. For
libraries whose classes you don't control:

```ts
const eq = createIsoEqual({ isUnorderedCollection: (o) => o instanceof TheirBag })
```

The symbol is deliberately **package-neutral** (`'unordered-collection'`, not
`'isoequal.…'`): it is a protocol any equality/serialization/diff library can
honor, in the spirit of `Symbol.iterator`.

## Performance

The architecture is three-tiered: an optimistic linear pass that wins whenever
collections share insertion order (clones and rebuilds almost always do); a
deterministic-region walk plus residue filtering that resolves almost
everything else; and — only for genuinely ambiguous residue — color
refinement with an individualization search whose acceptances are always
re-verified exactly. Hash collisions provably cannot cause a wrong answer.

Five-way numbers (Node 24, Apple Silicon; run `npm run bench` yourself):

| workload | dequal | fast-deep-equal | lodash | node | **isoequal** |
|---|---|---|---|---|---|
| flat array, 10k numbers | 79µs | 85µs | 53µs | 21µs | **12µs** ✦ |
| Set of 10k primitives | 118µs | 127µs | **1.09 s** | 152µs | **123µs** ✦ |
| Set of 200 objects | 3,173µs | 0.3µs *(wrong)* | 347µs | 41µs | 62µs |
| POJO tree, ~1k nodes | 249µs | 200µs | 689µs | 355µs | 539µs |
| tiny object, ×500k | 0.16µs | — | — | 0.19µs | 0.71µs |

Fastest on flat data and primitive sets; within ~1.5× of Node on object sets
and POJO trees — and the gap **is** the feature: full sharing registration is
what the incumbents skip, and skipping it is exactly why they answer `true`
on `[a,a]` vs `[b,a2]` and why Node fails the rings. (lodash's 1.09 seconds
on a 10k-element set is not a typo; its set matching is O(n²).)

## Worst case, honestly

General cyclic-unordered equality is GI-complete, so no library can be fast
on *adversarially symmetric* inputs — most just answer wrong instead.
isoequal is never wrong: pathological symmetric-but-equal inputs (e.g. a Set
of 20,000 interchangeable elements) resolve in linear time via greedy exact
verification, and for the truly adversarial rest you can set a work budget:

```ts
const eq = createIsoEqual({ maxSpeculativeOps: 1e7 })
eq(a, b) // may throw IsoEqualBudgetError instead of hanging — never lies
```

## The reference implementation

The optimized engine is ~1,500 lines of tiered machinery. The *idea* is
[~120 lines](./src/reference.ts): one partial bijection between the two
object graphs, extended by guessing, checked by recursion, retracted on
failure via a trail. Read it in one sitting, believe it, then trust the fast
version — which is differentially tested against it (and against a
brute-force isomorphism oracle) on thousands of random cyclic graphs.

```ts
import { isoEqualReference } from 'isoequal' // same verdicts, exponential worst case
```

## API

```ts
isoEqual(a, b)                    // default instance
isoEqualStrict(a, b)              // + array custom props, + symbol-keyed props
createIsoEqual({
    areMapsSetsOrdered?: boolean          // treat collection order as significant
    areObjectKeysOrdered?: boolean        // require same key enumeration order
    checkArrayOwnProps?: boolean          // regex-match-style array extras (opt-in: costs an
                                          //   Object.keys per array — Node dodges this only
                                          //   via a V8-internal binding userland lacks)
    checkSymbolProps?: boolean            // own enumerable symbol props, identity-matched
    isUnorderedCollection?: (o) => boolean
    maxSpeculativeOps?: number            // default Infinity; throws IsoEqualBudgetError
})
UNORDERED                          // === Symbol.for('unordered-collection')
```

## Verification

Beyond ~90 unit cases (including adversarial batteries for forged
constructors, lying subclasses, detached ArrayBuffers, and prototype-only
fakes), the suite cross-validates against a **brute-force isomorphism
oracle** — an exhaustive bijection search transcribed directly from the
semantics — on thousands of seeded random cyclic graphs over arrays, sets,
maps, and plain objects, plus metamorphic testing (shuffled clones must
equal; single-edge mutants must differ) at larger scales. The full design,
with proofs of the soundness architecture and the complexity story, is in
[DESIGN.md](./DESIGN.md).

## License

MIT © Xyra Sinclair
