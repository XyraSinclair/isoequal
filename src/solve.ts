/* Tiers 2 + 3 of isoequal (DESIGN.md §4): color refinement with balance
 * rejection, individualization–refinement search, and the exact verification
 * pass that alone can answer `true`.
 *
 * Soundness architecture:
 *  - REJECTION happens only on color-class imbalance. Colors are isomorphism
 *    invariants (labels + refinement preserve them), so imbalance ⇒ not
 *    isomorphic. Hash collisions can only coarsen classes, and coarsening a
 *    balanced partition keeps it balanced ⇒ collisions never fake a rejection.
 *  - ACCEPTANCE happens only in verify(), which re-checks the discrete
 *    bijection exactly (labels, edges, membership) with no hashing involved.
 *  - Refinement keys pair (oldColor, neighborhoodHash), so classes only ever
 *    split — palette size strictly grows or the loop stops. With each
 *    individualization also growing the palette, the search terminates
 *    unconditionally, collisions or not.
 */

import { Arena, buildArena, Kind } from './arena.js'
import { mix } from './hashes.js'
import {
    compareLeafExact,
    isIdentityOnly,
    mapGetOf,
    mapHasIn,
    mapIter,
    mapSizeOf,
    setHasIn,
    setIter,
    setSizeOf,
} from './intrinsics.js'
import { Ctx, IsoEqualBudgetError, isIndexKey, PendingColl, svKey } from './tier1.js'

interface Budget {
    left: number
}

const spend = (budget: Budget, n: number): void => {
    budget.left -= n
    if (budget.left < 0) throw new IsoEqualBudgetError()
}

/** Every color class must have equally many A-side and B-side members. */
function isBalanced(arena: Arena, colors: Int32Array, palette: number): boolean {
    const deltas = new Int32Array(palette)
    const { side } = arena
    for (let i = 0; i < colors.length; i++) {
        deltas[colors[i]] += side[i] === 0 ? 1 : -1
    }
    for (let c = 0; c < palette; c++) {
        if (deltas[c] !== 0) return false
    }
    return true
}

interface Stable {
    colors: Int32Array
    palette: number
}

/** Iterate refinement to a stable balanced partition; null = imbalance found. */
function refineToStable(
    arena: Arena,
    colors: Int32Array,
    palette: number,
    budget: Budget
): Stable | null {
    const n = colors.length
    const { edgeStart, edgeSlot, edgeTarget } = arena
    while (true) {
        if (!isBalanced(arena, colors, palette)) return null
        spend(budget, n)
        /* Key = (oldColor, neighborhood hash). Packing into a float is exact
         * while palette < 2^21 (key < 2^53); beyond that, string keys. */
        const useNumKeys = palette < 0x200000
        const keyIds = new Map<number | string, number>()
        const next = new Int32Array(n)
        let nextPalette = 0
        for (let v = 0; v < n; v++) {
            let sum = 0
            for (let e = edgeStart[v]; e < edgeStart[v + 1]; e++) {
                sum = (sum + mix(edgeSlot[e], colors[edgeTarget[e]])) | 0
            }
            const key = useNumKeys
                ? colors[v] * 0x100000000 + (sum >>> 0)
                : `${colors[v]}:${sum}`
            let id = keyIds.get(key)
            if (id === undefined) {
                id = nextPalette++
                keyIds.set(key, id)
            }
            next[v] = id
        }
        if (nextPalette === palette) return { colors, palette } // no split ⇒ stable
        colors = next
        palette = nextPalette
    }
}

