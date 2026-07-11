<!-- Issue for kentcdodds/use-deep-compare-effect. File BEFORE the PR; PR references it. -->

# `dequal` dependency: spurious effect re-runs on equal deps, and a crash on cyclic values

Two reproducible defects in the `dequal` dependency surface directly through
`useDeepCompareEffect`:

**1. Spurious re-runs: `dequal` returns `false` for genuinely equal values.**
Its Map/Set matching is greedy (first structurally-equal key wins, no
backtracking), so equal collections with duplicate-shaped keys compare
unequal:

```js
import { dequal } from 'dequal'
dequal(new Map([[{}, 1], [{}, 2]]), new Map([[{}, 2], [{}, 1]])) // false — same entries!
```

Any component passing such a value in deps gets its effect re-run on every
render despite deps being deeply equal — the exact failure mode this hook
exists to prevent.

**2. Crash: any cyclic value in deps throws `RangeError: Maximum call stack
size exceeded`.** Cyclic references occur in real state (normalized stores
with parent links, DOM-adjacent data):

```js
const a = {}; a.self = a
const b = {}; b.self = b
dequal(a, b) // RangeError
```

Both are pinned with executable repros in [isoequal's compatibility
audit](https://github.com/XyraSinclair/isoequal/blob/main/src/dequalCompat.test.ts),
together with an 8,000-pair differential fuzz showing agreement with `dequal`
everywhere outside its defect classes.

I have a PR ready that swaps the dependency for
[`isoequal`](https://github.com/XyraSinclair/isoequal) (zero runtime deps,
dual ESM/CJS): this package's own test suite passes unchanged (8/8, 2/2
snapshots), and both defects above become correct behavior. Happy to adjust
scope however you prefer — including just documenting the limitation if you'd
rather not touch deps in maintenance mode.
