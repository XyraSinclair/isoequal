/* Tier 1 of isoequal (DESIGN.md §4): the synchronized pair-walk over
 * the DETERMINISTIC region — everything reachable through ordered edges — plus
 * Tier 1.5 residue filtering for deferred unordered collections.
 *
 * Semantics: sharing-sensitive isomorphism (S2). Key consequences encoded here:
 *  - Inner `a === b` pairs are still traversed and registered: skipping them is
 *    UNSOUND under S2 (x=[], s=[x]: [s,x] vs [s,clone(x)] must be false; the
 *    skip would say true). Only the top-level identity fast-path (in index.ts)
 *    is sound — there the identity bijection witnesses isomorphism.
 *  - Every object (including leaf-ish Dates etc.) is registered in the seen
 *    maps so sharing differences are caught: [d,d] vs [d1,d2] is false.
 *  - Functions, WeakMaps, WeakSets, WeakRefs and Promises compare by IDENTITY
 *    (their contents are unobservable or, for functions, not value-comparable);
 *    identity equality makes their sharing structure trivially consistent, so
 *    functions skip seen-registration entirely.
 *  - Type dispatch is on PROTOTYPE identity plus internal-slot brand probes
 *    (see intrinsics.ts) — never on `.constructor` or shadowable methods.
 *
 * v1 scope (later strokes per design §9: descriptors, prototypes-as-values,
 * cross-realm, multisets, the S1 engine): own enumerable string-keyed props
 * (+ opt-in symbol props), arrays exactly (index slots, holes ≠ undefined,
 * opt-in custom props — dense arrays pay nothing for either check), Set/Map
 * (incl. custom own props)/Date/RegExp/ArrayBuffer/DataView/TypedArrays/boxed
 * primitives/Errors (name+message+props)/class instances (proto identity +
 * props).
 */

import {
    compareArrayBuffers,
    compareDataViews,
    compareTypedArrays,
    FAKE,
    isIdentityOnly,
    isRealMap,
    isRealSet,
    MAP_ENTRIES,
    MAP_GET,
    MAP_HAS,
    MAP_KEYS,
    mapGetOf,
    mapHasIn,
    mapIter,
    mapKeysIter,
    mapSizeOf,
    probeArrayBufferLen,
    probeBoxedValue,
    probeDataViewLen,
    probeDateTime,
    probeRegExpSource,
    regExpFlagsEqual,
    SET_HAS,
    SET_VALUES,
    setHasIn,
    setIter,
    setSizeOf,
} from './intrinsics.js'

/** Well-known registered symbol: any ITERABLE object carrying
 * `[UNORDERED]: true` (own or inherited — declare it once on a class
 * prototype) compares as the MULTISET of its iterated values, under full S2
 * semantics: primitives by SameValue, objects structurally with sharing and
 * multiplicity significant, cycles included. Entries-style collections
 * (multimaps) need nothing extra — their iterators yield [k, v] pairs, which
 * are simply values. Own props are NOT part of a declared collection's
 * identity (its contents are); iteration must be repeatable (real
 * collections are — a one-shot generator is a contract violation). */
export const UNORDERED: unique symbol = Symbol.for('unordered-collection') as never

