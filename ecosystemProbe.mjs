// Probe: do mainstream deep-equal implementations handle the cases DEQUAL4 targets?
import { isDeepStrictEqual } from 'node:util'

const cases = []

// 1. Sharing trap: [a1,a2,a1] vs [b1,b1,b2] — S2 (isomorphism) says FALSE
{
    const a1 = [], a2 = []
    const b1 = [], b2 = []
    cases.push(['sharing [a1,a2,a1] vs [b1,b1,b2] (S2: false)', [a1, a2, a1], [b1, b1, b2]])
}

// 2. Multiset trap (old2 header): Set{x,x',y} vs Set{x,y,y'} where x≈[1,2], y≈[3,4]
{
    const A = new Set([[1, 2], [1, 2], [3, 4]])
    const B = new Set([[1, 2], [3, 4], [3, 4]])
    cases.push(['multiset trap Set{[1,2],[1,2],[3,4]} vs Set{[1,2],[3,4],[3,4]} (false)', A, B])
}

// 3. Cyclic sets, shuffled — genuinely equal (true)
{
    const a1 = new Set(), a2 = new Set()
    a1.add(a2); a2.add(a1); a1.add(1); a2.add(2)
    const b2 = new Set(), b1 = new Set()
    b2.add(2); b2.add(b1); b1.add(1); b1.add(b2) // same structure, different insertion order
    cases.push(['cyclic shuffled sets (true)', a1, b1])
}

// 4. Trick graphs from dequalTest.ts (non-isomorphic, WL-ish hard) — should be FALSE
{
    function build(dTarget) {
        const a = new Set(), b = new Set(), c = new Set(), d = new Set()
        a.add(b); a.add(c); b.add(c); c.add(d)
        d.add(dTarget === 'c' ? c : b)
        return [a, b, c, d]
    }
    cases.push(['trick graphs d→c vs d→b (false)', build('c'), build('b')])
}

// 5. Cycle at all (dequal-npm baseline): self-referencing object
{
    const a = {}; a.self = a
    const b = {}; b.self = b
    cases.push(['simple self-cycle (true)', a, b])
}


// 6. THE RING CASE: two equal 6-node cyclic rings, shuffled insertion order.
//    node's isDeepStrictEqual returns false for EVERY insertion order at k=6.
{
    const ring = (k) => {
        const nodes = Array.from({ length: k }, () => ({}))
        for (let i = 0; i < k; i++) nodes[i].next = nodes[(i + 1) % k]
        return nodes
    }
    const A = new Set(ring(6))
    const b = ring(6)
    const B = new Set([b[3], b[1], b[5], b[0], b[4], b[2]])
    cases.push(['6-ring vs shuffled 6-ring in a Set (true)', A, B])
    cases.push(['C3+C3 vs C6 (false)', new Set([...ring(3), ...ring(3)]), new Set(ring(6))])
}

const impls = { 'node util.isDeepStrictEqual': isDeepStrictEqual }
try {
    const { dequal } = await import('./node_modules/dequal/dist/index.mjs')
    impls['dequal (npm)'] = dequal
} catch (e) { console.log('dequal npm not loadable:', e.message) }
try {
    const { default: isEqual } = await import('./node_modules/lodash/isEqual.js')
    impls['lodash isEqual'] = isEqual
} catch (e) { console.log('lodash not loadable:', e.message) }
try {
    const { default: fastDeepEqual } = await import('./node_modules/fast-deep-equal/es6/index.js')
    impls['fast-deep-equal/es6'] = fastDeepEqual
} catch (e) { console.log('fast-deep-equal not loadable:', e.message) }
try {
    const { isoEqual } = await import('./dist/index.js')
    impls['isoequal (this library)'] = isoEqual
} catch (e) { console.log('isoequal dist not built — run `npm run build` first:', e.message) }

for (const [name, fn] of Object.entries(impls)) {
    console.log(`\n=== ${name} ===`)
    for (const [label, A, B] of cases) {
        let out
        try { out = String(fn(A, B)) } catch (e) { out = `THROW(${e.constructor.name})` }
        console.log(`  ${label}: ${out}`)
    }
}
