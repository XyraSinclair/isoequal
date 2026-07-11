import { describe, expect, it } from 'vitest'
import { createIsoEqual, isoEqual, isoEqualStrict, IsoEqualBudgetError, UNORDERED } from './index.js'
import {
    cloneShuffled,
    GNode,
    isoBruteForce,
    makeRng,
    randInt,
    randomGraph,
    randomGraphM,
    reach,
    ring,
    Rng,
    sample,
} from './testKit.js'

describe('isoequal: primitives & leaves', () => {
    it('primitives', () => {
        expect(isoEqual(1, 1)).toBe(true)
        expect(isoEqual(NaN, NaN)).toBe(true)
        expect(isoEqual(0, -0)).toBe(false) // SameValue in ordered positions
        expect(isoEqual(1, '1')).toBe(false)
        expect(isoEqual('a', 'a')).toBe(true)
        expect(isoEqual(1n, 1n)).toBe(true)
        expect(isoEqual(null, undefined)).toBe(false)
        expect(isoEqual(null, null)).toBe(true)
    })
    it('dates', () => {
        expect(isoEqual(new Date(5), new Date(5))).toBe(true)
        expect(isoEqual(new Date(5), new Date(6))).toBe(false)
        expect(isoEqual(new Date(NaN), new Date(NaN))).toBe(true) // invalid dates equal
    })
    it('regexps', () => {
        expect(isoEqual(/ab/gi, /ab/gi)).toBe(true)
        expect(isoEqual(/ab/gi, /ab/g)).toBe(false)
        expect(isoEqual(/ab/, /ac/)).toBe(false)
    })
    it('typed arrays & buffers', () => {
        expect(isoEqual(new Float64Array([NaN, -0]), new Float64Array([NaN, -0]))).toBe(true)
        expect(isoEqual(new Float64Array([-0]), new Float64Array([0]))).toBe(false)
        expect(isoEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
        expect(isoEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
        expect(isoEqual(new Uint8Array([1]), new Int8Array([1]))).toBe(false) // ctor differs
        expect(isoEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer)).toBe(true)
        expect(isoEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer)).toBe(false)
        const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)
        expect(isoEqual(dv([7, 8]), dv([7, 8]))).toBe(true)
        expect(isoEqual(dv([7, 8]), dv([7, 9]))).toBe(false)
    })
    it('boxed primitives', () => {
        // eslint-disable-next-line no-new-wrappers
        expect(isoEqual(new Number(5), new Number(5))).toBe(true)
        // eslint-disable-next-line no-new-wrappers
        expect(isoEqual(new Number(5), new Number(6))).toBe(false)
        // eslint-disable-next-line no-new-wrappers
        expect(isoEqual(new Number(5), 5)).toBe(false) // object vs primitive
        // eslint-disable-next-line no-new-wrappers
        expect(isoEqual(new String('x'), new String('x'))).toBe(true)
    })
    it('errors', () => {
        expect(isoEqual(new Error('boom'), new Error('boom'))).toBe(true)
        expect(isoEqual(new Error('boom'), new Error('bam'))).toBe(false)
        expect(isoEqual(new Error('boom'), new TypeError('boom'))).toBe(false)
    })
    it('functions & identity-only objects', () => {
        const f = () => 1
        expect(isoEqual([f], [f])).toBe(true)
        expect(isoEqual([() => 1], [() => 1])).toBe(false)
        const wm = new WeakMap()
        expect(isoEqual([wm], [wm])).toBe(true)
        expect(isoEqual([new WeakMap()], [new WeakMap()])).toBe(false)
    })
    it('sparse arrays: holes are not undefined', () => {
        // eslint-disable-next-line no-sparse-arrays
        const holed = [1, , 3]
        expect(isoEqual(holed, [1, undefined, 3])).toBe(false)
        // eslint-disable-next-line no-sparse-arrays
        expect(isoEqual(holed, [1, , 3])).toBe(true)
        expect(isoEqual([1, undefined, 3], [1, undefined, 3])).toBe(true)
        // inside sets (residue path)
        // eslint-disable-next-line no-sparse-arrays
        expect(isoEqual(new Set([[, 1], {}]), new Set([{}, [undefined, 1]]))).toBe(false)
        // eslint-disable-next-line no-sparse-arrays
        expect(isoEqual(new Set([[, 1], {}]), new Set([{}, [, 1]]))).toBe(true)
    })
    it('arrays with custom props (regex-match style): opt-in', () => {
        const mk = (idx: number) => {
            const a = ['x', 'y'] as string[] & { index?: number }
            a.index = idx
            return a
        }
        // default: array extras ignored (documented — zero-alloc detection is
        // impossible in userland; holes stay exact regardless)
        expect(isoEqual(mk(3), mk(4))).toBe(true)
        const strict = createIsoEqual({ checkArrayOwnProps: true })
        expect(strict(mk(3), mk(3))).toBe(true)
        expect(strict(mk(3), mk(4))).toBe(false)
        expect(strict(mk(3), ['x', 'y'])).toBe(false)
        // inside sets (residue path)
        expect(strict(new Set([mk(3), {}]), new Set([{}, mk(3)]))).toBe(true)
        expect(strict(new Set([mk(3), {}]), new Set([{}, mk(4)]))).toBe(false)
    })
    it('sets/maps with custom own props', () => {
        const mkSet = (tag: string) => {
            const s = new Set([1, 2]) as Set<number> & { tag?: string }
            s.tag = tag
            return s
        }
        expect(isoEqual(mkSet('a'), mkSet('a'))).toBe(true)
        expect(isoEqual(mkSet('a'), mkSet('b'))).toBe(false)
        expect(isoEqual(mkSet('a'), new Set([1, 2]))).toBe(false)
        const mkMap = (n: number) => {
            const m = new Map([['k', 1]]) as Map<string, number> & { n?: number }
            m.n = n
            return m
        }
        expect(isoEqual(mkMap(1), mkMap(1))).toBe(true)
        expect(isoEqual(mkMap(1), mkMap(2))).toBe(false)
        // custom props inside the residue (sets of sets-with-props)
        expect(isoEqual(new Set([mkSet('a'), {}]), new Set([{}, mkSet('a')]))).toBe(true)
        expect(isoEqual(new Set([mkSet('a'), {}]), new Set([{}, mkSet('b')]))).toBe(false)
    })
    it('symbol-keyed props: opt-in, identity-matched', () => {
        const S = Symbol('tag')
        const mk = (v: number) => ({ a: 1, [S]: v })
        // default: symbol props ignored (documented perf trade)
        expect(isoEqual(mk(1), mk(2))).toBe(true)
        expect(isoEqualStrict(mk(1), mk(1))).toBe(true)
        expect(isoEqualStrict(mk(1), mk(2))).toBe(false)
        expect(isoEqualStrict(mk(1), { a: 1 })).toBe(false)
        expect(isoEqualStrict({ a: 1 }, mk(1))).toBe(false)
        // distinct same-description symbols do NOT match (identity semantics)
        expect(isoEqualStrict({ [Symbol('x')]: 1 }, { [Symbol('x')]: 1 })).toBe(false)
        // symbol props deep-compare their values
        expect(isoEqualStrict({ [S]: { deep: [1] } }, { [S]: { deep: [1] } })).toBe(true)
        expect(isoEqualStrict({ [S]: { deep: [1] } }, { [S]: { deep: [2] } })).toBe(false)
        // in the residue (sets of symbol-keyed objects)
        expect(isoEqualStrict(new Set([mk(1), {}]), new Set([{}, mk(1)]))).toBe(true)
        expect(isoEqualStrict(new Set([mk(1), {}]), new Set([{}, mk(2)]))).toBe(false)
    })
    it('forgeable dispatch: shadowed .constructor cannot redirect (review R1)', () => {
        expect(isoEqual({ constructor: Array, x: 1 }, { constructor: Array, x: 2 })).toBe(false)
        expect(isoEqual({ constructor: Array, x: 1 }, { constructor: Array, x: 1 })).toBe(true)
        expect(isoEqual({ constructor: Set }, { constructor: Set })).toBe(true)
        expect(isoEqual({ constructor: Map }, { constructor: Map })).toBe(true)
        expect(isoEqual({ constructor: Number }, { constructor: Number })).toBe(true)
        // different constructor-prop VALUES are just different data
        expect(isoEqual({ constructor: Set }, { constructor: Map })).toBe(false)
    })
    it('prototype-only fakes: no internal slot ⇒ compared as plain objects (review R1e)', () => {
        expect(isoEqual(Object.create(Number.prototype), Object.create(Number.prototype))).toBe(true)
        const fakeSet = () => Object.assign(Object.create(Set.prototype), { x: 1 })
        expect(isoEqual(fakeSet(), fakeSet())).toBe(true)
        expect(isoEqual(fakeSet(), new Set())).toBe(false) // real vs fake never equal
        const fakeDate = () => Object.create(Date.prototype)
        expect(isoEqual(fakeDate(), fakeDate())).toBe(true)
        expect(isoEqual(fakeDate(), new Date(0))).toBe(false)
    })
    it('null-proto vs Object-proto distinct despite constructor forging (review R1f)', () => {
        const a = Object.assign(Object.create(null), { constructor: undefined, x: 1 })
        expect(isoEqual(a, { constructor: undefined, x: 1 })).toBe(false)
    })
    it('shadowed collection methods cannot lie: internal slots decide', () => {
        const sharedLie = () => false
        const mk = (vals: number[]) => {
            const s = new Set(vals) as Set<number> & { has: unknown }
            s.has = sharedLie // own data prop shadowing Set.prototype.has
            Object.defineProperty(s, 'size', { value: 99, enumerable: true, configurable: true })
            return s
        }
        expect(isoEqual(mk([1, 2]), mk([1, 2]))).toBe(true) // real content decides membership
        expect(isoEqual(mk([1, 2]), mk([1, 3]))).toBe(false) // shadows equal, slots differ
        // a lying own Symbol.iterator never drives iteration (intrinsics do)
        const evil = new Set([1, 2]) as Set<number> & Record<symbol, unknown>
        ;(evil as Record<PropertyKey, unknown>)[Symbol.iterator] = function* () {
            yield 42
        } // deliberate lying own prop (adversarial test)
        expect(isoEqual(evil, new Set([1, 2]))).toBe(true)
    })
    it('lying SUBCLASS overrides cannot forge results (review R7a/R7b)', () => {
        class LyingSet extends Set<number> {
            has(): boolean {
                return false
            }
            get size(): number {
                return 99
            }
            // @ts-expect-error deliberately lying override (adversarial test)
            *[Symbol.iterator](): IterableIterator<number> {
                yield 42
            }
            // @ts-expect-error deliberately lying override (adversarial test)
            values(): IterableIterator<number> {
                return this[Symbol.iterator]()
            }
        }
        const mk = (vals: number[]) => new LyingSet(vals)
        expect(isoEqual(mk([1, 2]), mk([1, 2]))).toBe(true) // internal [[SetData]] decides
        expect(isoEqual(mk([1, 2]), mk([1, 3]))).toBe(false)
        expect(isoEqual(mk([1, 2]), new Set([1, 2]))).toBe(false) // different prototypes
        class LyingMap extends Map<string, number> {
            get(): number {
                return 999
            }
            has(): boolean {
                return false
            }
            get size(): number {
                return 0
            }
        }
        const mm = (v: number) => new LyingMap([['k', v]])
        expect(isoEqual(mm(1), mm(1))).toBe(true)
        expect(isoEqual(mm(1), mm(2))).toBe(false)
    })
    it('own values() lying toward a match cannot forge ordered acceptance (review R7c)', () => {
        const lie = function* (): IterableIterator<number> {
            yield 1
        }
        const mk = (n: number) => Object.assign(new Set([n]), { values: lie as never })
        expect(isoEqual(mk(1), mk(2))).toBe(false) // real contents differ
        expect(isoEqual(mk(1), mk(1))).toBe(true)
        // NON-ENUMERABLE own liar: invisible to prop comparison AND never invoked
        const liar = Object.defineProperty(new Set([9]), 'values', {
            value: () => [1][Symbol.iterator](),
            enumerable: false,
        })
        expect(isoEqual(new Set([1]), liar)).toBe(false)
        const mapLiar = Object.defineProperty(new Map([['k', 9]]), 'entries', {
            value: () => [['k', 1]][Symbol.iterator](),
            enumerable: false,
        })
        expect(isoEqual(new Map([['k', 1]]), mapLiar)).toBe(false)
        // subclass overriding ONLY entries(): still clean (we go via Symbol.iterator)
        class EntriesLiar extends Map<string, number> {
            // @ts-expect-error deliberately lying override (adversarial test)
            entries(): IterableIterator<[string, number]> {
                return [][Symbol.iterator]()
            }
        }
        expect(isoEqual(new EntriesLiar([['k', 1]]), new EntriesLiar([['k', 1]]))).toBe(true)
        expect(isoEqual(new EntriesLiar([['k', 1]]), new EntriesLiar([['k', 2]]))).toBe(false)
    })
    it('detached ArrayBuffers compare without throwing (review R7d)', () => {
        const mkDetached = () => {
            const ab = new ArrayBuffer(8)
            ab.transfer() // detaches ab
            return ab
        }
        expect(isoEqual(mkDetached(), mkDetached())).toBe(true) // no observable content
        expect(isoEqual(mkDetached(), new ArrayBuffer(0))).toBe(false) // detached ≠ live empty
        expect(isoEqual(mkDetached(), new ArrayBuffer(8))).toBe(false)
        // the production shape: transfer to a worker via structuredClone
        const mkTransferred = () => {
            const buf = new ArrayBuffer(8)
            structuredClone(buf, { transfer: [buf] })
            return buf
        }
        expect(isoEqual(mkTransferred(), mkTransferred())).toBe(true)
        expect(isoEqual(new ArrayBuffer(0), new ArrayBuffer(0))).toBe(true) // live empties
        // inside the residue
        expect(isoEqual(new Set([mkDetached(), {}]), new Set([{}, mkDetached()]))).toBe(true)
    })
    it('shadowed Date.getTime ignored; internal [[DateValue]] decides', () => {
        const lie = function () {
            return 0
        }
        const mk = (t: number) => Object.assign(new Date(t), { getTime: lie })
        expect(isoEqual(mk(5), mk(5))).toBe(true)
        expect(isoEqual(mk(5), mk(6))).toBe(false)
    })
    it('class instances & prototypes', () => {
        class P {
            constructor(public x: number) {}
        }
        class Q {
            constructor(public x: number) {}
        }
        expect(isoEqual(new P(1), new P(1))).toBe(true)
        expect(isoEqual(new P(1), new P(2))).toBe(false)
        expect(isoEqual(new P(1), new Q(1))).toBe(false)
        expect(isoEqual(new P(1), { x: 1 })).toBe(false)
        const np = Object.create(null) as Record<string, unknown>
        np.x = 1
        expect(isoEqual(np, { x: 1 })).toBe(false)
        const np2 = Object.create(null) as Record<string, unknown>
        np2.x = 1
        expect(isoEqual(np, np2)).toBe(true)
    })
})

