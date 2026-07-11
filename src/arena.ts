/* Tier 2 arena for isoequal (DESIGN.md §4): the residue of unordered
 * collections is compiled into one flat graph over BOTH sides — typed-array
 * adjacency, 32-bit labels — on which refinement and the IR search run.
 *
 * Node inventory:
 *  - COLL   virtual node per deferred collection pair (label carries the pair
 *           index, so collA must correspond to collB — the per-collection
 *           constraint becomes plain graph structure).
 *  - ENTRY  virtual node per Map entry with any speculative part
 *           (ordered key/value edges; design §1 models Maps this way).
 *  - POJO / ARRAY / SET / MAP: real objects in the free region.
 *  - LEAF   value-comparable leaf objects (Date, RegExp, TypedArray, buffers,
 *           boxed primitives). They are NODES, not label folds, because leaf
 *           SHARING is significant under S2: [d,d] vs [d1,d2] must differ.
 *
 * Everything with identity semantics (functions, WeakMap/WeakSet/Promise,
 * symbols) folds into labels as an identity-registry id: same object ⇒ same
 * fold on both sides; different objects ⇒ different folds ⇒ imbalance ⇒ false.
 * Exactly the right semantics, for free.
 *
 * Anchored children (objects already matched by Tier 1) fold as their seen
 * index — they arrive pre-individualized, which is the big head start real
 * data has over bare-graph GI instances.
 */

import { hashNumber, hashString, mix, Tag } from './hashes.js'
import {
    dataViewByte,
    FAKE,
    isDetachedArrayBuffer,
    isIdentityOnly,
    isLeafValue,
    isRealMap,
    isRealSet,
    mapGetOf,
    mapIter,
    mapSizeOf,
    probeArrayBufferLen,
    probeBoxedValue,
    probeDataViewLen,
    probeDateTime,
    probeRegExpSource,
    regExpFlagsKey,
    setIter,
    setSizeOf,
    typedArrayLength,
} from './intrinsics.js'
import { CollKind, Ctx, isIndexKey, isUnorderedDecl, PendingColl } from './tier1.js'

export const enum Kind {
    COLL,
    ENTRY,
    POJO,
    ARRAY,
    SET,
    MAP,
    LEAF,
    UNORD, // UNORDERED-declared iterable: multiset of iterated values
}

export interface Arena {
    kind: number[]
    side: number[] // 0 = A, 1 = B
    label: number[]
    obj: unknown[] // backing object; for ENTRY: the key; for COLL: the pair index
    entryVal: unknown[] // ENTRY only: the value
    edgeStart: Int32Array // CSR offsets, length n+1
    edgeSlot: Int32Array
    edgeTarget: Int32Array
    nA: number
    nB: number
    idsA: Map<object, number>
    idsB: Map<object, number>
}

/** Brand-safe classification: never trusts `.constructor` or bare instanceof
 * (prototype-only fakes classify as POJO, matching Tier-1 dispatch).
 * UNORDERED declaration wins first, mirroring Tier-1 dispatch order. */
const classify = (b: Builder, o: object): Kind => {
    if (isUnorderedDecl(o, b.ctx.opts)) return Kind.UNORD
    if (Array.isArray(o)) return Kind.ARRAY
    if (o instanceof Set) return isRealSet(o) ? Kind.SET : Kind.POJO
    if (o instanceof Map) return isRealMap(o) ? Kind.MAP : Kind.POJO
    return isLeafValue(o) ? Kind.LEAF : Kind.POJO
}

interface Builder {
    ctx: Ctx
    kind: number[]
    side: number[]
    base: number[]
    sum: number[]
    obj: unknown[]
    entryVal: unknown[]
    edges: number[][] // per node: flat [slot, target, ...]
    idsA: Map<object, number>
    idsB: Map<object, number>
    identityIds: Map<unknown, number>
    queue: number[] // real-object nodes awaiting structural processing
    curSide: number
}

