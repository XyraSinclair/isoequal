/* isoequal — deep equality for arbitrary JS values, including CYCLIC
 * structures and UNORDERED collections (Sets, Maps, and anything declaring
 * the unordered-collection protocol), under sharing-sensitive isomorphism
 * semantics. Design, proofs and prior-art: ../DESIGN.md.
 *
 * The short version: values are rooted labeled digraphs; unordered-collection
 * equality is graph isomorphism (GI-complete in general). isoequal solves the
 * ordered/cyclic region exactly in linear time, shrinks unordered collections
 * against primitives and already-forced matches, and resolves the rare
 * speculative residue by color refinement + individualization search with
 * exact verification. Never wrong; fast everywhere real.
 *
 * Semantics highlights:
 *  - Sharing matters: isoEqual([a,a], [b,a2]) is false even when all leaves
 *    match — the reachable-object counts differ.
 *  - NaN equals NaN; -0 differs from 0 in ordered positions (SameValue), but
 *    Set membership / Map keys use the collections' own SameValueZero.
 *  - Functions, WeakMaps/WeakSets, Promises compare by identity.
 *  - Any iterable carrying Symbol.for('unordered-collection') compares as the
 *    MULTISET of its iterated values.
 */

import { solveResidue } from './solve.js'
import {
    createCtx,
    Ctx,
    ISOEQUAL_DEFAULTS,
    IsoEqualOpts,
    Filter,
    filterPending,
    pushPair,
    resetCtx,
    runWalk,
} from './tier1.js'

export { IsoEqualBudgetError, UNORDERED } from './tier1.js'
export type { IsoEqualOpts } from './tier1.js'

export function createIsoEqual(customOpts: Partial<IsoEqualOpts> = {}) {
    const opts: IsoEqualOpts = { ...ISOEQUAL_DEFAULTS, ...customOpts }
    /* Optimistic phase-1 options: treat Sets/Maps as ordered. An ordered match
     * is a sound WITNESS for the unordered semantics (the identity permutation
     * satisfies every collection constraint), and real-world equal collections
     * overwhelmingly share insertion order (clones, dedups, rebuilds). Only an
     * ordered MISMATCH escalates to the full unordered machinery. */
    const orderedOpts: IsoEqualOpts = { ...opts, areMapsSetsOrdered: true }

    /* Per-instance context pool: the maps/arrays survive across calls (a large
     * win for hot-path callers). Reentrant calls (a getter invoking isoEqual
     * mid-walk) fall back to a fresh context. */
    let pooled: Ctx | null = null
    let pooledBusy = false

    function run(ctx: Ctx, A: object, B: object): boolean {
        pushPair(ctx, A, B)
        /* Fixpoint: drain the deterministic walk, then filter deferred
         * collections (which can force new deterministic pairs), repeat. */
        while (true) {
            if (!runWalk(ctx)) return false
            const r = filterPending(ctx)
            if (r === Filter.FAIL) return false
            if (r !== Filter.PROGRESS && ctx.stackA.length === 0) break
        }
        if (ctx.pending.length === 0) return true // hot path: nothing was deferred
        const residue = ctx.pending.filter((p) => !p.resolved)
        if (residue.length === 0) return true
        return solveResidue(ctx, residue)
    }

    function decide(ctx: Ctx, A: object, B: object): boolean {
        if (opts.areMapsSetsOrdered) {
            ctx.opts = opts
            return run(ctx, A, B)
        }
        ctx.opts = orderedOpts
        if (run(ctx, A, B)) return true
        if (!ctx.sawColl) return false // no collections ⇒ the ordered verdict is final
        resetCtx(ctx)
        ctx.opts = opts
        return run(ctx, A, B)
    }

    return function isoEqual(A: unknown, B: unknown): boolean {
        /* Top-level identity is sound (the identity bijection is an
         * isomorphism). INNER identity is not skippable — see tier1.ts. */
        if (Object.is(A, B)) return true
        if (A === null || B === null) return false
        const t = typeof A
        if (t !== typeof B) return false
        if (t !== 'object') return false // non-identical primitives / functions

        if (pooledBusy) return decide(createCtx(opts), A as object, B as object)
        pooledBusy = true
        const ctx = (pooled ??= createCtx(opts))
        try {
            return decide(ctx, A as object, B as object)
        } finally {
            resetCtx(ctx)
            pooledBusy = false
        }
    }
}

/** Default instance: unordered Sets/Maps, unordered object keys, no budget cap. */
export const isoEqual = createIsoEqual()

/** Maximum-coverage instance: also compares array custom props and
 * symbol-keyed props (identity-matched). Costs ~25–30% on POJO/array-heavy
 * paths — see the option docs on IsoEqualOpts. */
export const isoEqualStrict = createIsoEqual({
    checkArrayOwnProps: true,
    checkSymbolProps: true,
})
