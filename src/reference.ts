/* isoequal/reference — the whole idea in ~120 lines.
 *
 * This is the READABLE implementation of the same semantics as the main
 * engine: sharing-sensitive isomorphism over cyclic structures with
 * unordered collections. Where the main engine uses color refinement and an
 * individualization search, this one uses the honest primitive underneath
 * them all: ONE partial bijection φ between the two object graphs, extended
 * by guessing, checked by recursion, and retracted on failure via a trail.
 * Exponential on adversarially symmetric collections; identical verdicts.
 *
 * It exists to be read, to be believed, and to serve as the differential
 * oracle for every optimized version (see reference.test.ts).
 *
 * Scope: the semantic core — primitives (SameValue; SameValueZero inside
 * Set/Map keys), plain objects (own enumerable string keys), arrays, Sets,
 * Maps, Dates, RegExps, the unordered-collection protocol, cycles, sharing.
 * The exotic leaf types the main engine also covers (typed arrays, buffers,
 * boxed primitives, errors, forged-brand hostiles) are deliberately out of
 * scope here: they are the easy part, and this file optimizes for one thing
 * only — fitting the hard part in your head.
 */

const UNORDERED = Symbol.for('unordered-collection')

const isObj = (v: unknown): v is object => v !== null && typeof v === 'object'

/** SameValueZero: how JS collections themselves compare keys/members. */
const svz = (x: unknown, y: unknown): boolean => Object.is(x, y) || (x === 0 && y === 0)

export function isoEqualReference(A: unknown, B: unknown): boolean {
    const phi = new Map<object, object>() // the partial bijection, A-side → B-side
    const psi = new Map<object, object>() // its inverse (φ must be injective)
    const trail: object[] = [] // A-side keys of speculative entries, for retraction

    const mark = () => trail.length
    const retract = (m: number): void => {
        while (trail.length > m) {
            const a = trail.pop()!
            psi.delete(phi.get(a)!)
            phi.delete(a)
        }
    }

    /** Match two element multisets under SOME pairing: guess, check, retract. */
    function unordered(
        as: unknown[],
        bs: unknown[],
        cmp: (x: unknown, y: unknown) => boolean
    ): boolean {
        if (as.length !== bs.length) return false
        const used = new Array<boolean>(bs.length).fill(false)
        const match = (i: number): boolean => {
            if (i === as.length) return true
            for (let j = 0; j < bs.length; j++) {
                if (used[j]) continue
                const m = mark()
                if (cmp(as[i], bs[j])) {
                    used[j] = true
                    if (match(i + 1)) return true
                    used[j] = false
                }
                retract(m) // undo this guess's φ extensions before the next
            }
            return false
        }
        return match(0)
    }

    /* Element comparators. Primitives inside Set members / Map keys use the
     * collections' own SameValueZero; the UNORDERED protocol uses SameValue
     * (a custom collection, unlike a Set, can hold both 0 and -0). */
    const eqMember = (x: unknown, y: unknown): boolean => (isObj(x) ? eq(x, y) : svz(x, y))
    const eqValue = (x: unknown, y: unknown): boolean => (isObj(x) ? eq(x, y) : Object.is(x, y))
    const eqEntry = (x: unknown, y: unknown): boolean => {
        const [xk, xv] = x as [unknown, unknown]
        const [yk, yv] = y as [unknown, unknown]
        return eqMember(xk, yk) && eq(xv, yv)
    }

    function eq(a: unknown, b: unknown): boolean {
        if (!isObj(a)) {
            if (typeof a === 'function') return a === b
            return Object.is(a, b)
        }
        if (!isObj(b)) return false

        /* The bijection discipline — the entire cyclic/sharing story:
         * a revisited node must map to what it mapped to before (consistency),
         * and no two A-nodes may share an image (injectivity). Registering
         * BEFORE recursing is what makes cycles terminate. There is no
         * early-out on a === b: sharing is significant, and even an identical
         * collection on both sides may need a non-identity mapping through it. */
        const seen = phi.get(a)
        if (seen !== undefined) return seen === b
        if (psi.has(b)) return false
        if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
        phi.set(a, b)
        psi.set(b, a)
        trail.push(a)

        if ((a as Record<symbol, unknown>)[UNORDERED] === true) {
            return unordered([...(a as Iterable<unknown>)], [...(b as Iterable<unknown>)], eqValue)
        }
        if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime())
        if (a instanceof RegExp) {
            return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags
        }
        if (a instanceof WeakMap || a instanceof WeakSet || a instanceof Promise) return a === b
        if (Array.isArray(a)) {
            const bArr = b as readonly unknown[]
            if (a.length !== bArr.length) return false
            for (let i = 0; i < a.length; i++) {
                if (!eq(a[i], bArr[i])) return false
            }
            return true
        }
        if (a instanceof Set) return unordered([...a], [...(b as Set<unknown>)], eqMember)
        if (a instanceof Map) return unordered([...a], [...(b as Map<unknown, unknown>)], eqEntry)

        const aKeys = Object.keys(a)
        const bKeys = Object.keys(b)
        if (aKeys.length !== bKeys.length) return false
        for (const k of aKeys) {
            if (!Object.prototype.propertyIsEnumerable.call(b, k)) return false
            if (!eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
                return false
        }
        return true
    }

    return eq(A, B)
}