describe('isoequal: ordered structures & cycles', () => {
    it('objects & arrays, unordered keys by default', () => {
        expect(isoEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true)
        expect(isoEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
        expect(isoEqual([1, [2, [3]]], [1, [2, [3]]])).toBe(true)
        expect(isoEqual([1, 2], [2, 1])).toBe(false)
        const ordered = createIsoEqual({ areObjectKeysOrdered: true })
        expect(ordered({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
        expect(ordered({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    })
    it('self-cycles', () => {
        const a: Record<string, unknown> = {}
        a.self = a
        const b: Record<string, unknown> = {}
        b.self = b
        expect(isoEqual(a, b)).toBe(true)
        const c: Record<string, unknown> = {}
        c.self = { self: c } // period-2 unrolling: different sharing shape
        expect(isoEqual(a, c)).toBe(false)
    })
    it('top-level identity, including cyclic', () => {
        const a: unknown[] = []
        a.push(a, new Set([a]))
        expect(isoEqual(a, a)).toBe(true)
    })
    it('sharing is significant (S2): [a,a] vs [b,a]', () => {
        const a: unknown[] = []
        const b: unknown[] = []
        expect(isoEqual([a, a], [b, a])).toBe(false)
        expect(isoEqual([a, a], [b, b])).toBe(true)
    })
    it('sharing: [a1,a2,a1] vs [b1,b1,b2] (design §1 pin)', () => {
        const a1: unknown[] = []
        const a2: unknown[] = []
        const b1: unknown[] = []
        const b2: unknown[] = []
        expect(isoEqual([a1, a2, a1], [b1, b1, b2])).toBe(false)
        expect(isoEqual([a1, a2, a1], [b1, b2, b1])).toBe(true)
    })
    it('inner identity is not shortcut (doc §4 counterexample)', () => {
        const x: unknown[] = []
        const y: unknown[] = []
        const s = [x]
        expect(isoEqual([s, x], [s, y])).toBe(false) // reachable counts differ
        expect(isoEqual([s, x], [s, x])).toBe(true)
    })
    it('shared leaves: [d,d] vs [d1,d2]', () => {
        const d = new Date(5)
        expect(isoEqual([d, d], [new Date(5), new Date(5)])).toBe(false)
        expect(isoEqual([d, d], [d, d])).toBe(true)
        const d2 = new Date(5)
        expect(isoEqual([d, d], [d2, d2])).toBe(true)
    })
})

describe('isoequal: unordered Sets & Maps', () => {
    it('primitive sets', () => {
        expect(isoEqual(new Set([1, 2, 3]), new Set([3, 1, 2]))).toBe(true)
        expect(isoEqual(new Set([1, 2]), new Set([1, 3]))).toBe(false)
        expect(isoEqual(new Set([0]), new Set([-0]))).toBe(true) // SameValueZero membership
        expect(isoEqual(new Set([NaN]), new Set([NaN]))).toBe(true)
        expect(isoEqual(new Set(['1']), new Set([1]))).toBe(false)
    })
    it('multiset trap (old2 header / ecosystem probe)', () => {
        const A = new Set([
            [1, 2],
            [1, 2],
            [3, 4],
        ])
        const B = new Set([
            [1, 2],
            [3, 4],
            [3, 4],
        ])
        expect(isoEqual(A, B)).toBe(false)
    })
    it('sets of objects, shuffled', () => {
        const A = new Set([{ a: 1 }, { b: 2 }, [3], new Set([4])])
        const B = new Set([new Set([4]), [3], { b: 2 }, { a: 1 }])
        expect(isoEqual(A, B)).toBe(true)
        const C = new Set([new Set([5]), [3], { b: 2 }, { a: 1 }])
        expect(isoEqual(A, C)).toBe(false)
    })
    it('cyclic shuffled sets (ecosystem probe case)', () => {
        const a1 = new Set<unknown>()
        const a2 = new Set<unknown>()
        a1.add(a2)
        a2.add(a1)
        a1.add(1)
        a2.add(2)
        const b2 = new Set<unknown>()
        const b1 = new Set<unknown>()
        b2.add(2)
        b2.add(b1)
        b1.add(1)
        b1.add(b2)
        expect(isoEqual(a1, b1)).toBe(true)
        expect(isoEqual(a1, b2)).toBe(false) // roots differ (1-set vs 2-set)
    })
    it('trick graphs (dequalTest fixture): similar but non-isomorphic', () => {
        function build(dTarget: 'b' | 'c') {
            const a = new Set<unknown>()
            const b = new Set<unknown>()
            const c = new Set<unknown>()
            const d = new Set<unknown>()
            a.add(b)
            a.add(c)
            b.add(c)
            c.add(d)
            d.add(dTarget === 'c' ? c : b)
            return [a, b, c, d]
        }
        expect(isoEqual(build('c'), build('b'))).toBe(false)
        expect(isoEqual(build('c'), build('c'))).toBe(true)
    })
    it('set elements anchored by the deterministic region', () => {
        const x = { tag: 'x' }
        const y = { tag: 'y' }
        // x, y are forced by array slots; the sets must then match them 1:1
        expect(isoEqual([x, y, new Set([x])], [x, y, new Set([x])])).toBe(true)
        const x2 = { tag: 'x' }
        const y2 = { tag: 'y' }
        expect(isoEqual([x, y, new Set([x])], [x2, y2, new Set([x2])])).toBe(true)
        expect(isoEqual([x, y, new Set([x])], [x2, y2, new Set([y2])])).toBe(false)
    })
    it('sharing inside sets needs the matcher, not greed', () => {
        const mk = () => ({})
        const x = mk()
        const A = new Set([
            [x, x],
            [mk(), mk()],
        ])
        const r = mk()
        const B1 = new Set([
            [mk(), mk()],
            [r, r],
        ])
        expect(isoEqual(A, B1)).toBe(true) // [x,x] must pair with [r,r]
        const B2 = new Set([
            [mk(), mk()],
            [mk(), mk()],
        ])
        expect(isoEqual(A, B2)).toBe(false)
    })
    it('maps: primitive keys force values', () => {
        const A = new Map<unknown, unknown>([
            [1, { a: 1 }],
            ['k', [2]],
        ])
        const B = new Map<unknown, unknown>([
            ['k', [2]],
            [1, { a: 1 }],
        ])
        expect(isoEqual(A, B)).toBe(true)
        expect(isoEqual(A, new Map<unknown, unknown>([[1, { a: 1 }], ['k', [3]]]))).toBe(false)
        expect(isoEqual(A, new Map<unknown, unknown>([[1, { a: 1 }], ['j', [2]]]))).toBe(false)
        expect(isoEqual(new Map([[0, 1]]), new Map([[-0, 1]]))).toBe(true) // SVZ keys
    })
    it('maps: object keys resolved speculatively, values checked', () => {
        const A = new Map([
            [{ k: 1 }, 'one'],
            [{ k: 2 }, 'two'],
        ])
        const B = new Map([
            [{ k: 2 }, 'two'],
            [{ k: 1 }, 'one'],
        ])
        expect(isoEqual(A, B)).toBe(true)
        const C = new Map([
            [{ k: 2 }, 'one'],
            [{ k: 1 }, 'two'],
        ])
        expect(isoEqual(A, C)).toBe(false) // values swapped relative to keys
    })
    it('rings: C12 ≅ shuffled C12, C6+C6 ≇ C12', () => {
        const rng = makeRng(42)
        const c12 = new Set(ring(12))
        expect(isoEqual(c12, cloneShuffled(c12, rng))).toBe(true)
        const c6c6 = new Set([...ring(6), ...ring(6)])
        expect(isoEqual(c6c6, new Set(ring(12)))).toBe(false)
        expect(isoEqual(c6c6, cloneShuffled(c6c6, rng))).toBe(true)
    })
    it('ordered-collections option', () => {
        const ordered = createIsoEqual({ areMapsSetsOrdered: true })
        expect(ordered(new Set([1, 2]), new Set([2, 1]))).toBe(false)
        expect(ordered(new Set([1, 2]), new Set([1, 2]))).toBe(true)
        expect(
            ordered(new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]]))
        ).toBe(false)
    })
    it('self-containing sets', () => {
        const s1 = new Set<unknown>()
        s1.add(s1)
        const s2 = new Set<unknown>()
        s2.add(s2)
        expect(isoEqual(s1, s2)).toBe(true)
        const t = new Set<unknown>()
        t.add(s1) // contains s1, not itself: different shape
        expect(isoEqual(s1, t)).toBe(false)
    })
    it('cross-collection sharing: member of 2 sets vs 2 distinct members', () => {
        const x = {}
        const A = [new Set([x]), new Set([x])] // same object in both sets
        const B = [new Set([{}]), new Set([{}])] // distinct objects
        expect(isoEqual(A, B)).toBe(false)
        const y = {}
        expect(isoEqual(A, [new Set([y]), new Set([y])])).toBe(true)
    })
    it('cyclic map keys', () => {
        const mkCyclicKey = () => {
            const k: Record<string, unknown> = { tag: 'k' }
            k.self = k
            return k
        }
        const A = new Map([[mkCyclicKey(), 'v']])
        const B = new Map([[mkCyclicKey(), 'v']])
        expect(isoEqual(A, B)).toBe(true)
        expect(isoEqual(A, new Map([[mkCyclicKey(), 'w']]))).toBe(false)
        expect(isoEqual(A, new Map([[{ tag: 'k' }, 'v']]))).toBe(false) // acyclic key
    })
    it('reentrancy: a getter that calls isoequal mid-walk', () => {
        const mk = () => ({
            get probe() {
                // reentrant call while the outer comparison is in flight
                return isoEqual(new Set([{ a: 1 }, [2]]), new Set([[2], { a: 1 }]))
            },
        })
        expect(isoEqual(mk(), mk())).toBe(true)
        const off = { probe: false }
        expect(isoEqual(mk(), off)).toBe(false)
    })
    it('array masquerade & residue-position independence (review R1g/R6)', () => {
        expect(isoEqual([1], { constructor: Array, 0: 1, length: 1 })).toBe(false)
        const mkFake = () => Object.create(Set.prototype) as object
        expect(isoEqual(new Set([mkFake(), {}]), new Set([{}, mkFake()]))).toBe(true)
        expect(isoEqual(new Set([{ constructor: Number }, []]), new Set([[], { constructor: Number }]))).toBe(true)
        // verdict must not depend on position (top-level vs inside residue)
        const mk = () => ({ constructor: Number })
        expect(isoEqual(new Set([mk(), []]), new Set([[], mk()]))).toBe(isoEqual(mk(), mk()))
    })
    it('feature strokes inside the residue (review R4)', () => {
        const mkSet = (v: number) => {
            const s = new Set([1]) as Set<number> & { meta?: object }
            s.meta = { v } // object-valued custom prop → arena edge, not fold
            return s
        }
        expect(isoEqual(new Set([mkSet(1), {}]), new Set([{}, mkSet(1)]))).toBe(true)
        expect(isoEqual(new Set([mkSet(1), {}]), new Set([{}, mkSet(2)]))).toBe(false)
        // sharing significance of custom-prop values inside the residue
        const shared = { s: 1 }
        const mkMap = (meta: object) => {
            const m = new Map([['k', 1]]) as Map<string, number> & { meta?: object }
            m.meta = meta
            return m
        }
        const A = new Set([mkMap(shared), mkMap(shared)])
        expect(isoEqual(A, new Set([mkMap({ s: 1 }), mkMap({ s: 1 })]))).toBe(false)
        const shared2 = { s: 1 }
        expect(isoEqual(A, new Set([mkMap(shared2), mkMap(shared2)]))).toBe(true)
        // symbol props with object values inside residue (strict)
        const S = Symbol('tag')
        const mkSym = (v: number) => ({ a: 1, [S]: { v } })
        expect(isoEqualStrict(new Set([mkSym(1), []]), new Set([[], mkSym(1)]))).toBe(true)
        expect(isoEqualStrict(new Set([mkSym(1), []]), new Set([[], mkSym(2)]))).toBe(false)
        // trailing hole vs shorter array inside residue
        // eslint-disable-next-line no-sparse-arrays
        const holed = [1, ,] // length 2, index 1 is a hole
        expect(isoEqual(new Set([holed, {}]), new Set([{}, [1]]))).toBe(false)
        // eslint-disable-next-line no-sparse-arrays
        expect(isoEqual(new Set([holed, {}]), new Set([{}, [1, ,]]))).toBe(true)
    })
    it('large WL-symmetric residue is linear, not quadratic/stack-fatal (review R5)', () => {
        const mkCase = (m: number) => {
            const empties = () => Array.from({ length: m }, () => ({}))
            // sentinel first on A, last on B ⇒ ordered phase misaligns and fails;
            // residue = one symmetric class of m empty POJOs per side
            const A = new Set([{ a: 1 }, ...empties()])
            const B = new Set([...empties(), { a: 1 }])
            return [A, B] as const
        }
        const [A, B] = mkCase(20_000) // pre-fix: RangeError after ~19s
        const t0 = performance.now()
        expect(isoEqual(A, B)).toBe(true)
        /* Generous bound: discriminates the old quadratic+stack-fatal regime
         * (~19s, then RangeError) from the greedy-verify linear path (~1-3s
         * under full-suite GC pressure) without being a flaky benchmark. */
        expect(performance.now() - t0).toBeLessThan(10_000)
        const [C, D] = mkCase(300)
        ;(D.values().next().value as { x?: number }).x = 1 // perturb one empty
        expect(isoEqual(C, D)).toBe(false)
    })
    it('budget: symmetric residue throws instead of hanging or lying', () => {
        const a = ring(6)
        const b = ring(6)
        /* Swap-adjacent insertion order is NOT a rotation, so the optimistic
         * ordered phase fails and the comparison must enter the speculative
         * solver — where the tiny budget trips. */
        const tiny = createIsoEqual({ maxSpeculativeOps: 1 })
        expect(() => tiny(new Set(a), new Set([b[1], b[0], ...b.slice(2)]))).toThrow(
            IsoEqualBudgetError
        )
        // sanity: with a real budget the same pair is simply equal
        expect(isoEqual(new Set(a), new Set([b[1], b[0], ...b.slice(2)]))).toBe(true)
    })
})

describe('isoequal: custom unordered collections (UNORDERED protocol)', () => {
    class MultiSet<T> implements Iterable<T> {
        constructor(private readonly items: T[]) {}
        get [UNORDERED](): boolean {
            return true
        }
        *[Symbol.iterator](): IterableIterator<T> {
            yield* this.items
        }
    }
    const ms = <T>(...items: T[]) => new MultiSet(items)

    it('primitive multisets: multiplicity counts, SameValue exact', () => {
        expect(isoEqual(ms(1, 1, 2), ms(2, 1, 1))).toBe(true)
        expect(isoEqual(ms(1, 1, 2), ms(1, 2, 2))).toBe(false) // multiplicities differ
        expect(isoEqual(ms(1, 2), ms(1, 2, 2))).toBe(false) // sizes differ
        expect(isoEqual(ms(NaN), ms(NaN))).toBe(true)
        expect(isoEqual(ms(0), ms(-0))).toBe(false) // custom collections CAN hold both ⇒ SameValue
        expect(isoEqual(ms('a', 'b'), ms('b', 'a'))).toBe(true)
    })
    it('object multisets: structural matching with sharing & multiplicity', () => {
        expect(isoEqual(ms({ v: 1 }, { v: 2 }), ms({ v: 2 }, { v: 1 }))).toBe(true)
        expect(isoEqual(ms({ v: 1 }, { v: 2 }), ms({ v: 2 }, { v: 3 }))).toBe(false)
        // the SAME object twice vs two distinct clones: S2 sharing
        const x = {}
        const y = {}
        expect(isoEqual(ms(x, x, {}), ms({}, y, y))).toBe(true) // x↔y, singles pair up
        expect(isoEqual(ms(x, x, {}), ms({}, {}, {}))).toBe(false) // 2 vs 3 reachable elems
    })
    it('cyclic custom collections', () => {
        const mkSelf = () => {
            const inner: unknown[] = []
            const m = new MultiSet<unknown>([inner, 1])
            inner.push(m)
            return m
        }
        expect(isoEqual(mkSelf(), mkSelf())).toBe(true)
        const other = new MultiSet<unknown>([[], 1])
        expect(isoEqual(mkSelf(), other)).toBe(false)
    })
    it('entries-style multimaps work with zero extra machinery', () => {
        class MultiMap<K, V> implements Iterable<[K, V]> {
            constructor(private readonly pairs: [K, V][]) {}
            get [UNORDERED](): boolean {
                return true
            }
            *[Symbol.iterator](): IterableIterator<[K, V]> {
                for (const [k, v] of this.pairs) yield [k, v]
            }
        }
        const mm = (...pairs: [string, number][]) => new MultiMap(pairs)
        expect(isoEqual(mm(['a', 1], ['a', 2]), mm(['a', 2], ['a', 1]))).toBe(true)
        expect(isoEqual(mm(['a', 1], ['a', 2]), mm(['a', 1], ['a', 1]))).toBe(false)
        expect(isoEqual(mm(['a', 1], ['b', 2]), mm(['b', 1], ['a', 2]))).toBe(false) // binding matters
    })
    it('detector option for foreign classes (no symbol)', () => {
        class Bag<T> implements Iterable<T> {
            constructor(private readonly items: T[]) {}
            *[Symbol.iterator](): IterableIterator<T> {
                yield* this.items
            }
        }
        const withDetector = createIsoEqual({ isUnorderedCollection: (o) => o instanceof Bag })
        expect(withDetector(new Bag([1, 2]), new Bag([2, 1]))).toBe(true)
        expect(withDetector(new Bag([1, 2]), new Bag([1, 3]))).toBe(false)
        expect(isoEqual(new Bag([1, 2]), new Bag([2, 1]))).toBe(false) // undeclared ⇒ ordered items prop
    })
    it('POJO literals can opt in; own props are not identity', () => {
        const mk = (items: number[], extra: number) => ({
            [UNORDERED]: true,
            extra,
            *[Symbol.iterator](): IterableIterator<number> {
                yield* items
            },
        })
        // hmm — generator methods on literals are fresh per object; contents decide
        expect(isoEqual(mk([1, 2], 7), mk([2, 1], 8))).toBe(true) // extra prop excluded by contract
        expect(isoEqual(mk([1, 2], 7), mk([1, 3], 7))).toBe(false)
    })
    it('inside the residue (custom collections as Set elements)', () => {
        expect(isoEqual(new Set([ms(1, 1, 2), {}]), new Set([{}, ms(2, 1, 1)]))).toBe(true)
        expect(isoEqual(new Set([ms(1, 1, 2), {}]), new Set([{}, ms(1, 2, 2)]))).toBe(false)
    })
    it('ordered-mode option applies to declared collections too', () => {
        const ordered = createIsoEqual({ areMapsSetsOrdered: true })
        expect(ordered(ms(1, 2), ms(2, 1))).toBe(false)
        expect(ordered(ms(1, 2), ms(1, 2))).toBe(true)
    })
    it('declared but not iterable throws a descriptive TypeError', () => {
        const bad = { [UNORDERED]: true, x: 1 }
        expect(() => isoEqual(bad, { ...bad })).toThrow(TypeError)
    })
})

describe('isoequal: oracle cross-validation (brute-force S2)', () => {
    it('C3+C3 vs C6 agrees with the oracle', () => {
        const A = new Set([...ring(3), ...ring(3)])
        const B = new Set(ring(6))
        expect(isoBruteForce(A, B)).toBe(false)
        expect(isoEqual(A, B)).toBe(false)
    })

    it('agrees with the oracle on shuffled clones and random pairs', () => {
        const rng = makeRng(0xd15ea5e)
        for (let iter = 0; iter < 150; iter++) {
            const g = randomGraph(rng, 3 + randInt(rng, 4)) // reach ≤ 6 ⇒ oracle ≤ 120 perms
            const clone = cloneShuffled(g, rng)
            expect(isoEqual(g, clone)).toBe(true) // metamorphic accept — oracle implied
            const other = randomGraph(rng, 3 + randInt(rng, 4))
            const expected = isoBruteForce(g, other)
            expect(isoEqual(g, other)).toBe(expected)
        }
    })
})

describe('isoequal: metamorphic at scale', () => {
    function bigGraph(rng: Rng, nNodes: number): GNode {
        const nodes: GNode[] = Array.from({ length: nNodes }, () => {
            const r = rng()
            return r < 0.6 ? new Set<unknown>() : r < 0.9 ? [] : {}
        })
        const nEdges = nNodes * 3
        for (let i = 0; i < nEdges; i++) {
            const from = sample(rng, nodes)
            const to = rng() < 0.9 ? sample(rng, nodes) : randInt(rng, 5)
            if (from instanceof Set) from.add(to)
            else if (Array.isArray(from)) from.push(to)
            else (from as Record<string, unknown>)[`k${randInt(rng, 6)}`] = to
        }
        // tie all components into one root set so nothing is unreachable
        return new Set(nodes)
    }

    /** Add one edge that did not exist: the total (node → child) count is an
     * isomorphism invariant, so the mutant is GUARANTEED non-isomorphic. */
    function addEdgeMutation(root: GNode, rng: Rng): boolean {
        const nodes = reach(root)
        for (let tries = 0; tries < 100; tries++) {
            const from = sample(rng, nodes)
            const to = sample(rng, nodes)
            if (from instanceof Set) {
                if (from.has(to)) continue
                from.add(to)
                return true
            }
            if (Array.isArray(from)) {
                from.push(to)
                return true
            }
        }
        return false
    }

    it('shuffled clones equal; single-edge mutants differ', () => {
        const rng = makeRng(0xbeefcafe)
        for (let iter = 0; iter < 10; iter++) {
            const g = bigGraph(rng, 40)
            const clone = cloneShuffled(g, rng)
            expect(isoEqual(g, clone)).toBe(true)
            const mutant = cloneShuffled(g, rng)
            if (addEdgeMutation(mutant, rng)) {
                expect(isoEqual(g, mutant)).toBe(false)
            }
        }
    })
})

describe('isoequal: high-volume oracle fuzz', () => {
    it('2000 oracle comparisons, set-heavy', () => {
        const rng = makeRng(0xfeed5eed)
        for (let iter = 0; iter < 2000; iter++) {
            const setBias = 0.4 + rng() * 0.55
            const g = randomGraph(rng, 3 + randInt(rng, 5), setBias) // reach ≤ 7
            expect(isoEqual(g, cloneShuffled(g, rng))).toBe(true)
            const other = randomGraph(rng, 3 + randInt(rng, 5), setBias)
            expect(isoEqual(g, other)).toBe(isoBruteForce(g, other))
        }
    })
    it('2000 MAP-inclusive oracle comparisons (review upstream)', () => {
        const rng = makeRng(0xabad1dea)
        for (let iter = 0; iter < 2000; iter++) {
            const g = randomGraphM(rng, 3 + randInt(rng, 4)) // reach ≤ 6
            expect(isoEqual(g, cloneShuffled(g, rng))).toBe(true) // shuffled entries too
            const other = randomGraphM(rng, 3 + randInt(rng, 4))
            expect(isoEqual(g, other)).toBe(isoBruteForce(g, other))
        }
    })
})