const idOf = (b: Builder, v: unknown): number => {
    let id = b.identityIds.get(v)
    if (id === undefined) {
        id = b.identityIds.size
        b.identityIds.set(v, id)
    }
    return id
}

/** SameValue-consistent primitive hash; `svz` collapses -0 into 0 for
 * Set-membership / Map-key position (the collections' own semantics, §6). */
const primHash = (b: Builder, v: unknown, svz: boolean): number => {
    switch (typeof v) {
        case 'number':
            return mix(Tag.NUMBER, hashNumber(svz && v === 0 ? 0 : v))
        case 'string':
            return mix(Tag.STRING, hashString(v))
        case 'boolean':
            return v ? Tag.BOOL_TRUE : Tag.BOOL_FALSE
        case 'undefined':
            return Tag.UNDEFINED
        case 'bigint':
            return mix(Tag.BIGINT, hashString(String(v)))
        default:
            // null, symbols, functions, identity-only objects
            if (v === null) return Tag.NULL
            return mix(Tag.IDENTITY, idOf(b, v))
    }
}

const newNode = (b: Builder, kind: Kind, baseLabel: number, obj: unknown, entryVal?: unknown): number => {
    const id = b.kind.length
    b.kind.push(kind)
    b.side.push(b.curSide)
    b.base.push(baseLabel)
    b.sum.push(0)
    b.obj.push(obj)
    b.entryVal.push(entryVal)
    b.edges.push([])
    return id
}

const foldConst = (b: Builder, id: number, slot: number, h: number): void => {
    b.sum[id] = (b.sum[id] + mix(slot, h)) | 0
}

const addEdge = (b: Builder, id: number, slot: number, target: number): void => {
    b.edges[id].push(slot, target)
}

/** Free-region object → arena node id (creating + enqueueing on first visit). */
const nodeFor = (b: Builder, o: object): number => {
    const ids = b.curSide === 0 ? b.idsA : b.idsB
    let id = ids.get(o)
    if (id !== undefined) return id
    id = newNode(b, classify(b, o), 0, o)
    ids.set(o, id)
    b.queue.push(id)
    return id
}

/** Route one child value: primitive/identity → label fold, anchored → anchor
 * fold, free object → edge. The single place the fold-vs-edge decision lives. */
const childRef = (b: Builder, id: number, slot: number, v: unknown, svz: boolean): void => {
    if (v === null || typeof v !== 'object' || isIdentityOnly(v as object)) {
        foldConst(b, id, slot, mix(Tag.PRIM_CHILD, primHash(b, v, svz)))
        return
    }
    const seen = b.curSide === 0 ? b.ctx.seenA : b.ctx.seenB
    const anchor = seen.get(v as object)
    if (anchor !== undefined) {
        foldConst(b, id, slot, mix(Tag.ANCHOR, anchor))
        return
    }
    addEdge(b, id, slot, nodeFor(b, v as object))
}

/* Content hashing via internal-slot probes only — a shadowed own getTime/
 * valueOf/length can neither crash the build nor forge the label. */
const leafContentHash = (b: Builder, o: object): number => {
    if (ArrayBuffer.isView(o)) {
        if (o instanceof DataView) {
            const len = probeDataViewLen(o) as number
            let h = mix(Tag.LEAF, len)
            for (let i = 0; i < len; i++) h = mix(h, dataViewByte(o, i))
            return h
        }
        const ta = o as unknown as { [i: number]: number | bigint }
        const len = typedArrayLength(o)
        let h = mix(Tag.LEAF, len)
        for (let i = 0; i < len; i++) h = mix(h, hashNumber(Number(ta[i])))
        return h
    }
    const t = probeDateTime(o)
    if (t !== FAKE) return hashNumber(t as number)
    const src = probeRegExpSource(o)
    if (src !== FAKE) return hashString(`${src as string} ${regExpFlagsKey(o)}`)
    if (probeArrayBufferLen(o) !== FAKE) {
        if (isDetachedArrayBuffer(o)) return mix(Tag.LEAF, Tag.HOLE) // no content
        return bytesHash(new Uint8Array(o as ArrayBuffer))
    }
    // boxed primitive (classify guaranteed a leaf; probes are exhaustive)
    return primHash(b, probeBoxedValue(o), false)
}

