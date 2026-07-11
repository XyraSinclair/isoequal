/* Differential testing: the readable reference implementation and the
 * optimized engine must agree everywhere on their shared domain. */
import { describe, expect, it } from 'vitest'
import { isoEqual } from './index.js'
import { isoEqualReference } from './reference.js'
import {
    cloneShuffled,
    isoBruteForce,
    makeRng,
    randInt,
    randomGraph,
    randomGraphM,
    ring,
} from './testKit.js'

describe('reference: agrees with the optimized engine', () => {
    it('classic cases', () => {
        const x = {}
        for (const [a, b] of [
            [[x, x], [{}, {}]],
            [[x, x], [x, x]],
            [new Set([1, 2, 3]), new Set([3, 1, 2])],
            [new Set([[1, 2], [1, 2], [3, 4]]), new Set([[1, 2], [3, 4], [3, 4]])],
            [new Set([0]), new Set([-0])],
            [new Map([[{ k: 1 }, 'a'], [{ k: 2 }, 'b']]), new Map([[{ k: 2 }, 'b'], [{ k: 1 }, 'a']])],
            [new Set(ring(6)), new Set([...ring(3), ...ring(3)])],
        ] as [unknown, unknown][]) {
            expect(isoEqualReference(a, b)).toBe(isoEqual(a, b))
        }
    })
    it('rings: shuffled C6 equal, C3+C3 vs C6 unequal, swap-through-identical-set', () => {
        const c6 = new Set(ring(6))
        expect(isoEqualReference(c6, cloneShuffled(c6, makeRng(7)))).toBe(true)
        expect(isoEqualReference(new Set([...ring(3), ...ring(3)]), new Set(ring(6)))).toBe(false)
        const x = {}
        const y = {}
        const S = new Set([x, y])
        expect(isoEqualReference([x, S], [y, S])).toBe(true) // needs non-identity φ through S
        expect(isoEqualReference([x, S], [{}, S])).toBe(false)
    })
    it('1500 set-heavy fuzz cases: reference ≡ engine ≡ brute-force oracle', () => {
        const rng = makeRng(0x5eed1e55)
        for (let iter = 0; iter < 1500; iter++) {
            const g = randomGraph(rng, 3 + randInt(rng, 4))
            const clone = cloneShuffled(g, rng)
            expect(isoEqualReference(g, clone)).toBe(true)
            const other = randomGraph(rng, 3 + randInt(rng, 4))
            const expected = isoBruteForce(g, other)
            expect(isoEqual(g, other)).toBe(expected)
            expect(isoEqualReference(g, other)).toBe(expected)
        }
    })
    it('1500 Map-inclusive fuzz cases', () => {
        const rng = makeRng(0xcafe0123)
        for (let iter = 0; iter < 1500; iter++) {
            const g = randomGraphM(rng, 3 + randInt(rng, 4))
            expect(isoEqualReference(g, cloneShuffled(g, rng))).toBe(true)
            const other = randomGraphM(rng, 3 + randInt(rng, 4))
            expect(isoEqualReference(g, other)).toBe(isoEqual(g, other))
        }
    })
})