export interface IsoEqualOpts {
    /** Compare Set elements / Map entries in iteration order (no speculation, pure Tier 1). */
    areMapsSetsOrdered: boolean
    /** Detector for unordered collections from libraries that won't carry the
     * UNORDERED symbol. Consulted for every object pair when provided — the
     * symbol is the zero-cost path (~2ns negative lookup), this is the
     * universal one. */
    isUnorderedCollection: ((o: object) => boolean) | undefined
    /** Require object string keys in the same enumeration order. */
    areObjectKeysOrdered: boolean
    /** Also compare custom (non-index) own props on Arrays (regex-match style).
     * OFF by default: detecting them requires Object.keys() on every array —
     * an O(n) string allocation that would 16× the flat-array hot path (node
     * only avoids it via a V8-internal binding userland lacks). Holes vs
     * undefined are ALWAYS exact — that detection is free. */
    checkArrayOwnProps: boolean
    /** Also compare own enumerable SYMBOL-keyed props (matched by symbol
     * identity — the module-constant-symbol pattern; distinct same-description
     * symbols do not match). OFF by default: getOwnPropertySymbols costs
     * ~27ns/object (+~25% on POJO-heavy paths) even when no symbols exist. */
    checkSymbolProps: boolean
    /** Cap on Tier-2/3 speculative work units. Exhaustion THROWS IsoEqualBudgetError
     * rather than answering wrong — honest about the GI cliff (design §7). */
    maxSpeculativeOps: number
}

export const ISOEQUAL_DEFAULTS: IsoEqualOpts = {
    areMapsSetsOrdered: false,
    areObjectKeysOrdered: false,
    checkArrayOwnProps: false,
    checkSymbolProps: false,
    isUnorderedCollection: undefined,
    maxSpeculativeOps: Infinity,
}

export class IsoEqualBudgetError extends Error {
    constructor() {
        super(
            'isoequal: maxSpeculativeOps exhausted while matching unordered collections ' +
                '(the input is in the rare symmetric regime — raise the budget or restructure)'
        )
        this.name = 'IsoEqualBudgetError'
    }
}

export const enum CollKind {
    SET,
    MAP,
    CUSTOM, // UNORDERED-declared iterable: multiset of iterated values
}

/** A deferred unordered collection pair awaiting residue resolution. */
export interface PendingColl {
    kind: CollKind
    a: object
    b: object
    /** CUSTOM only: iteration snapshots taken at defer time. */
    snapA: unknown[] | null
    snapB: unknown[] | null
    /** Unmatched object elements (values / Map keys); CUSTOM may hold DUPLICATES
     * (multiset multiplicity); null = not yet initialized. */
    freeA: object[] | null
    freeB: object[] | null
    resolved: boolean
}

export interface Ctx {
    opts: IsoEqualOpts
    stackA: unknown[]
    stackB: unknown[]
    /** First-visit indices: the accumulated partial bijection (design §4 Tier 1). */
    seenA: Map<object, number>
    seenB: Map<object, number>
    /** Inverse views, maintained incrementally: index → object. */
    objsA: object[]
    objsB: object[]
    pending: PendingColl[]
    /** Whether any Set/Map pair was compared — gates the optimistic-ordered retry. */
    sawColl: boolean
}

export function createCtx(opts: IsoEqualOpts): Ctx {
    return {
        opts,
        stackA: [],
        stackB: [],
        seenA: new Map(),
        seenB: new Map(),
        objsA: [],
        objsB: [],
        pending: [],
        sawColl: false,
    }
}

/** Drop all per-comparison state (kept allocations, released references). */
export function resetCtx(ctx: Ctx): void {
    ctx.stackA.length = 0
    ctx.stackB.length = 0
    ctx.seenA.clear()
    ctx.seenB.clear()
    ctx.objsA.length = 0
    ctx.objsB.length = 0
    ctx.pending.length = 0
    ctx.sawColl = false
}

export const pushPair = (ctx: Ctx, a: unknown, b: unknown): void => {
    ctx.stackA.push(a)
    ctx.stackB.push(b)
}

/** Compare a child position: primitives (and functions) settle INLINE — the
 * common case never touches the stack; only object pairs are deferred. */
const compareChild = (a: unknown, b: unknown, ctx: Ctx): boolean => {
    if (a === null || b === null) return a === b
    const t = typeof a
    if (t !== typeof b) return false
    if (t === 'function') return a === b
    if (t !== 'object') return Object.is(a, b)
    ctx.stackA.push(a)
    ctx.stackB.push(b)
    return true
}

/* -------------------------------------------------------------------------- */
/*                                 the walk                                   */
/* -------------------------------------------------------------------------- */

