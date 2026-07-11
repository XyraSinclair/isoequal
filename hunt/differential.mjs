/* Defect hunt: run every candidate equality lib against the signature cases
 * and a differential fuzz adjudicated by isoequal + the brute-force
 * reference. Output: per-lib defect table for the PR campaign.
 * Run: node hunt/differential.mjs (from repo root, after npm run build) */
import { isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'
import { isoEqual, isoEqualReference } from '../dist/index.js'

const require = createRequire(import.meta.url)

const libs = {}
libs['node:isDeepStrictEqual'] = isDeepStrictEqual
try { libs['deep-eql (chai/vitest)'] = require('deep-eql') } catch (e) { console.error('deep-eql load:', e.message) }
try { libs['es-toolkit isEqual'] = require('es-toolkit').isEqual } catch (e) { console.error('es-toolkit load:', e.message) }
try { libs['remeda isDeepEqual'] = require('remeda').isDeepEqual } catch (e) { console.error('remeda load:', e.message) }
try { libs['@wry/equality (apollo)'] = require('@wry/equality').equal } catch (e) { console.error('wry load:', e.message) }
try { libs['react-fast-compare'] = require('react-fast-compare') } catch (e) { console.error('rfc load:', e.message) }

/* ------------------------------ signature cases --------------------------- */
const ring = (k) => {
    const nodes = Array.from({ length: k }, () => ({}))
    for (let i = 0; i < k; i++) nodes[i].next = nodes[(i + 1) % k]
    return nodes
}
const shuffledRingSet = (k, order) => {
    const b = ring(k)
    return new Set(order.map((i) => b[i]))
}

const CASES = []
{
    // 1. self-cycle (must be true)
    const a = {}; a.self = a
    const b = {}; b.self = b
    CASES.push(['self-cycle', a, b, true])
}
{
    // 2. cyclic shuffled rings in Sets (must be true)
    CASES.push(['C6 vs shuffled C6 in Set', new Set(ring(6)), shuffledRingSet(6, [3, 1, 5, 0, 4, 2]), true])
}
{
    // 3. C3+C3 vs C6 (must be false)
    CASES.push(['C3+C3 vs C6', new Set([...ring(3), ...ring(3)]), new Set(ring(6)), false])
}
{
    // 4. multiset trap (must be false)
    CASES.push(['set multiset trap', new Set([[1, 2], [1, 2], [3, 4]]), new Set([[1, 2], [3, 4], [3, 4]]), false])
}
{
    // 5. Map duplicate-shaped keys (must be true)
    CASES.push(['Map dup-shaped keys', new Map([[{}, 1], [{}, 2]]), new Map([[{}, 2], [{}, 1]]), true])
}
{
    // 6. nested-set false positive (dequal#31 shape; must be false)
    CASES.push(['nested-set overcount', new Set([new Set([1, 2]), new Set([1, 2])]), new Set([new Set([1, 2]), new Set([1, 4])]), false])
}
{
    // 7. boxed primitives (must be false)
    // eslint-disable-next-line no-new-wrappers
    CASES.push(['boxed Number 1 vs 2', new Number(1), new Number(2), false])
}
{
    // 8. plain agreement sanity (must be true)
    CASES.push(['plain nested equal', { a: [1, { b: 2 }], s: new Set([1, 2]) }, { a: [1, { b: 2 }], s: new Set([2, 1]) }, true])
}

console.log('=== SIGNATURE CASES ===')
const defects = {}
for (const [name, fn] of Object.entries(libs)) {
    defects[name] = []
    for (const [label, a, b, want] of CASES) {
        let got
        try {
            got = fn(a, b)
        } catch (e) {
            got = `THROW(${e.constructor.name})`
        }
        const ok = got === want
        if (!ok) defects[name].push(`${label}: got ${got}, want ${want}`)
    }
}
for (const [name, list] of Object.entries(defects)) {
    console.log(`\n--- ${name}: ${list.length} defects`)
    for (const d of list) console.log('   ✗', d)
}

/* ------------------------------ acyclic fuzz ------------------------------ */
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

console.log('\n=== ACYCLIC DIFFERENTIAL FUZZ (3000 pairs/lib) ===')
for (const [name, fn] of Object.entries(libs)) {
    let falseNeg = 0
    let falsePos = 0
    let crash = 0
    let example = null
    for (let i = 0; i < 3000; i++) {
        const a = gen(3)
        const b = rnd() < 0.4 ? structuredClone(a) : gen(3)
        const truth = isoEqualReference(a, b) // exhaustive oracle
        if (isoEqual(a, b) !== truth) { console.log('!!! ENGINE/ORACLE SPLIT', i); break }
        let got
        try {
            got = fn(a, b)
        } catch {
            crash++
            continue
        }
        if (got !== truth) {
            if (truth && !got) falseNeg++
            else falsePos++
            if (!example) example = i
        }
    }
    console.log(`${name}: falseNeg=${falseNeg} falsePos=${falsePos} crash=${crash}${example !== null ? ` (first at i=${example})` : ''}`)
}
