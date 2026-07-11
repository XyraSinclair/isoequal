/* How far does deep-eql (chai) actually go on cyclic unordered equality?
 * (a) cyclic metamorphic fuzz: shuffled clones must be TRUE
 * (b) cyclic mutant fuzz: one flipped edge must be FALSE (false-positive hunt)
 * (c) sharing semantics probe (S1 vs S2)
 * (d) perf on large sets */
import deepEql from 'deep-eql'
import { isoEqual } from '../dist/index.js'

let s = 0xfeedface
const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
}
const ri = (n) => (rnd() * n) | 0
const sample = (arr) => arr[ri(arr.length)]

function cyclicGraph(nNodes) {
    const nodes = Array.from({ length: nNodes }, () => {
        const r = rnd()
        return r < 0.55 ? new Set() : r < 0.85 ? [] : {}
    })
    const nEdges = nNodes + ri(nNodes * 2)
    for (let i = 0; i < nEdges; i++) {
        const from = sample(nodes)
        const to = rnd() < 0.85 ? sample(nodes) : ri(3)
        if (from instanceof Set) from.add(to)
        else if (Array.isArray(from)) from.push(to)
        else from[`k${ri(4)}`] = to
    }
    return new Set(nodes) // tie together so everything is reachable
}
function cloneShuffled(root) {
    const map = new Map()
    const go = (v) => {
        if (v === null || typeof v !== 'object') return v
        if (map.has(v)) return map.get(v)
        if (Array.isArray(v)) {
            const c = []
            map.set(v, c)
            for (const x of v) c.push(go(x))
            return c
        }
        if (v instanceof Set) {
            const c = new Set()
            map.set(v, c)
            const items = [...v]
            for (let i = items.length - 1; i > 0; i--) {
                const j = ri(i + 1); [items[i], items[j]] = [items[j], items[i]]
            }
            for (const x of items) c.add(go(x))
            return c
        }
        const c = {}
        map.set(v, c)
        for (const k of Object.keys(v)) c[k] = go(v[k])
        return c
    }
    return go(root)
}
const reach = (root) => {
    const seen = new Set([root])
    const out = [root]
    for (let i = 0; i < out.length; i++) {
        const o = out[i]
        const kids = Array.isArray(o) ? o : o instanceof Set ? [...o] : Object.values(o)
        for (const c of kids) {
            if (c !== null && typeof c === 'object' && !seen.has(c)) { seen.add(c); out.push(c) }
        }
    }
    return out
}

// (a) metamorphic accept
let acceptFails = 0
for (let i = 0; i < 300; i++) {
    const g = cyclicGraph(4 + ri(10))
    if (!deepEql(g, cloneShuffled(g))) acceptFails++
}
console.log(`(a) cyclic metamorphic accept: ${acceptFails}/300 failures`)

// (b) mutant reject — add one edge that didn't exist (invariant: edge count differs)
let mutantAccepts = 0
let mutantTried = 0
const savedFP = []
for (let i = 0; i < 300; i++) {
    const g = cyclicGraph(4 + ri(10))
    const m = cloneShuffled(g)
    const nodes = reach(m).filter((o) => o instanceof Set || Array.isArray(o))
    let mutated = false
    for (let t = 0; t < 50 && !mutated; t++) {
        const from = sample(nodes)
        const to = sample(reach(m))
        if (from instanceof Set) { if (!from.has(to)) { from.add(to); mutated = true } }
        else { from.push(to); mutated = true }
    }
    if (!mutated) continue
    mutantTried++
    const de = deepEql(g, m)
    if (de) {
        // adjudicate: is it REALLY unequal? total child-count differs ⇒ yes under S2;
        // under S1 an added edge to a bisimilar node CAN preserve unfolding-equality.
        const iso = isoEqual(g, m)
        mutantAccepts++
        if (savedFP.length < 3) savedFP.push(iso)
    }
}
console.log(`(b) mutant accept (deepEql says equal after edge add): ${mutantAccepts}/${mutantTried} — isoequal verdicts on those: ${savedFP}`)

// (c) sharing semantics
const x = { v: 1 }
console.log('(c) sharing: deepEql([x,x],[clone,clone2]) =', deepEql([x, x], [{ v: 1 }, { v: 1 }]), '(S1 says true, S2 false)')

// (d) perf: big sets
const mkPrim = (order) => new Set(order)
const asc = Array.from({ length: 10000 }, (_, i) => i)
const desc = [...asc].reverse()
let t0 = performance.now()
deepEql(mkPrim(asc), mkPrim(desc))
console.log(`(d) 10k primitive set (reversed order): deep-eql ${(performance.now() - t0).toFixed(0)}ms`)
t0 = performance.now()
isoEqual(mkPrim(asc), mkPrim(desc))
console.log(`    same: isoequal ${(performance.now() - t0).toFixed(1)}ms`)
const objs = (n) => new Set(Array.from({ length: n }, (_, i) => ({ id: i, v: `s${i}` })))
const A = objs(300)
const B = objs(300)
t0 = performance.now()
deepEql(A, B)
console.log(`    300-object set: deep-eql ${(performance.now() - t0).toFixed(0)}ms`)
t0 = performance.now()
isoEqual(A, B)
console.log(`    same: isoequal ${(performance.now() - t0).toFixed(1)}ms`)
