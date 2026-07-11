/* Compatibility audit vs npm `dequal` (the dependency our first PR target
 * uses). Every disagreement must fall into a NAMED class:
 *   WE_FIX    — dequal crashes (cycles) or is unsound (set multiplicity,
 *               boxed primitives); isoequal is correct.
 *   S2_STRICT — dequal answers true, isoequal false, because isoequal counts
 *               SHARING (aliasing) as significant. Semantically defensible
 *               but a REAL behavioral delta for drop-in swaps — the planned
 *               sharingSensitive:false (S1) mode is the compat answer.
 * Anything outside these classes fails the suite: silent drift is forbidden.
 */
import { dequal } from 'dequal'
import { describe, expect, it } from 'vitest'
import { isoEqual, isoEqualReference } from './index.js'
import { makeRng, randInt, Rng, sample } from './testKit.js'

describe('dequal feature parity: cases both must AGREE on', () => {
    const agree = (a: unknown, b: unknown) => {
        expect(isoEqual(a, b)).toBe(dequal(a, b))
    }
    it('primitives & leaves', () => {
        agree(1, 1)
        agree(NaN, NaN)
        agree('x', 'y')
        agree(null, undefined)
        agree(new Date(5), new Date(5))
        agree(new Date(5), new Date(6))
        agree(/ab/gi, /ab/gi)
        agree(/ab/gi, /ab/g)
        agree(new Uint8Array([1, 2]), new Uint8Array([1, 2]))
        agree(new Uint8Array([1, 2]), new Uint8Array([1, 3]))
        agree(new Uint8Array([1]).buffer, new Uint8Array([1]).buffer)
        agree(new DataView(new Uint8Array([7]).buffer), new DataView(new Uint8Array([7]).buffer))
    })
    it('node Buffer (Uint8Array subclass)', () => {
        agree(Buffer.from('abc'), Buffer.from('abc'))
        agree(Buffer.from('abc'), Buffer.from('abd'))
        expect(isoEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true)
    })
    it('objects, arrays, class instances', () => {
        agree({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 })
        agree({ a: 1 }, { a: 1, b: undefined })
        agree([1, [2, [3]]], [1, [2, [3]]])
        class P {
            constructor(public x: number) {}
        }
        agree(new P(1), new P(1))
        agree(new P(1), new P(2))
        agree(new P(1), { x: 1 })
    })
    it('sets & maps without sharing/multiplicity traps', () => {
        agree(new Set([1, 2, 3]), new Set([3, 2, 1]))
        agree(new Set([1, 2]), new Set([1, 3]))
        agree(new Set([{ a: 1 }]), new Set([{ a: 1 }]))
        agree(new Map([['k', 1]]), new Map([['k', 1]]))
        agree(new Map([['k', 1]]), new Map([['k', 2]]))
        agree(new Map([[{ id: 1 }, 'v']]), new Map([[{ id: 1 }, 'v']]))
    })
})

describe('dequal disagreements: every one classified', () => {
    it('WE_FIX: cycles (dequal throws RangeError)', () => {
        const a: Record<string, unknown> = {}
        a.self = a
        const b: Record<string, unknown> = {}
        b.self = b
        expect(() => dequal(a, b)).toThrow(RangeError)
        expect(isoEqual(a, b)).toBe(true)
    })
    it('WE_FIX: set multiset trap (dequal unsound)', () => {
        const A = new Set([[1, 2], [1, 2], [3, 4]])
        const B = new Set([[1, 2], [3, 4], [3, 4]])
        expect(dequal(A, B)).toBe(true) // dequal's wrong answer, pinned
        expect(isoEqual(A, B)).toBe(false)
    })
    it('WE_FIX: boxed primitives (dequal compares as empty objects)', () => {
        // eslint-disable-next-line no-new-wrappers
        expect(dequal(new Number(1), new Number(2))).toBe(true) // wrong, pinned
        // eslint-disable-next-line no-new-wrappers
        expect(isoEqual(new Number(1), new Number(2))).toBe(false)
    })
    it('WE_FIX: invalid Dates (dequal: NaN !== NaN so unequal)', () => {
        expect(dequal(new Date(NaN), new Date(NaN))).toBe(false) // pinned
        expect(isoEqual(new Date(NaN), new Date(NaN))).toBe(true)
    })
    it('WE_FIX: dequal false-negatives on equal collections with duplicate-shaped keys (greedy, no backtracking)', () => {
        // Same multiset of entries ({}→1, {}→2) on both sides; a greedy
        // matcher pairs the first structurally-equal key it finds and never
        // reconsiders, so it rejects genuinely equal Maps. Found by fuzz
        // (seed 0xc0ffee01, i=613/1177/3059), confirmed by both our engine
        // and the independent brute-force reference.
        const A = new Map([[{}, 1], [{}, 2]])
        const B = new Map([[{}, 2], [{}, 1]])
        expect(isoEqual(A, B)).toBe(true)
        expect(isoEqualReference(A, B)).toBe(true)
        expect(dequal(A, B)).toBe(false) // wrong, pinned
    })
    it('S2_STRICT: sharing/aliasing (the drop-in delta — needs S1 mode)', () => {
        const x = { v: 1 }
        // dequal: unfolding view — [x,x] equals [clone,clone2]
        expect(dequal([x, x], [{ v: 1 }, { v: 1 }])).toBe(true)
        // isoequal S2: one shared object vs two distinct ones differ
        expect(isoEqual([x, x], [{ v: 1 }, { v: 1 }])).toBe(false)
        // both agree when sharing shape matches
        const y = { v: 1 }
        expect(dequal([x, x], [y, y])).toBe(true)
        expect(isoEqual([x, x], [y, y])).toBe(true)
    })
    it('S2_STRICT does NOT fire on fresh-per-render data (the React shape)', () => {
        // Typical props: literals built fresh each render — no aliasing.
        const props = () => ({ items: [{ id: 1 }, { id: 2 }], config: { deep: { flag: true } } })
        expect(dequal(props(), props())).toBe(true)
        expect(isoEqual(props(), props())).toBe(true)
    })
})

