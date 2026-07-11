/* Cached intrinsics + brand probes for isoequal.
 *
 * THE INVARIANT (hardened after adversarial review, 2026-07-11): every type
 * decision and every content read in isoequal goes through internal-slot-backed
 * operations — Array.isArray, ArrayBuffer.isView, index reads, and the cached
 * PROTOTYPE getters/methods below, which throw unless the internal slot
 * ([[SetData]], [[DateValue]], …) is genuinely present. Own properties
 * (`{constructor: Array}`, a shadowed `set.has`, a lying `Symbol.iterator`,
 * an own `length` on a typed array, `Object.create(Number.prototype)`) can
 * therefore never redirect dispatch, crash a comparator, or forge content —
 * they only ever surface as ordinary own-prop data, compared as such.
 */

export const FAKE = Symbol('isoequal.brand-fail')
type Probe = (this: unknown, ...args: never[]) => unknown
const tryCall = (fn: Probe, x: object): unknown => {
    try {
        return fn.call(x)
    } catch {
        return FAKE
    }
}

const getter = (proto: object, key: string): Probe =>
    Object.getOwnPropertyDescriptor(proto, key)!.get! as Probe

/* ----------------------------- Set / Map ---------------------------------- */

const setSizeGet = getter(Set.prototype, 'size')
const mapSizeGet = getter(Map.prototype, 'size')
const setValuesFn = Set.prototype.values
const setHasFn = Set.prototype.has
const mapEntriesFn = Map.prototype.entries
const mapKeysFn = Map.prototype.keys
const mapHasFn = Map.prototype.has
const mapGetFn = Map.prototype.get

export const isRealSet = (x: object): boolean => tryCall(setSizeGet, x) !== FAKE
export const isRealMap = (x: object): boolean => tryCall(mapSizeGet, x) !== FAKE
/* Raw intrinsic identities, for cleanliness checks (a SUBCLASS override sits
 * on the subclass prototype — invisible to hasOwn — so fast paths must also
 * confirm the RESOLVED method is the intrinsic). */
export const SET_HAS = setHasFn
export const SET_VALUES = setValuesFn // === Set.prototype[Symbol.iterator]
export const MAP_HAS = mapHasFn
export const MAP_GET = mapGetFn
export const MAP_KEYS = mapKeysFn
export const MAP_ENTRIES = mapEntriesFn // === Map.prototype[Symbol.iterator]
export const setSizeOf = (s: object): number => setSizeGet.call(s) as number
export const mapSizeOf = (m: object): number => mapSizeGet.call(m) as number
export const setHasIn = (s: object, v: unknown): boolean => setHasFn.call(s as Set<unknown>, v)
export const mapHasIn = (m: object, k: unknown): boolean =>
    mapHasFn.call(m as Map<unknown, unknown>, k)
export const mapGetOf = (m: object, k: unknown): unknown =>
    mapGetFn.call(m as Map<unknown, unknown>, k)
/* Fresh intrinsic iterators: the iterator objects come straight from the
 * intrinsic, so nothing user-visible sits between us and [[SetData]]. */
export const setIter = (s: object): IterableIterator<unknown> =>
    setValuesFn.call(s as Set<unknown>)
export const mapIter = (m: object): IterableIterator<[unknown, unknown]> =>
    mapEntriesFn.call(m as Map<unknown, unknown>)
export const mapKeysIter = (m: object): IterableIterator<unknown> =>
    mapKeysFn.call(m as Map<unknown, unknown>)

/* ------------------------------ leaf values -------------------------------- */

const dateGetTime = Date.prototype.getTime as Probe
const reSourceGet = getter(RegExp.prototype, 'source')
const abLenGet = getter(ArrayBuffer.prototype, 'byteLength')
const dvLenGet = getter(DataView.prototype, 'byteLength')
const dvGetUint8 = DataView.prototype.getUint8
const taLenGet = getter(Object.getPrototypeOf(Uint8Array.prototype) as object, 'length')
const numValueOf = Number.prototype.valueOf as Probe
const strValueOf = String.prototype.valueOf as Probe
const boolValueOf = Boolean.prototype.valueOf as Probe
const biValueOf = BigInt.prototype.valueOf as Probe
const symValueOf = Symbol.prototype.valueOf as Probe
const BOX_PROBES = [numValueOf, strValueOf, boolValueOf, biValueOf, symValueOf]

/* Per-flag intrinsic getters: RegExp.prototype.flags is spec'd to read
 * `this.global` etc. through ordinary [[Get]] (own-prop forgeable); the
 * individual getters read [[OriginalFlags]] directly. */
const RE_FLAG_GETTERS = ['global', 'ignoreCase', 'multiline', 'dotAll', 'sticky', 'hasIndices']
    .filter((k) => Object.getOwnPropertyDescriptor(RegExp.prototype, k))
    .map((k) => getter(RegExp.prototype, k))
const reUnicodeGet = getter(RegExp.prototype, 'unicode')
const reUnicodeSetsGet = Object.getOwnPropertyDescriptor(RegExp.prototype, 'unicodeSets')
    ? getter(RegExp.prototype, 'unicodeSets')
    : undefined

export const probeDateTime = (o: object): number | typeof FAKE =>
    tryCall(dateGetTime, o) as number | typeof FAKE
export const probeRegExpSource = (o: object): string | typeof FAKE =>
    tryCall(reSourceGet, o) as string | typeof FAKE
export const probeArrayBufferLen = (o: object): number | typeof FAKE =>
    tryCall(abLenGet, o) as number | typeof FAKE
export const probeDataViewLen = (o: object): number | typeof FAKE =>
    tryCall(dvLenGet, o) as number | typeof FAKE
