/* Opt-in benchmark: `BENCH=1 vitest run …isoequal.bench.test.ts`.
 * Five-way: npm `dequal` (crashes on cycles, unsound on set multiplicity),
 * fast-deep-equal/es6 (crashes on self-cycles; WRONG on object sets — see
 * below), lodash isEqual (S1-flavored; O(n²) sets), node isDeepStrictEqual
 * (strongest incumbent; S1-flavored — wrong on sharing), isoequal (the only
 * one correct on all of ecosystemProbe.mjs). Incumbent rows print their
 * verdicts but are NOT asserted — some are wrong, and that is the point.
 *
 * 2026-07-11, Node 24 / M-series, moderate background load (ratios are the
 * signal; quiet-machine absolutes run ~2× lower):
 *
 *   POJO tree ~1k:     npm 249µs · fde 200µs · lodash 689µs · node 355µs · isoequal 539µs
 *   flat array 10k:    npm  79µs · fde  85µs · lodash  53µs · node  21µs · isoequal  12µs ✦
 *   Set of 200 objs:   npm 3173µs · fde 0.3µs(WRONG: false) · lodash 347µs · node 41µs · isoequal 62µs
 *   Set of 10k prims:  npm 118µs · fde 127µs · lodash 1.09 SECONDS · node 152µs · isoequal 123µs ✦
 *   tiny object ×500k: npm 160ns · node 190ns · isoequal 710ns
 *
 * The POJO-tree and tiny-object gaps vs node/npm are the price of full
 * sharing registration (2 Map ops per object — what S2 means); node/lodash
 * only track their recursion stacks — which is exactly why both answer true
 * on [a,a] vs [b,a2]. The planned S1 engine (design §9) is the sanctioned
 * way to trade that strictness back for speed. */
import { dequal as dequalNpm } from 'dequal'
import fastDeepEqual from 'fast-deep-equal/es6'
// @ts-expect-error no bundled types; bench-only dep
import lodashIsEqual from 'lodash/isEqual.js'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isoEqual } from './index.js'

const time = (label: string, fn: () => boolean, iters: number) => {
    // warmup
    for (let i = 0; i < 50; i++) fn()
    const t0 = performance.now()
    let acc = true
    for (let i = 0; i < iters; i++) acc = fn() && acc
    const dt = performance.now() - t0
    // eslint-disable-next-line no-console
    console.info(`${label}: ${((dt / iters) * 1000).toFixed(2)}µs/op (${iters} iters) → ${acc}`)
    return acc
}

const deepPojo = (depth: number, width: number): unknown => {
    if (depth === 0) return { n: depth, s: 'leaf', arr: [1, 2, 3] }
    const o: Record<string, unknown> = { n: depth, s: `level${depth}` }
    for (let i = 0; i < width; i++) o[`c${i}`] = deepPojo(depth - 1, width)
    return o
}

describe.skipIf(!process.env.BENCH)('isoequal baseline vs npm dequal', () => {
    it('ordered acyclic POJO tree (depth 6, width 3 ≈ 1k nodes)', () => {
        const a = deepPojo(6, 3)
        const b = deepPojo(6, 3)
        time('  npm dequal', () => dequalNpm(a, b), 2000)
        time('  fast-d-e/es6', () => fastDeepEqual(a, b) as boolean, 2000)
        time('  lodash    ', () => lodashIsEqual(a, b) as boolean, 2000)
        time('  node iDSE ', () => isDeepStrictEqual(a, b), 2000)
        expect(time('  isoequal  ', () => isoEqual(a, b), 2000)).toBe(true)
    })
    it('large flat arrays of numbers (10k)', () => {
        const a = Array.from({ length: 10_000 }, (_, i) => i * 1.5)
        const b = [...a]
        time('  npm dequal', () => dequalNpm(a, b), 2000)
        time('  fast-d-e/es6', () => fastDeepEqual(a, b) as boolean, 2000)
        time('  lodash    ', () => lodashIsEqual(a, b) as boolean, 2000)
        time('  node iDSE ', () => isDeepStrictEqual(a, b), 2000)
        expect(time('  isoequal  ', () => isoEqual(a, b), 2000)).toBe(true)
    })
    it('sets of distinct objects (200 elements)', () => {
        const mk = () => new Set(Array.from({ length: 200 }, (_, i) => ({ id: i, v: `s${i}` })))
        const a = mk()
        const b = mk()
        time('  npm dequal', () => dequalNpm(a, b), 200)
        time('  fast-d-e/es6', () => fastDeepEqual(a, b) as boolean, 200)
        time('  lodash    ', () => lodashIsEqual(a, b) as boolean, 200)
        time('  node iDSE ', () => isDeepStrictEqual(a, b), 200)
        expect(time('  isoequal  ', () => isoEqual(a, b), 200)).toBe(true)
    })
    it('tiny objects at high frequency (React-props shape)', () => {
        const a = { x: 1, y: 'label', on: true }
        const b = { x: 1, y: 'label', on: true }
        time('  npm dequal', () => dequalNpm(a, b), 500_000)
        time('  node iDSE ', () => isDeepStrictEqual(a, b), 500_000)
        expect(time('  isoequal  ', () => isoEqual(a, b), 500_000)).toBe(true)
    })
    it('primitive sets (10k members)', () => {
        const a = new Set(Array.from({ length: 10_000 }, (_, i) => i))
        const b = new Set(Array.from({ length: 10_000 }, (_, i) => 9999 - i))
        time('  npm dequal', () => dequalNpm(a, b), 500)
        time('  fast-d-e/es6', () => fastDeepEqual(a, b) as boolean, 500)
        time('  lodash    ', () => lodashIsEqual(a, b) as boolean, 3) // ~1.09 s/op: O(n²) sets
        time('  node iDSE ', () => isDeepStrictEqual(a, b), 500)
        expect(time('  isoequal  ', () => isoEqual(a, b), 500)).toBe(true)
    })
})