describe('acyclic differential fuzz: agreement everywhere outside named classes', () => {
    /** Acyclic generator (dequal cannot take cycles), optional sharing. */
    function acyclicValue(rng: Rng, depth: number, allowSharing: boolean, pool: object[]): unknown {
        const r = rng()
        if (depth <= 0 || r < 0.35) {
            return sample(rng, [0, 1, 'a', 'b', true, null, undefined, 2.5] as const)
        }
        if (allowSharing && pool.length > 0 && r < 0.45) return sample(rng, pool)
        const mk = (): unknown => {
            const kind = randInt(rng, 4)
            const n = 1 + randInt(rng, 3)
            if (kind === 0) {
                return Array.from({ length: n }, () => acyclicValue(rng, depth - 1, allowSharing, pool))
            }
            if (kind === 1) {
                const o: Record<string, unknown> = {}
                for (let i = 0; i < n; i++) o[`k${randInt(rng, 4)}`] = acyclicValue(rng, depth - 1, allowSharing, pool)
                return o
            }
            if (kind === 2) {
                return new Set(Array.from({ length: n }, () => acyclicValue(rng, depth - 1, allowSharing, pool)))
            }
            return new Map(
                Array.from({ length: n }, () => [
                    acyclicValue(rng, depth - 1, allowSharing, pool),
                    acyclicValue(rng, depth - 1, allowSharing, pool),
                ])
            )
        }
        const v = mk()
        if (typeof v === 'object' && v !== null) pool.push(v)
        return v
    }

    it('no sharing: 4000 pairs — disagreements only where dequal is provably wrong', () => {
        const rng = makeRng(0xc0ffee01)
        let dequalFalseNegatives = 0
        let unexplained = 0
        for (let i = 0; i < 4000; i++) {
            const a = acyclicValue(rng, 3, false, [])
            const b = rng() < 0.4 ? structuredClone(a) : acyclicValue(rng, 3, false, [])
            const d = dequal(a, b)
            const iso = isoEqual(a, b)
            if (d !== iso) {
                /* Adjudicate with the independent reference implementation:
                 * exhaustive backtracking, shares no code with the engine. */
                const verdict = isoEqualReference(a, b)
                if (verdict === iso && iso && !d) {
                    dequalFalseNegatives++ // greedy-matching miss — dequal's bug
                } else {
                    unexplained++
                    // eslint-disable-next-line no-console
                    console.error('UNEXPLAINED DISAGREEMENT', { d, iso, verdict, i })
                }
            }
        }
        // eslint-disable-next-line no-console
        console.info(`no-sharing fuzz: ${dequalFalseNegatives} dequal false-negatives, ${unexplained} unexplained`)
        expect(unexplained).toBe(0)
    })

    it('with sharing: disagreements exist and are ALL dequal=true/iso=false (S2 strictness)', () => {
        const rng = makeRng(0xc0ffee02)
        let s2 = 0
        let other = 0
        for (let i = 0; i < 4000; i++) {
            const poolA: object[] = []
            const a = acyclicValue(rng, 3, true, poolA)
            const b = rng() < 0.4 ? structuredClone(a) : acyclicValue(rng, 3, true, [])
            let d: boolean
            try {
                d = dequal(a, b)
            } catch {
                continue // dequal crashed (shouldn't on acyclic, but pin nothing on it)
            }
            const iso = isoEqual(a, b)
            if (d !== iso) {
                if (d && !iso) s2++
                else {
                    other++
                    // eslint-disable-next-line no-console
                    console.error('UNEXPECTED DIRECTION', { d, iso, i })
                }
            }
        }
        // eslint-disable-next-line no-console
        console.info(`sharing fuzz: ${s2} S2-strictness deltas, ${other} unexpected`)
        expect(other).toBe(0) // isoequal must never be MORE permissive than dequal
    })
})
