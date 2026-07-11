/* 32-bit hashing primitives for isoequal's arena labels and refinement colors.
 *
 * Collisions here are ONE-SIDED-SAFE (DESIGN.md §4): a collision can
 * only merge color classes, i.e. coarsen the partition, which weakens pruning
 * but can never manufacture the imbalance we reject on — and acceptance is
 * only ever granted by an exactly-verified bijection. So we take fast 32-bit
 * mixing with no escape hatch.
 */

/** Avalanching 32-bit mix of an accumulator with a new lane (murmur3-style finalizer). */
export const mix = (h: number, x: number): number => {
    let v = Math.imul((h ^ x) | 0, 0x9e3779b1)
    v ^= v >>> 15
    v = Math.imul(v, 0x85ebca77)
    return (v ^ (v >>> 13)) | 0
}

/** FNV-1a over UTF-16 code units. */
export const hashString = (s: string): number => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
    }
    return h | 0
}

const F64 = new Float64Array(1)
const U32 = new Uint32Array(F64.buffer)

const NAN_HASH = 0x7ff8beef | 0

/** SameValue-consistent number hash (bit-exact; -0 hashes differently from 0).
 * NaN is special-cased: engines may not canonicalize NaN bit patterns on
 * Float64Array stores, and all JS NaNs are SameValue-equal. */
export const hashNumber = (x: number): number => {
    // eslint-disable-next-line no-self-compare
    if (x !== x) return NAN_HASH
    F64[0] = x
    return mix(U32[0] | 0, U32[1] | 0)
}

/* Disjoint tag constants (arbitrary distinct 32-bit values, mixed so related
 * structures can't cancel). Sorted here for collision-freedom at a glance. */
export const enum Tag {
    ANCHOR = 0x51f15e01,
    ARRAY = 0x51f15e02,
    BIGINT = 0x51f15e03,
    BOOL_FALSE = 0x51f15e04,
    BOOL_TRUE = 0x51f15e05,
    COLL = 0x51f15e06,
    ENTRY = 0x51f15e07,
    ENTRY_KEY = 0x51f15e08,
    ENTRY_VAL = 0x51f15e09,
    HOLE = 0x51f15e16,
    IDENTITY = 0x51f15e0a,
    LEAF = 0x51f15e0b,
    MAP = 0x51f15e0c,
    MAP_CONST_ENTRY = 0x51f15e0d,
    NULL = 0x51f15e0e,
    NUMBER = 0x51f15e0f,
    POJO = 0x51f15e10,
    PRIM_CHILD = 0x51f15e11,
    SET = 0x51f15e12,
    SET_MEMBER = 0x51f15e13,
    STRING = 0x51f15e14,
    UNDEFINED = 0x51f15e15,
    UNORD = 0x51f15e17,
}