const propIsEnum = Object.prototype.propertyIsEnumerable
const getSymbols = Object.getOwnPropertySymbols
const hasOwn = Object.hasOwn

/* Cleanliness probes: a collection whose relevant methods RESOLVE to the
 * intrinsics (no own-prop shadow — hasOwn; no subclass-prototype override —
 * identity check on the resolved method, which hasOwn cannot see) can be
 * driven through the direct (V8-fast-pathed) loops; anything else falls back
 * to the intrinsic-backed loops. A few ns per collection buys back the ~4×
 * cost of manual-iterator traversal. */
const isCleanSet = (s: object): boolean =>
    !hasOwn(s, 'size') &&
    (s as Set<unknown>).has === SET_HAS &&
    (s as Set<unknown>)[Symbol.iterator] === SET_VALUES
const isCleanMap = (m: object): boolean =>
    !hasOwn(m, 'size') &&
    (m as Map<unknown, unknown>).has === MAP_HAS &&
    (m as Map<unknown, unknown>).get === MAP_GET &&
    (m as Map<unknown, unknown>).keys === MAP_KEYS &&
    (m as Map<unknown, unknown>)[Symbol.iterator] === MAP_ENTRIES

/** Own enumerable symbol props, matched by symbol IDENTITY. */
function pushSymbolProps(a: object, b: object, ctx: Ctx): boolean {
    const aSyms = getSymbols(a)
    const bSyms = getSymbols(b)
    let aCount = 0
    for (const s of aSyms) {
        if (!propIsEnum.call(a, s)) continue
        aCount++
        if (!propIsEnum.call(b, s)) return false
        if (!compareChild((a as Record<symbol, unknown>)[s], (b as Record<symbol, unknown>)[s], ctx))
            return false
    }
    let bCount = 0
    for (const s of bSyms) {
        if (propIsEnum.call(b, s)) bCount++
    }
    return aCount === bCount
}

function pushPojoProps(a: object, b: object, ctx: Ctx): boolean {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    const len = aKeys.length
    if (len !== bKeys.length) return false
    if (ctx.opts.areObjectKeysOrdered) {
        for (let i = 0; i < len; i++) {
            if (aKeys[i] !== bKeys[i]) return false
        }
    } else {
        // NB: propertyIsEnumerable, not hasOwn — hasOwn would admit a
        // non-enumerable own prop on `b` and silently unbalance the key sets.
        for (let i = 0; i < len; i++) {
            if (!propIsEnum.call(b, aKeys[i])) return false
        }
    }
    for (let i = 0; i < len; i++) {
        const k = aKeys[i]
        if (!compareChild((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], ctx))
            return false
    }
    return !ctx.opts.checkSymbolProps || pushSymbolProps(a, b, ctx)
}

/** Array index keys are excluded when comparing an array's custom props. */
export const isIndexKey = (k: string, len: number): boolean => {
    const n = +k
    return n >>> 0 === n && n < len && String(n) === k
}

/** Compare custom (non-index) own enumerable string props of two arrays. */
function compareArrayExtras(a: readonly unknown[], b: readonly unknown[], ctx: Ctx): boolean {
    const len = a.length
    const aExtra = Object.keys(a).filter((k) => !isIndexKey(k, len))
    const bExtra = Object.keys(b).filter((k) => !isIndexKey(k, len))
    if (aExtra.length !== bExtra.length) return false
    for (const k of aExtra) {
        if (!propIsEnum.call(b, k)) return false
        if (
            !compareChild(
                (a as unknown as Record<string, unknown>)[k],
                (b as unknown as Record<string, unknown>)[k],
                ctx
            )
        )
            return false
    }
    return true
}