/** Individualization–refinement (design §4 Tier 3), two upgrades from the
 * adversarial review (R5: recursion depth = class size ⇒ quadratic time and a
 * raw RangeError at ~20k-element symmetric sets):
 *
 *  1. GREEDY-FIRST: at every stable partition, pair class members arbitrarily
 *     (encounter order) and run the EXACT verifier. Symmetric-but-equal inputs
 *     (the common pathological case: a set of m interchangeable elements)
 *     accept in O(n + m) with zero branching. Sound — acceptance still only
 *     ever comes from verify; complete — greedy failure just falls through to
 *     the branching search.
 *  2. EXPLICIT-STACK search — no recursion, so class size can never overflow
 *     the call stack; budget is charged per branch so finite budgets trip the
 *     typed error first.
 *
 * Completeness: any true isomorphism φ preserves colors, so at each branch
 * point φ(a0) is among the tried candidates; the surviving branch reaches a
 * discrete partition whose bijection verify() accepts. Exponential only on
 * WL-symmetric UNEQUAL-or-unlucky residue. */
function search(
    arena: Arena,
    colors0: Int32Array,
    palette0: number,
    budget: Budget,
    ctx: Ctx
): boolean {
    interface Frame {
        colors: Int32Array
        palette: number
        a0: number
        bCands: number[]
        next: number
    }
    const frames: Frame[] = []

    /** Process a stable balanced partition: true = accepted (verified);
     * false = either a dead discrete leaf, or a frame was pushed to branch. */
    const enter = (colors: Int32Array, palette: number): boolean => {
        if (verify(arena, colors, palette, ctx)) return true // greedy pairing, exact check
        if (palette === arena.nA) return false // discrete and failed: dead leaf

        // pick the smallest non-singleton class (fewest branches first)
        const aCounts = new Int32Array(palette)
        for (let i = 0; i < colors.length; i++) {
            if (arena.side[i] === 0) aCounts[colors[i]]++
        }
        let target = -1
        for (let c = 0; c < palette; c++) {
            if (aCounts[c] > 1 && (target === -1 || aCounts[c] < aCounts[target])) target = c
        }
        let a0 = -1
        const bCands: number[] = []
        for (let i = 0; i < colors.length; i++) {
            if (colors[i] !== target) continue
            if (arena.side[i] === 0) {
                if (a0 === -1) a0 = i // fixing one A-side node loses nothing
            } else bCands.push(i)
        }
        frames.push({ colors, palette, a0, bCands, next: 0 })
        return false
    }

    if (enter(colors0, palette0)) return true
    while (frames.length > 0) {
        const f = frames[frames.length - 1]
        if (f.next >= f.bCands.length) {
            frames.pop() // exhausted: backtrack
            continue
        }
        spend(budget, f.colors.length)
        const b = f.bCands[f.next++]
        const child = f.colors.slice()
        child[f.a0] = f.palette
        child[b] = f.palette
        const st = refineToStable(arena, child, f.palette + 1, budget)
        if (st !== null && enter(st.colors, st.palette)) return true
    }
    return false
}

/* -------------------------------------------------------------------------- */
/*                            exact verification                              */
/* -------------------------------------------------------------------------- */

interface VerifyCtx {
    arena: Arena
    ctx: Ctx
    phi: Int32Array // A-node id → B-node id
}

/** Exact reference comparison under the candidate bijection: primitives by
 * SameValue, functions/identity-only by identity, anchored objects by seen
 * index, free objects through φ.
 * NB (review note): ENTRY keys also route through here with SameValue, while
 * labels hash map keys SVZ — divergent only for a -0 key, which real Maps
 * cannot contain (Map.set normalizes -0 to +0, and we iterate [[MapData]]
 * via intrinsics), so the strictness is unreachable rather than wrong. */
function refEq(v: VerifyCtx, x: unknown, y: unknown): boolean {
    if (x === null || typeof x !== 'object') {
        if (typeof x === 'function') return x === y
        return Object.is(x, y)
    }
    if (y === null || typeof y !== 'object') return false
    const iA = v.ctx.seenA.get(x)
    if (iA !== undefined) return v.ctx.seenB.get(y) === iA
    if (v.ctx.seenB.has(y)) return false
    const xa = v.arena.idsA.get(x)
    if (xa !== undefined) {
        const yb = v.arena.idsB.get(y)
        return yb !== undefined && v.phi[xa] === yb
    }
    return x === y // identity-only leaves
}

