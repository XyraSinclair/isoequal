/* Shared test infrastructure for isoequal's suites: seeded PRNG, random graph
 * generation over the Array/Set/POJO model, sharing-preserving shuffled
 * cloning, and the brute-force S2 oracle (a direct transcription of
 * DESIGN.md §1: try every bijection φ with φ(root_A)=root_B).
 * Test-only — not part of the isoequal runtime. */

export const makeRng = (seed: number) => {
    let s = seed >>> 0 || 1
    return () => {
        // xorshift32
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        return (s >>> 0) / 0x100000000
    }
}
export type Rng = ReturnType<typeof makeRng>
export const randInt = (rng: Rng, n: number) => (rng() * n) | 0
export const sample = <T>(rng: Rng, arr: readonly T[]): T => arr[randInt(rng, arr.length)]
export const shuffled = <T>(rng: Rng, arr: readonly T[]): T[] => {
    const out = [...arr]
    for (let i = out.length - 1; i > 0; i--) {
        const j = randInt(rng, i + 1)
        ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

export type GNode = unknown[] | Set<unknown> | Map<unknown, unknown> | Record<string, unknown>

export const isGObj = (v: unknown): v is GNode => v !== null && typeof v === 'object'

const childrenOf = (o: GNode): unknown[] => {
    if (Array.isArray(o)) return [...o]
    if (o instanceof Set) return [...o]
    if (o instanceof Map) return [...o.keys(), ...o.values()]
    return Object.values(o)
}

/** BFS reach, root first. */
export function reach(root: GNode): GNode[] {
    const seen = new Set<GNode>([root])
    const out: GNode[] = [root]
    for (let i = 0; i < out.length; i++) {
        for (const c of childrenOf(out[i])) {
            if (isGObj(c) && !seen.has(c)) {
                seen.add(c)
                out.push(c)
            }
        }
    }
    return out
}

/** Deep clone that preserves cycles/sharing and SHUFFLES Set insertion order. */
export function cloneShuffled(root: GNode, rng: Rng): GNode {
    const map = new Map<GNode, GNode>()
    const cloneOf = (v: unknown): unknown => {
        if (!isGObj(v)) return v
        const hit = map.get(v)
        if (hit) return hit
        if (Array.isArray(v)) {
            const c: unknown[] = []
            map.set(v, c)
            for (const x of v) c.push(cloneOf(x))
            return c
        }
        if (v instanceof Set) {
            const c = new Set<unknown>()
            map.set(v, c)
            for (const x of shuffled(rng, [...v])) c.add(cloneOf(x))
            return c
        }
        if (v instanceof Map) {
            const c = new Map<unknown, unknown>()
            map.set(v, c)
            for (const [k, val] of shuffled(rng, [...v.entries()])) c.set(cloneOf(k), cloneOf(val))
            return c
        }
        const c: Record<string, unknown> = {}
        map.set(v as GNode, c)
        for (const k of Object.keys(v)) c[k] = cloneOf((v as Record<string, unknown>)[k])
        return c
    }
    return cloneOf(root) as GNode
}

/** Random graph over Arrays/Sets/POJOs with primitives sprinkled in. */
export function randomGraph(rng: Rng, nNodes: number, setBias = 0.55): GNode {
    const nodes: GNode[] = Array.from({ length: nNodes }, () => {
        const r = rng()
        return r < setBias ? new Set<unknown>() : r < setBias + 0.3 ? [] : {}
    })
    const nEdges = randInt(rng, nNodes * 2) + nNodes
    for (let i = 0; i < nEdges; i++) {
        const from = sample(rng, nodes)
        const to = rng() < 0.85 ? sample(rng, nodes) : randInt(rng, 3)
        if (from instanceof Set) from.add(to)
        else if (Array.isArray(from)) from.push(to)
        else (from as Record<string, unknown>)[`k${randInt(rng, 4)}`] = to
    }
    return nodes[0]
}

/** Random graph over Arrays/Sets/MAPS/POJOs (upstreamed from the adversarial
 * review's scratch kit — the only fuzz coverage of the Map residue paths). */
export function randomGraphM(rng: Rng, nNodes: number): GNode {
    const PRIMS = [0, 1, 2, NaN, 'a', null, undefined, true] as const
    const nodes: GNode[] = Array.from({ length: nNodes }, () => {
        const r = rng()
        if (r < 0.3) return new Set<unknown>()
        if (r < 0.55) return new Map<unknown, unknown>()
        if (r < 0.8) return []
        return {}
    })
    const nEdges = randInt(rng, nNodes * 2) + nNodes
    for (let i = 0; i < nEdges; i++) {
        const from = sample(rng, nodes)
        const target = () =>
            rng() < 0.8 ? sample(rng, nodes) : (PRIMS as readonly unknown[])[randInt(rng, PRIMS.length)]
        if (from instanceof Set) from.add(target())
        else if (from instanceof Map) from.set(target(), target())
        else if (Array.isArray(from)) from.push(target())
        else (from as Record<string, unknown>)[`k${randInt(rng, 4)}`] = target()
    }
    return nodes[0]
}

/** Directed ring of `{next}` POJOs — the classic refinement-symmetric family. */
export const ring = (k: number): { next?: object }[] => {
    const nodes = Array.from({ length: k }, () => ({} as { next?: object }))
    for (let i = 0; i < k; i++) nodes[i].next = nodes[(i + 1) % k]
    return nodes
}

/** Brute-force S2 oracle. Exponential — reachable sets of ≤ ~7 objects only. */
export function isoBruteForce(a: GNode, b: GNode): boolean {
    const RA = reach(a)
    const RB = reach(b)
    const n = RA.length
    if (n !== RB.length) return false
    const idxA = new Map(RA.map((o, i) => [o, i] as const))

    const perm = new Int32Array(n).fill(-1)
    const used = new Uint8Array(n)
    perm[0] = 0
    used[0] = 1

    const matchRef = (u: unknown, v: unknown): boolean => {
        if (!isGObj(u)) return Object.is(u, v)
        if (!isGObj(v)) return false
        return RB[perm[idxA.get(u)!]] === v
    }
    const img = (u: unknown): unknown => (isGObj(u) ? RB[perm[idxA.get(u)!]] : u)
    const checkPair = (x: GNode, y: GNode): boolean => {
        if (Array.isArray(x)) {
            if (!Array.isArray(y) || x.length !== y.length) return false
            return x.every((u, i) => matchRef(u, y[i]))
        }
        if (x instanceof Set) {
            if (!(y instanceof Set) || x.size !== y.size) return false
            for (const m of x) {
                if (!y.has(img(m))) return false
            }
            return true
        }
        if (x instanceof Map) {
            if (!(y instanceof Map) || x.size !== y.size) return false
            for (const [k, val] of x) {
                const ik = img(k)
                if (!y.has(ik)) return false
                if (!matchRef(val, y.get(ik))) return false
            }
            return true
        }
        if (Array.isArray(y) || y instanceof Set || y instanceof Map) return false
        const xk = Object.keys(x)
        const yk = Object.keys(y)
        if (xk.length !== yk.length) return false
        return xk.every(
            (k) =>
                Object.prototype.hasOwnProperty.call(y, k) &&
                matchRef((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k])
        )
    }
    const tryFrom = (i: number): boolean => {
        if (i === n) {
            for (let j = 0; j < n; j++) {
                if (!checkPair(RA[j], RB[perm[j]])) return false
            }
            return true
        }
        for (let cand = 0; cand < n; cand++) {
            if (used[cand]) continue
            perm[i] = cand
            used[cand] = 1
            if (tryFrom(i + 1)) return true
            used[cand] = 0
        }
        perm[i] = -1
        return false
    }
    return tryFrom(1)
}