function pushArraySlots(a: readonly unknown[], b: readonly unknown[], ctx: Ctx): boolean {
    const len = a.length // real arrays: length is an unshadowable own data prop
    if (len !== b.length) return false
    for (let i = 0; i < len; i++) {
        const av = a[i]
        const bv = b[i]
        /* Holes read as undefined, so only undefined-valued slots can hide a
         * hole/undefined mismatch — dense data never pays the `in` checks. */
        if (av === undefined && bv === undefined) {
            if (i in a !== i in b) return false
            continue
        }
        if (!compareChild(av, bv, ctx)) return false
    }
    /* Custom props (regex-match arrays etc.): opt-in — see IsoEqualOpts. */
    return !ctx.opts.checkArrayOwnProps || compareArrayExtras(a, b, ctx)
}

/** Both sides brand-verified real Sets. */
function compareSetPair(a: object, b: object, ctx: Ctx): boolean {
    ctx.sawColl = true
    if (setSizeOf(a) !== setSizeOf(b)) return false
    /* Own enumerable string props on the Set object itself (elements are not
     * props, so this is exactly the custom props — usually none, cheap). */
    if (!pushPojoProps(a, b, ctx)) return false
    if (ctx.opts.areMapsSetsOrdered) {
        if (isCleanSet(a) && isCleanSet(b)) {
            // iterate via the CHECKED Symbol.iterator, never unchecked .values()
            const bIt = (b as Set<unknown>)[Symbol.iterator]()
            for (const av of a as Set<unknown>) {
                if (!compareChild(av, bIt.next().value, ctx)) return false
            }
            return true
        }
        const bIt = setIter(b)
        for (const av of setIter(a)) {
            if (!compareChild(av, bIt.next().value, ctx)) return false
        }
        return true
    }
    ctx.pending.push({
        kind: CollKind.SET,
        a,
        b,
        snapA: null,
        snapB: null,
        freeA: null,
        freeB: null,
        resolved: false,
    })
    return true
}

/** Both sides brand-verified real Maps. */
function compareMapPair(a: object, b: object, ctx: Ctx): boolean {
    ctx.sawColl = true
    if (mapSizeOf(a) !== mapSizeOf(b)) return false
    if (!pushPojoProps(a, b, ctx)) return false // custom props (entries are not props)
    if (ctx.opts.areMapsSetsOrdered) {
        if (isCleanMap(a) && isCleanMap(b)) {
            // iterate via the CHECKED Symbol.iterator, never unchecked .entries()
            const bIt = (b as Map<unknown, unknown>)[Symbol.iterator]()
            for (const [ak, av] of a as Map<unknown, unknown>) {
                const [bk, bv] = bIt.next().value as [unknown, unknown]
                if (!compareChild(ak, bk, ctx)) return false
                if (!compareChild(av, bv, ctx)) return false
            }
            return true
        }
        const bIt = mapIter(b)
        for (const [ak, av] of mapIter(a)) {
            const [bk, bv] = bIt.next().value as [unknown, unknown]
            if (!compareChild(ak, bk, ctx)) return false
            if (!compareChild(av, bv, ctx)) return false
        }
        return true
    }
    ctx.pending.push({
        kind: CollKind.MAP,
        a,
        b,
        snapA: null,
        snapB: null,
        freeA: null,
        freeB: null,
        resolved: false,
    })
    return true
}

/** UNORDERED-declared iterable: identity = multiset of iterated values. */
function compareCustomUnordered(a: object, b: object, ctx: Ctx): boolean {
    ctx.sawColl = true
    if (
        typeof (a as Partial<Iterable<unknown>>)[Symbol.iterator] !== 'function' ||
        typeof (b as Partial<Iterable<unknown>>)[Symbol.iterator] !== 'function'
    ) {
        throw new TypeError(
            'isoequal: an object declared unordered (unordered-collection symbol / isUnorderedCollection) must be iterable'
        )
    }
    const snapA = [...(a as Iterable<unknown>)]
    const snapB = [...(b as Iterable<unknown>)]
    if (snapA.length !== snapB.length) return false
    if (ctx.opts.areMapsSetsOrdered) {
        for (let i = 0; i < snapA.length; i++) {
            if (!compareChild(snapA[i], snapB[i], ctx)) return false
        }
        return true
    }
    ctx.pending.push({
        kind: CollKind.CUSTOM,
        a,
        b,
        snapA,
        snapB,
        freeA: null,
        freeB: null,
        resolved: false,
    })
    return true
}