/** Map an A-side member/key to the B-side object it must equal, or MISS. */
const MISS = Symbol('miss')
function imageOf(v: VerifyCtx, m: unknown): unknown {
    if (m === null || typeof m !== 'object' || isIdentityOnly(m as object)) return m
    const iA = v.ctx.seenA.get(m as object)
    if (iA !== undefined) return v.ctx.objsB[iA]
    const xa = v.arena.idsA.get(m as object)
    if (xa === undefined) return MISS
    const yb = v.phi[xa]
    return yb === -1 ? MISS : v.arena.obj[yb]
}

const propIsEnum = Object.prototype.propertyIsEnumerable

/** Exact own-prop comparison under φ (minus array index keys when arrayLen ≥ 0). */
function verifyOwnProps(v: VerifyCtx, x: object, y: object, arrayLen = -1): boolean {
    let xKeys = Object.keys(x)
    let yKeys = Object.keys(y)
    if (arrayLen >= 0) {
        xKeys = xKeys.filter((k) => !isIndexKey(k, arrayLen))
        yKeys = yKeys.filter((k) => !isIndexKey(k, arrayLen))
    }
    if (xKeys.length !== yKeys.length) return false
    for (const k of xKeys) {
        if (!propIsEnum.call(y, k)) return false
        if (!refEq(v, (x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]))
            return false
    }
    if (v.ctx.opts.checkSymbolProps) {
        let xCount = 0
        for (const s of Object.getOwnPropertySymbols(x)) {
            if (!propIsEnum.call(x, s)) continue
            xCount++
            if (!propIsEnum.call(y, s)) return false
            if (!refEq(v, (x as Record<symbol, unknown>)[s], (y as Record<symbol, unknown>)[s]))
                return false
        }
        let yCount = 0
        for (const s of Object.getOwnPropertySymbols(y)) {
            if (propIsEnum.call(y, s)) yCount++
        }
        if (xCount !== yCount) return false
    }
    return true
}

function verifyNode(v: VerifyCtx, u: number, w: number): boolean {
    const { arena } = v
    const kind = arena.kind[u]
    if (kind !== arena.kind[w]) return false

    if (kind === Kind.COLL) {
        if (arena.obj[u] !== arena.obj[w]) return false // same pair index
        const uStart = arena.edgeStart[u]
        const uEnd = arena.edgeStart[u + 1]
        if (uEnd - uStart !== arena.edgeStart[w + 1] - arena.edgeStart[w]) return false
        /* MULTISET comparison: CUSTOM collections may hold the same element
         * with multiplicity > 1, so count φ-images rather than set them. */
        const mapped = new Map<number, number>()
        for (let e = uStart; e < uEnd; e++) {
            const t = v.phi[arena.edgeTarget[e]]
            mapped.set(t, (mapped.get(t) ?? 0) + 1)
        }
        for (let e = arena.edgeStart[w]; e < arena.edgeStart[w + 1]; e++) {
            const t = arena.edgeTarget[e]
            const c = mapped.get(t)
            if (!c) return false
            mapped.set(t, c - 1)
        }
        return true
    }
    if (kind === Kind.ENTRY) {
        return refEq(v, arena.obj[u], arena.obj[w]) && refEq(v, arena.entryVal[u], arena.entryVal[w])
    }

    const x = arena.obj[u] as object
    const y = arena.obj[w] as object
    // prototype identity (unforgeable), never `.constructor`
    if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false

    switch (kind) {
        case Kind.LEAF:
            return compareLeafExact(x, y) === true
        case Kind.ARRAY: {
            const ax = x as readonly unknown[]
            const ay = y as readonly unknown[]
            if (ax.length !== ay.length) return false
            for (let i = 0; i < ax.length; i++) {
                const av = ax[i]
                const bv = ay[i]
                if (av === undefined && bv === undefined) {
                    if (i in ax !== i in ay) return false // hole ≠ undefined slot
                    continue
                }
                if (!refEq(v, av, bv)) return false
            }
            return !v.ctx.opts.checkArrayOwnProps || verifyOwnProps(v, x, y, ax.length)
        }
        case Kind.SET: {
            if (setSizeOf(x) !== setSizeOf(y)) return false
            for (const m of setIter(x)) {
                const im = imageOf(v, m)
                if (im === MISS || !setHasIn(y, im)) return false
            }
            return verifyOwnProps(v, x, y) // sizes equal + injective images ⇒ bijection
        }
        case Kind.MAP: {
            if (mapSizeOf(x) !== mapSizeOf(y)) return false
            for (const [k, val] of mapIter(x)) {
                const ik = imageOf(v, k)
                if (ik === MISS || !mapHasIn(y, ik)) return false
                if (!refEq(v, val, mapGetOf(y, ik))) return false
            }
            return verifyOwnProps(v, x, y)
        }
        case Kind.UNORD: {
            /* Declared collection: exact multiset comparison of iterated
             * values under φ — primitives SameValue (svKey), objects by the
             * identity of their required image. Own props excluded. */
            const snapX = [...(x as Iterable<unknown>)]
            const snapY = [...(y as Iterable<unknown>)]
            if (snapX.length !== snapY.length) return false
            const counts = new Map<unknown, number>()
            for (const m of snapX) {
                const im = imageOf(v, m)
                if (im === MISS) return false
                const k = svKey(im)
                counts.set(k, (counts.get(k) ?? 0) + 1)
            }
            for (const m of snapY) {
                const k = svKey(m)
                const c = counts.get(k)
                if (!c) return false
                counts.set(k, c - 1)
            }
            return true
        }
        default: {
            // POJO / class instance / Error
            if (x instanceof Error) {
                if (x.name !== (y as Error).name || x.message !== (y as Error).message) return false
            }
            return verifyOwnProps(v, x, y)
        }
    }
}