const bytesHash = (bytes: Uint8Array): number => {
    let h = mix(Tag.LEAF, bytes.length)
    for (let i = 0; i < bytes.length; i++) h = mix(h, bytes[i])
    return h
}

/** Type identity for labels: prototype (unforgeable), not `.constructor`. */
const protoId = (b: Builder, o: object): number => idOf(b, Object.getPrototypeOf(o))

const propIsEnum = Object.prototype.propertyIsEnumerable

/** Fold own enumerable string (and, opt-in, symbol) props into a node's
 * label/edges; also mixes the prop count into the base label. */
const foldOwnProps = (b: Builder, id: number, o: object, arrayLen = -1): void => {
    const keys = Object.keys(o)
    let count = 0
    for (const k of keys) {
        if (arrayLen >= 0 && isIndexKey(k, arrayLen)) continue
        count++
        childRef(b, id, mix(Tag.POJO, hashString(k)), (o as Record<string, unknown>)[k], false)
    }
    if (b.ctx.opts.checkSymbolProps) {
        for (const s of Object.getOwnPropertySymbols(o)) {
            if (!propIsEnum.call(o, s)) continue
            count++
            /* Slot = identity-registry id: the same symbol object yields the
             * same slot on both sides; distinct symbols can never match. */
            childRef(b, id, mix(Tag.IDENTITY, idOf(b, s)), (o as Record<symbol, unknown>)[s], false)
        }
    }
    b.base[id] = mix(b.base[id], count)
}

/** Fill label base + folds + edges for one real-object node. */
const processNode = (b: Builder, id: number): void => {
    const o = b.obj[id] as object
    switch (b.kind[id]) {
        case Kind.SET: {
            b.base[id] = mix(Tag.SET, mix(protoId(b, o), setSizeOf(o)))
            for (const v of setIter(o)) childRef(b, id, Tag.SET_MEMBER, v, true)
            foldOwnProps(b, id, o) // elements are not props ⇒ exactly the custom props
            break
        }
        case Kind.UNORD: {
            /* Declared collection: identity = multiset of iterated values
             * (primitives SameValue, so svz=false); own props excluded. */
            const snap = [...(o as Iterable<unknown>)]
            b.base[id] = mix(Tag.UNORD, mix(protoId(b, o), snap.length))
            for (const v of snap) childRef(b, id, Tag.SET_MEMBER, v, false)
            break
        }
        case Kind.MAP: {
            b.base[id] = mix(Tag.MAP, mix(protoId(b, o), mapSizeOf(o)))
            for (const [k, v] of mapIter(o)) {
                const kFree = isFreeObject(b, k)
                const vFree = isFreeObject(b, v)
                if (!kFree && !vFree) {
                    // fully-constant entry: fold key and value as one unit
                    foldConst(
                        b,
                        id,
                        Tag.MAP_CONST_ENTRY,
                        mix(constHash(b, k, true), constHash(b, v, false))
                    )
                } else {
                    const e = newNode(b, Kind.ENTRY, Tag.ENTRY, k, v)
                    addEdge(b, id, Tag.MAP, e)
                    childRef(b, e, Tag.ENTRY_KEY, k, true)
                    childRef(b, e, Tag.ENTRY_VAL, v, false)
                }
            }
            foldOwnProps(b, id, o)
            break
        }
        case Kind.ARRAY: {
            const arr = o as readonly unknown[]
            b.base[id] = mix(Tag.ARRAY, arr.length)
            for (let i = 0; i < arr.length; i++) {
                const v = arr[i]
                if (v === undefined && !(i in arr)) {
                    foldConst(b, id, mix(Tag.ARRAY, i), Tag.HOLE) // hole ≠ undefined slot
                    continue
                }
                childRef(b, id, mix(Tag.ARRAY, i), v, false)
            }
            if (b.ctx.opts.checkArrayOwnProps) foldOwnProps(b, id, o, arr.length)
            break
        }
        case Kind.LEAF:
            b.base[id] = mix(Tag.LEAF, mix(protoId(b, o), leafContentHash(b, o)))
            break
        default: {
            // POJO / class instance / Error
            let base = mix(Tag.POJO, protoId(b, o))
            if (o instanceof Error) base = mix(base, mix(hashString(o.name), hashString(o.message)))
            b.base[id] = base
            foldOwnProps(b, id, o)
        }
    }
}