/** Declared unordered — via the well-known symbol (inherited lookups welcome;
 * ~2ns negative read) or the user detector. */
export const isUnorderedDecl = (o: object, opts: IsoEqualOpts): boolean =>
    (o as Record<symbol, unknown>)[UNORDERED] === true ||
    (opts.isUnorderedCollection !== undefined && opts.isUnorderedCollection(o))

/* Branded comparators: distinguish real instances (internal slot present)
 * from prototype-only fakes; fake twins compare as POJOs, and a real/fake
 * pair is never equal. */
function brandedSet(a: object, b: object, ctx: Ctx): boolean {
    const ra = isRealSet(a)
    if (ra !== isRealSet(b)) return false
    return ra ? compareSetPair(a, b, ctx) : pushPojoProps(a, b, ctx)
}
function brandedMap(a: object, b: object, ctx: Ctx): boolean {
    const ra = isRealMap(a)
    if (ra !== isRealMap(b)) return false
    return ra ? compareMapPair(a, b, ctx) : pushPojoProps(a, b, ctx)
}
function brandedDate(a: object, b: object, ctx: Ctx): boolean {
    const va = probeDateTime(a)
    const vb = probeDateTime(b)
    if (va === FAKE || vb === FAKE) return va === vb && pushPojoProps(a, b, ctx)
    return Object.is(va, vb)
}
function brandedBoxed(a: object, b: object, ctx: Ctx): boolean {
    const va = probeBoxedValue(a)
    const vb = probeBoxedValue(b)
    if (va === FAKE || vb === FAKE) return va === vb && pushPojoProps(a, b, ctx)
    return Object.is(va, vb)
}
function brandedRegExp(a: object, b: object, ctx: Ctx): boolean {
    const sa = probeRegExpSource(a)
    const sb = probeRegExpSource(b)
    if (sa === FAKE || sb === FAKE) return sa === sb && pushPojoProps(a, b, ctx)
    return sa === sb && regExpFlagsEqual(a, b)
}
function brandedArrayBuffer(a: object, b: object, ctx: Ctx): boolean {
    const ra = probeArrayBufferLen(a) !== FAKE
    if (ra !== (probeArrayBufferLen(b) !== FAKE)) return false
    return ra ? compareArrayBuffers(a as ArrayBuffer, b as ArrayBuffer) : pushPojoProps(a, b, ctx)
}
function brandedDataView(a: object, b: object, ctx: Ctx): boolean {
    const ra = probeDataViewLen(a) !== FAKE
    if (ra !== (probeDataViewLen(b) !== FAKE)) return false
    return ra ? compareDataViews(a, b) : pushPojoProps(a, b, ctx)
}
function compareErrorPair(a: Error, b: Error, ctx: Ctx): boolean {
    // name/message reads may hit proto data props — fine, values compare equal
    return a.name === b.name && a.message === b.message && pushPojoProps(a, b, ctx)
}

const getProto = Object.getPrototypeOf
const OBJ_PROTO = Object.prototype
const ARR_PROTO = Array.prototype
const SET_PROTO = Set.prototype
const MAP_PROTO = Map.prototype
const DATE_PROTO = Date.prototype
const RE_PROTO = RegExp.prototype
const ERR_PROTO = Error.prototype
const AB_PROTO = ArrayBuffer.prototype
const DV_PROTO = DataView.prototype
const NUM_PROTO = Number.prototype
const STR_PROTO = String.prototype
const BOOL_PROTO = Boolean.prototype
const BI_PROTO = BigInt.prototype
const SYM_PROTO = Symbol.prototype