/** Candidate bijection from a balanced partition: pair each class's A and B
 * members in encounter order. For a discrete partition this is THE bijection;
 * for a coarser one it is the greedy attempt (search() falls back to
 * individualization if the exact check rejects it). */
function buildGreedyPhi(arena: Arena, colors: Int32Array, palette: number): Int32Array {
    const aByColor: number[][] = Array.from({ length: palette }, () => [])
    for (let i = 0; i < colors.length; i++) {
        if (arena.side[i] === 0) aByColor[colors[i]].push(i)
    }
    const taken = new Int32Array(palette)
    const phi = new Int32Array(arena.kind.length).fill(-1)
    for (let i = 0; i < colors.length; i++) {
        if (arena.side[i] === 1) {
            const c = colors[i]
            phi[aByColor[c][taken[c]++]] = i
        }
    }
    return phi
}

/** Balanced partition → greedy candidate bijection → exact check of every pair. */
function verify(arena: Arena, colors: Int32Array, palette: number, ctx: Ctx): boolean {
    const phi = buildGreedyPhi(arena, colors, palette)
    const v: VerifyCtx = { arena, ctx, phi }
    for (let u = 0; u < phi.length; u++) {
        if (arena.side[u] === 0 && !verifyNode(v, u, phi[u])) return false
    }
    return true
}

/* -------------------------------------------------------------------------- */

/** Entry point: decide the residue (design §4 Tiers 2–3). */
export function solveResidue(ctx: Ctx, residue: PendingColl[]): boolean {
    const arena = buildArena(ctx, residue)
    const budget: Budget = { left: ctx.opts.maxSpeculativeOps }

    // initial colors from labels
    const n = arena.label.length
    const colors = new Int32Array(n)
    const ids = new Map<number, number>()
    let palette = 0
    for (let i = 0; i < n; i++) {
        const l = arena.label[i]
        let id = ids.get(l)
        if (id === undefined) {
            id = palette++
            ids.set(l, id)
        }
        colors[i] = id
    }

    const st = refineToStable(arena, colors, palette, budget)
    if (st === null) return false
    return search(arena, st.colors, st.palette, budget, ctx)
}