const isFreeObject = (b: Builder, v: unknown): boolean => {
    if (v === null || typeof v !== 'object' || isIdentityOnly(v as object)) return false
    const seen = b.curSide === 0 ? b.ctx.seenA : b.ctx.seenB
    return !seen.has(v as object)
}

const constHash = (b: Builder, v: unknown, svz: boolean): number => {
    if (v === null || typeof v !== 'object' || isIdentityOnly(v as object)) {
        return mix(Tag.PRIM_CHILD, primHash(b, v, svz))
    }
    const seen = b.curSide === 0 ? b.ctx.seenA : b.ctx.seenB
    return mix(Tag.ANCHOR, seen.get(v as object)!)
}

export function buildArena(ctx: Ctx, residue: PendingColl[]): Arena {
    const b: Builder = {
        ctx,
        kind: [],
        side: [],
        base: [],
        sum: [],
        obj: [],
        entryVal: [],
        edges: [],
        idsA: new Map(),
        idsB: new Map(),
        identityIds: new Map(),
        queue: [],
        curSide: 0,
    }

    for (let side = 0; side < 2; side++) {
        b.curSide = side
        for (let pairIndex = 0; pairIndex < residue.length; pairIndex++) {
            const p = residue[pairIndex]
            const collId = newNode(b, Kind.COLL, mix(Tag.COLL, pairIndex), pairIndex)
            const free = side === 0 ? p.freeA! : p.freeB!
            if (p.kind === CollKind.MAP) {
                const m = (side === 0 ? p.a : p.b) as ReadonlyMap<unknown, unknown>
                for (const k of free) {
                    const v = m.get(k)
                    const e = newNode(b, Kind.ENTRY, Tag.ENTRY, k, v)
                    addEdge(b, collId, Tag.COLL, e)
                    addEdge(b, e, Tag.ENTRY_KEY, nodeFor(b, k)) // residue keys are always free objects
                    childRef(b, e, Tag.ENTRY_VAL, v, false)
                }
            } else {
                for (const el of free) addEdge(b, collId, Tag.COLL, nodeFor(b, el))
            }
            // drain discovery within this side before switching seen maps
            while (b.queue.length > 0) processNode(b, b.queue.pop()!)
        }
        while (b.queue.length > 0) processNode(b, b.queue.pop()!)
    }

    // flatten to CSR + final labels
    const n = b.kind.length
    const label = new Array<number>(n)
    let edgeCount = 0
    for (let i = 0; i < n; i++) {
        label[i] = mix(b.base[i], b.sum[i])
        edgeCount += b.edges[i].length >> 1
    }
    const edgeStart = new Int32Array(n + 1)
    const edgeSlot = new Int32Array(edgeCount)
    const edgeTarget = new Int32Array(edgeCount)
    let w = 0
    for (let i = 0; i < n; i++) {
        edgeStart[i] = w
        const es = b.edges[i]
        for (let j = 0; j < es.length; j += 2) {
            edgeSlot[w] = es[j]
            edgeTarget[w] = es[j + 1]
            w++
        }
    }
    edgeStart[n] = w

    let nA = 0
    for (let i = 0; i < n; i++) if (b.side[i] === 0) nA++

    return {
        kind: b.kind,
        side: b.side,
        label,
        obj: b.obj,
        entryVal: b.entryVal,
        edgeStart,
        edgeSlot,
        edgeTarget,
        nA,
        nB: n - nA,
        idsA: b.idsA,
        idsB: b.idsB,
    }
}