/** Compare one OBJECT pair (compareChild settles everything else inline),
 * pushing child pairs / deferring collections. Dispatch is on PROTOTYPE
 * identity (unforgeable) + brand probes, never on `.constructor` (an ordinary
 * shadowable prop — adversarial review showed the ctor-switch version could
 * be steered into the wrong comparator by `{constructor: Array}` etc.). */
function comparePair(aObj: object, bObj: object, ctx: Ctx): boolean {
    /* Cycle / sharing registration. The index-equality check enforces that the
     * accumulated partial map is a bijection consistent with first-visit order
     * — this alone makes [a1,a2,a1] vs [b1,b1,b2] come out false. */
    const iA = ctx.seenA.get(aObj)
    if (iA !== ctx.seenB.get(bObj)) return false
    if (iA !== undefined) return true // already matched as a pair
    const idx = ctx.objsA.length
    ctx.seenA.set(aObj, idx)
    ctx.seenB.set(bObj, idx)
    ctx.objsA.push(aObj)
    ctx.objsB.push(bObj)

    const aProto = getProto(aObj) as object | null
    if (aProto !== getProto(bObj)) return false

    /* Universal unordered-declaration check: 2 symbol reads per pair (~4ns —
     * V8 caches the negative lookup), so ANY iterable anywhere can opt in. */
    const declared = isUnorderedDecl(aObj, ctx.opts)
    if (declared !== isUnorderedDecl(bObj, ctx.opts)) return false
    if (declared) return compareCustomUnordered(aObj, bObj, ctx)

    if (aProto === OBJ_PROTO || aProto === null) return pushPojoProps(aObj, bObj, ctx)
    if (aProto === ARR_PROTO) {
        const ra = Array.isArray(aObj) // internal-slot reliable
        if (ra !== Array.isArray(bObj)) return false
        return ra
            ? pushArraySlots(aObj as unknown[], bObj as unknown[], ctx)
            : pushPojoProps(aObj, bObj, ctx)
    }
    if (aProto === SET_PROTO) return brandedSet(aObj, bObj, ctx)
    if (aProto === MAP_PROTO) return brandedMap(aObj, bObj, ctx)
    if (aProto === DATE_PROTO) return brandedDate(aObj, bObj, ctx)
    if (aProto === RE_PROTO) return brandedRegExp(aObj, bObj, ctx)
    if (aProto === ERR_PROTO) return compareErrorPair(aObj as Error, bObj as Error, ctx)
    if (aProto === AB_PROTO) return brandedArrayBuffer(aObj, bObj, ctx)
    if (aProto === DV_PROTO) return brandedDataView(aObj, bObj, ctx)
    if (
        aProto === NUM_PROTO ||
        aProto === STR_PROTO ||
        aProto === BOOL_PROTO ||
        aProto === BI_PROTO ||
        aProto === SYM_PROTO
    )
        return brandedBoxed(aObj, bObj, ctx)

    // custom prototypes: typed arrays, subclassed builtins, class instances
    const aView = ArrayBuffer.isView(aObj)
    if (aView !== ArrayBuffer.isView(bObj)) return false
    if (aView) {
        return aObj instanceof DataView
            ? compareDataViews(aObj, bObj)
            : compareTypedArrays(aObj, bObj)
    }
    const ra = Array.isArray(aObj)
    if (ra !== Array.isArray(bObj)) return false
    if (ra) return pushArraySlots(aObj as unknown[], bObj as unknown[], ctx)
    if (aObj instanceof Set) return brandedSet(aObj, bObj, ctx)
    if (aObj instanceof Map) return brandedMap(aObj, bObj, ctx)
    if (aObj instanceof Date) return brandedDate(aObj, bObj, ctx)
    if (aObj instanceof RegExp) return brandedRegExp(aObj, bObj, ctx)
    if (aObj instanceof ArrayBuffer) return brandedArrayBuffer(aObj, bObj, ctx)
    if (aObj instanceof Number || aObj instanceof String || aObj instanceof Boolean)
        return brandedBoxed(aObj, bObj, ctx)
    if (isIdentityOnly(aObj)) return aObj === bObj
    if (aObj instanceof Error) return compareErrorPair(aObj, bObj as Error, ctx)
    // class instances: proto identity established above (stronger than ctor)
    return pushPojoProps(aObj, bObj, ctx)
}