/** Boxed-primitive content via prototype valueOf probes; FAKE if none apply. */
export const probeBoxedValue = (o: object): unknown => {
    for (let i = 0; i < BOX_PROBES.length; i++) {
        const v = tryCall(BOX_PROBES[i], o)
        if (v !== FAKE) return v
    }
    return FAKE
}

/** Slot-backed flag identity for two REAL RegExps. */
export const regExpFlagsEqual = (a: object, b: object): boolean => {
    for (const g of RE_FLAG_GETTERS) {
        if (g.call(a) !== g.call(b)) return false
    }
    if (reUnicodeGet.call(a) !== reUnicodeGet.call(b)) return false
    return reUnicodeSetsGet === undefined || reUnicodeSetsGet.call(a) === reUnicodeSetsGet.call(b)
}
/** Slot-backed flags string for hashing (order-stable). */
export const regExpFlagsKey = (o: object): string => {
    let s = ''
    for (const g of RE_FLAG_GETTERS) s += g.call(o) ? '1' : '0'
    s += reUnicodeGet.call(o) ? '1' : '0'
    if (reUnicodeSetsGet) s += reUnicodeSetsGet.call(o) ? '1' : '0'
    return s
}

export const typedArrayLength = (o: object): number => taLenGet.call(o) as number
export const dataViewByte = (o: object, i: number): number => dvGetUint8.call(o as DataView, i)

/** True for objects whose equality is decided by an internal VALUE slot
 * (Date, RegExp, buffers, typed arrays, boxed primitives) — brand-verified. */
export const isLeafValue = (o: object): boolean =>
    ArrayBuffer.isView(o) ||
    probeDateTime(o) !== FAKE ||
    probeRegExpSource(o) !== FAKE ||
    probeArrayBufferLen(o) !== FAKE ||
    probeBoxedValue(o) !== FAKE

/** Objects whose equality is identity-only: contents unobservable / not
 * value-comparable. (Prototype fakes of these compare by identity too —
 * a deliberate, documented simplification.) */
export const isIdentityOnly = (a: object): boolean =>
    a instanceof WeakMap ||
    a instanceof WeakSet ||
    a instanceof Promise ||
    (typeof WeakRef !== 'undefined' && a instanceof WeakRef)

/* --------------------------- leaf comparators ------------------------------ */

type TypedArrayLike = { [i: number]: number | bigint }

/** Constructors/prototypes already known equal. Floats compare per-element by
 * SameValue (NaN equals NaN; -0 differs from 0); integer lanes by ===. */
export function compareTypedArrays(A: object, B: object): boolean {
    const len = typedArrayLength(A)
    if (len !== typedArrayLength(B)) return false
    const a = A as TypedArrayLike
    const b = B as TypedArrayLike
    if (A instanceof Float64Array || A instanceof Float32Array) {
        for (let i = 0; i < len; i++) {
            if (!Object.is(a[i], b[i])) return false
        }
    } else {
        for (let i = 0; i < len; i++) {
            if (a[i] !== b[i]) return false
        }
    }
    return true
}

const abDetachedGet = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get as
    | Probe
    | undefined
/** Detached buffers have no observable content: detached twins are equal,
 * detached vs live (even zero-length) are not. */
export const isDetachedArrayBuffer = (x: object): boolean =>
    abDetachedGet !== undefined && abDetachedGet.call(x) === true

export function compareArrayBuffers(A: ArrayBuffer, B: ArrayBuffer): boolean {
    const da = isDetachedArrayBuffer(A)
    if (da !== isDetachedArrayBuffer(B)) return false
    if (da) return true
    const la = probeArrayBufferLen(A) as number
    if (la !== probeArrayBufferLen(B)) return false
    /* Zero bytes on both sides ⇒ equal without constructing views. Also the
     * safety net on engines lacking ArrayBuffer.prototype.detached: detached
     * buffers report byteLength 0, and view construction over them throws. */
    if (la === 0) return true
    // the Uint8Array constructor reads [[ArrayBufferData]] directly
    return compareTypedArrays(new Uint8Array(A), new Uint8Array(B))
}

export function compareDataViews(A: object, B: object): boolean {
    const len = probeDataViewLen(A) as number
    if (len !== probeDataViewLen(B)) return false
    for (let i = 0; i < len; i++) {
        if (dataViewByte(A, i) !== dataViewByte(B, i)) return false
    }
    return true
}

/** Exact comparison for brand-verified leaf-valued objects. Returns undefined
 * when `a` is not a leaf kind (callers decide the POJO fallback). */
export function compareLeafExact(a: object, b: object): boolean | undefined {
    if (ArrayBuffer.isView(a)) {
        if (!ArrayBuffer.isView(b)) return false
        if (a instanceof DataView) return b instanceof DataView && compareDataViews(a, b)
        return !(b instanceof DataView) && compareTypedArrays(a, b)
    }
    const ta = probeDateTime(a)
    if (ta !== FAKE) {
        const tb = probeDateTime(b)
        return tb !== FAKE && Object.is(ta, tb)
    }
    const sa = probeRegExpSource(a)
    if (sa !== FAKE) {
        const sb = probeRegExpSource(b)
        return sb !== FAKE && sa === sb && regExpFlagsEqual(a, b)
    }
    if (probeArrayBufferLen(a) !== FAKE) {
        return probeArrayBufferLen(b) !== FAKE && compareArrayBuffers(a as ArrayBuffer, b as ArrayBuffer)
    }
    const va = probeBoxedValue(a)
    if (va !== FAKE) {
        const vb = probeBoxedValue(b)
        return vb !== FAKE && Object.is(va, vb)
    }
    return undefined
}
