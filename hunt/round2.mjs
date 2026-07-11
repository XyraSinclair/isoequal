/* Round 2: (a) deep-eql deep fuzz (it survived signatures), (b) extract the
 * single node:isDeepStrictEqual crash from the acyclic corpus. */
import deepEql from 'deep-eql'
import { inspect } from 'node:util'
import { isDeepStrictEqual } from 'node:util'
import { isoEqual, isoEqualReference } from '../dist/index.js'

let s = 0xdecafbad
const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
}
const ri = (n) => (rnd() * n) | 0
const PRIMS = [0, 1, 'a', 'b', true, null, undefined]
function gen(depth) {
    if (depth <= 0 || rnd() < 0.35) return PRIMS[ri(PRIMS.length)]
    const kind = ri(4)
    const n = 1 + ri(3)
    if (kind === 0) return Array.from({ length: n }, () => gen(depth - 1))
    if (kind === 1) {
        const o = {}
        for (let i = 0; i < n; i++) o[`k${ri(4)}`] = gen(depth - 1)
        return o
    }
    if (kind === 2) return new Set(Array.from({ length: n }, () => gen(depth - 1)))
    return new Map(Array.from({ length: n }, () => [gen(depth - 1), gen(depth - 1)]))
}

/* (b) node crash extraction — same seed as round 1 */
console.log('=== node crash extraction ===')
for (let i = 0; i < 3000; i++) {
    const a = gen(3)
    const b = rnd() < 0.4 ? structuredClone(a) : gen(3)
    try {
        isDeepStrictEqual(a, b)
    } catch (e) {
        console.log(`node CRASHED at i=${i}: ${e.constructor.name}: ${e.message.slice(0, 120)}`)
        console.log('A =', inspect(a, { depth: 6, breakLength: 120 }))
        console.log('B =', inspect(b, { depth: 6, breakLength: 120 }))
        console.log('truth (reference):', isoEqualReference(a, b), '| isoequal:', isoEqual(a, b))
    }
}

/* (a) deep-eql: acyclic differential + cyclic metamorphic */
console.log('\n=== deep-eql acyclic differential (3000) ===')
s = 0xdecafbad
let fn = 0, fp = 0, crash = 0, firstFN = null, firstFP = null
const savedFN = [], savedFP = []
for (let i = 0; i < 3000; i++) {
    const a = gen(3)
    const b = rnd() < 0.4 ? structuredClone(a) : gen(3)
    const truth = isoEqualReference(a, b)
    let got
    try {
        got = deepEql(a, b)
    } catch { crash++; continue }
    if (got !== truth) {
        if (truth) { fn++; if (savedFN.length < 2) savedFN.push([a, b]) }
        else { fp++; if (savedFP.length < 2) savedFP.push([a, b]) }
    }
}
console.log(`deep-eql: falseNeg=${fn} falsePos=${fp} crash=${crash}`)
for (const [a, b] of savedFN) {
    console.log('FN example A =', inspect(a, { depth: 6, breakLength: 120 }))
    console.log('           B =', inspect(b, { depth: 6, breakLength: 120 }))
}
for (const [a, b] of savedFP) {
    console.log('FP example A =', inspect(a, { depth: 6, breakLength: 120 }))
    console.log('           B =', inspect(b, { depth: 6, breakLength: 120 }))
}

console.log('\n=== deep-eql cyclic metamorphic (shuffled clones must be equal) ===')
const ring = (k) => {
    const nodes = Array.from({ length: k }, () => ({}))
    for (let i = 0; i < k; i++) nodes[i].next = nodes[(i + 1) % k]
    return nodes
}
let bad = 0
for (let k = 3; k <= 8; k++) {
    const A = new Set(ring(k))
    const b = ring(k)
    // rotate + swap orders
    for (let rot = 0; rot < k; rot++) {
        const order = Array.from({ length: k }, (_, i) => (i + rot) % k)
        const B = new Set(order.map((i) => b[i]))
        if (!deepEql(A, B)) bad++
    }
}
console.log(`ring rotations wrong: ${bad}`)
console.log('C3+C3 vs C6 (want false):', deepEql(new Set([...ring(3), ...ring(3)]), new Set(ring(6))))
// mixed: cyclic elements + duplicate-shaped Maps in one Set
const mkCyclicMapSet = () => {
    const parent = { id: 'p' }
    const child = { id: 'c', parent }
    parent.kids = new Set([child])
    return new Set([parent, new Map([[{}, 1], [{}, 2]])])
}
console.log('cyclic+dupkey combo (want true):', deepEql(mkCyclicMapSet(), mkCyclicMapSet()))