/** Drain the walk stack. False = definitively not equal. */
export function runWalk(ctx: Ctx): boolean {
    const { stackA, stackB } = ctx
    while (stackA.length > 0) {
        const b = stackB.pop() as object
        const a = stackA.pop() as object
        if (!comparePair(a, b, ctx)) return false
    }
    return true
}

/* -------------------------------------------------------------------------- */
/*                      Tier 1.5 — residue filtering                          */
/* -------------------------------------------------------------------------- */

export const enum Filter {
    FAIL,
    NO_PROGRESS,
    PROGRESS,
}

/** Objects that participate in speculative matching. Functions and identity-only
 * objects are excluded: their identity semantics make collection membership
 * checkable directly via `has` (which is exactly identity for them). */
const isMatchableObject = (v: unknown): v is object =>
    v !== null && typeof v === 'object' && !isIdentityOnly(v as object)

/** SameValue-exact Map key: JS Maps collapse -0 into +0, so counting under
 * SameValue needs a sentinel for -0 (NaN already works: Maps match NaN). */
const NEG_ZERO = Symbol('isoequal.-0')
export const svKey = (v: unknown): unknown =>
    typeof v === 'number' && v === 0 && 1 / v === -Infinity ? NEG_ZERO : v

/** First pass over a deferred pair: match primitives (and identity-semantic
 * values) by membership, split out object elements. Set membership uses the
 * collections' own SameValueZero semantics; CUSTOM collections count
 * primitives under SameValue with multiplicity (design §6). */
function initColl(p: PendingColl, ctx: Ctx): boolean {
    const freeA: object[] = []
    const freeB: object[] = []
    let constA = 0
    let constB = 0
    if (p.kind === CollKind.CUSTOM) {
        const counts = new Map<unknown, number>()
        for (const v of p.snapA!) {
            if (isMatchableObject(v)) {
                freeA.push(v)
            } else {
                const k = svKey(v)
                counts.set(k, (counts.get(k) ?? 0) + 1)
            }
        }
        for (const v of p.snapB!) {
            if (isMatchableObject(v)) {
                freeB.push(v)
            } else {
                const k = svKey(v)
                const c = counts.get(k)
                if (!c) return false
                counts.set(k, c - 1)
            }
        }
        /* sizes matched ⇒ equal object counts ⇔ all primitive counts hit zero */
        if (freeA.length !== freeB.length) return false
        p.freeA = freeA
        p.freeB = freeB
        return true
    }
    if (p.kind === CollKind.MAP) {
        const b = p.b as object
        const clean = isCleanMap(p.a as object) && isCleanMap(b)
        // duplicated loops: the clean branch keeps V8's for-of-Map fast path
        for (const [k, v] of clean ? (p.a as Map<unknown, unknown>) : mapIter(p.a as object)) {
            if (isMatchableObject(k)) {
                freeA.push(k)
            } else {
                if (!(clean ? (b as Map<unknown, unknown>).has(k) : mapHasIn(b, k))) return false
                const bv = clean ? (b as Map<unknown, unknown>).get(k) : mapGetOf(b, k)
                if (!compareChild(v, bv, ctx)) return false // forced pair
                constA++
            }
        }
        if (freeA.length === 0) {
            /* |A| = |B| and every A key found in B ⇒ identical key sets. */
            p.freeA = freeA
            p.freeB = freeB
            return true
        }
        for (const k of clean ? (b as Map<unknown, unknown>).keys() : mapKeysIter(b)) {
            if (isMatchableObject(k)) freeB.push(k)
            else constB++
        }
    } else {
        const bObj = p.b as object
        if (isCleanSet(p.a as object) && isCleanSet(bObj)) {
            // hot path: primitive-heavy sets, direct membership probes
            const b = bObj as Set<unknown>
            for (const v of p.a as Set<unknown>) {
                if (isMatchableObject(v)) {
                    freeA.push(v)
                } else {
                    if (!b.has(v)) return false
                    constA++
                }
            }
            if (freeA.length === 0) {
                /* All-primitive fast path: |A| = |B| and A ⊆ B ⇒ A = B. */
                p.freeA = freeA
                p.freeB = freeB
                return true
            }
            for (const v of b) {
                if (isMatchableObject(v)) freeB.push(v)
                else constB++
            }
        } else {
            for (const v of setIter(p.a as object)) {
                if (isMatchableObject(v)) {
                    freeA.push(v)
                } else {
                    if (!setHasIn(bObj, v)) return false
                    constA++
                }
            }
            if (freeA.length === 0) {
                p.freeA = freeA
                p.freeB = freeB
                return true
            }
            for (const v of setIter(bObj)) {
                if (isMatchableObject(v)) freeB.push(v)
                else constB++
            }
        }
    }
    if (constA !== constB) return false // sizes matched ⇒ object counts now match too
    p.freeA = freeA
    p.freeB = freeB
    return true
}

/** Remove elements already forced by the deterministic bijection (anchors):
 * an anchored element's partner (via the inverse seen view) must be present on
 * the other side — once per OCCURRENCE (CUSTOM multisets may repeat elements,
 * so removal is count-based). Map anchored keys additionally force their
 * value pairs. */
function filterAnchored(p: PendingColl, ctx: Ctx): Filter {
    const freeA = p.freeA!
    const { seenA, seenB, objsB } = ctx
    let freeBCounts: Map<object, number> | null = null
    let w = 0
    for (let i = 0; i < freeA.length; i++) {
        const el = freeA[i]
        const idx = seenA.get(el)
        if (idx === undefined) {
            freeA[w++] = el
            continue
        }
        const partner = objsB[idx]
        if (freeBCounts === null) {
            freeBCounts = new Map()
            for (const e of p.freeB!) freeBCounts.set(e, (freeBCounts.get(e) ?? 0) + 1)
        }
        const c = freeBCounts.get(partner)
        if (!c) return Filter.FAIL
        freeBCounts.set(partner, c - 1)
        if (
            p.kind === CollKind.MAP &&
            !compareChild(mapGetOf(p.a, el), mapGetOf(p.b, partner), ctx)
        )
            return Filter.FAIL
    }
    const removed = w < freeA.length
    freeA.length = w
    if (freeBCounts) {
        const rest: object[] = []
        for (const [e, c] of freeBCounts) {
            for (let i = 0; i < c; i++) rest.push(e)
        }
        p.freeB = rest
    }
    /* Any anchored element still on the B side has no partner left in A —
     * its forced pre-image is not an element of collA. Definitive failure. */
    for (const el of p.freeB!) {
        if (seenB.has(el)) return Filter.FAIL
    }
    return removed ? Filter.PROGRESS : Filter.NO_PROGRESS
}

export function filterPending(ctx: Ctx): Filter {
    let progress = false
    for (const p of ctx.pending) {
        if (p.resolved) continue
        if (p.freeA === null) {
            if (!initColl(p, ctx)) return Filter.FAIL
            progress = true
        }
        const r = filterAnchored(p, ctx)
        if (r === Filter.FAIL) return Filter.FAIL
        if (r === Filter.PROGRESS) progress = true
        if (p.freeA!.length === 0) p.resolved = true
    }
    return progress ? Filter.PROGRESS : Filter.NO_PROGRESS
}
