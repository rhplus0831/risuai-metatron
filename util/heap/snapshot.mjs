// Reads and analyses V8 `.heapsnapshot` files (Chrome DevTools "Memory" > "Heap snapshot", or CDP
// `HeapProfiler.takeHeapSnapshot`) without DevTools: a summary by type and constructor, a diff of
// two snapshots of one page by node id, shortest retainer paths, and dominator retained sizes.
//
// A snapshot of a large page is bigger than V8's maximum string (~512 MiB), so the file is never
// decoded as one string: the `nodes` and `edges` arrays are parsed as digits straight from the
// Buffer and the `strings` array one string at a time.
//
// Used by `util/heap/analyze.mjs` (the command line) and `util/playwright/measureHeap.mjs`.
import { createHash } from "node:crypto";
import fs from "node:fs";

/** The bytes right after `"<key>":[`, searched from `from`. */
function arrayStart(buf, key, from) {
    const at = buf.indexOf(`"${key}"`, from, "latin1");
    if (at < 0) {
        throw new Error(`not a heap snapshot: no "${key}" array`);
    }
    let i = at + key.length + 2;
    while (buf[i] === 32 || buf[i] === 10 || buf[i] === 13 || buf[i] === 9 || buf[i] === 58) i++;
    if (buf[i] !== 91) {
        throw new Error(`not a heap snapshot: "${key}" is not an array`);
    }
    return i + 1;
}

const isSpace = (c) => c === 32 || c === 10 || c === 13 || c === 9;

/**
 * A JSON array of non-negative integers from `start` up to its `]`, into a typed array: exactly one
 * comma between values, nothing but whitespace around them, no value above `max`.
 */
function parseIntegers(buf, start, Ctor, expected, max) {
    let out = new Ctor(Math.max(16, expected));
    let count = 0;
    let i = start;
    const fail = (what) => {
        throw new Error(`malformed heap snapshot: ${what} at byte ${i}`);
    };
    while (isSpace(buf[i])) i++;
    if (buf[i] === 93) return { values: out.subarray(0, 0), end: i };
    for (;;) {
        while (isSpace(buf[i])) i++;
        if (!(buf[i] >= 48 && buf[i] <= 57)) fail(i >= buf.length ? "a truncated array" : "a missing number");
        let value = 0;
        while (buf[i] >= 48 && buf[i] <= 57) {
            value = value * 10 + (buf[i] - 48);
            i++;
        }
        if (value > max) fail(`${value} out of range`);
        if (count === out.length) {
            const grown = new Ctor(out.length * 2);
            grown.set(out);
            out = grown;
        }
        out[count++] = value;
        while (isSpace(buf[i])) i++;
        if (buf[i] === 93) return { values: out.subarray(0, count), end: i };
        if (buf[i] !== 44)
            fail(i >= buf.length ? "a truncated array" : `"${String.fromCharCode(buf[i])}" in a number array`);
        i++;
    }
}

/** The JSON array of strings from `start` up to its `]`, with the offset of that `]`. */
function parseStrings(buf, start) {
    const strings = [];
    let i = start;
    const fail = (what) => {
        throw new Error(`malformed heap snapshot: ${what} in the strings at byte ${i}`);
    };
    while (isSpace(buf[i])) i++;
    if (buf[i] === 93) return { strings, end: i };
    for (;;) {
        while (isSpace(buf[i])) i++;
        if (buf[i] !== 34) fail(i >= buf.length ? "a truncated array" : "a missing string");
        const from = i++;
        let escaped = false;
        let plain = true;
        for (; i < buf.length; i++) {
            const c = buf[i];
            if (escaped) {
                escaped = false;
            } else if (c === 92) {
                escaped = true;
                plain = false;
            } else if (c === 34) {
                break;
            }
        }
        if (i >= buf.length) fail("an unterminated string");
        i++;
        strings.push(plain ? buf.toString("utf8", from + 1, i - 1) : JSON.parse(buf.toString("utf8", from, i)));
        while (isSpace(buf[i])) i++;
        if (buf[i] === 93) return { strings, end: i };
        if (buf[i] !== 44) fail("a missing comma");
        i++;
    }
}

/**
 * A parsed snapshot. Nodes are numbered 0..count-1 (the root is 0); `firstEdge[n]` up to
 * `firstEdge[n + 1]` are node n's edges, as offsets into `edges` (stepping by `ef`).
 */
export function loadSnapshot(path) {
    return parseSnapshot(fs.readFileSync(path));
}

/** The offset just past the document's first field (`{"snapshot":{...}`), string-aware. */
function headEnd(buf) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === 92) escaped = true;
            else if (c === 34) inString = false;
        } else if (c === 34) {
            inString = true;
        } else if (c === 123 || c === 91) {
            depth++;
        } else if (c === 125 || c === 93) {
            depth--;
            // Back at depth 1, in the document object: the "snapshot" value ended here.
            if (depth === 1) return i + 1;
        }
    }
    throw new Error("not a heap snapshot: no snapshot header");
}

export function parseSnapshot(buf) {
    const nodesKey = headEnd(buf);
    const info = JSON.parse(`${buf.toString("utf8", 0, nodesKey)}}`).snapshot;
    if (!info?.meta) {
        throw new Error("not a heap snapshot: the first field is not the snapshot header");
    }
    const meta = info.meta;
    const nf = meta.node_fields.length;
    const ef = meta.edge_fields.length;
    const field = (fields, name) => {
        const index = fields.indexOf(name);
        if (index < 0) throw new Error(`heap snapshot without the "${name}" field`);
        return index;
    };
    const fType = field(meta.node_fields, "type");
    const fName = field(meta.node_fields, "name");
    const fId = field(meta.node_fields, "id");
    const fSize = field(meta.node_fields, "self_size");
    const fEdgeCount = field(meta.node_fields, "edge_count");
    const eType = field(meta.edge_fields, "type");
    const eName = field(meta.edge_fields, "name_or_index");
    const eTo = field(meta.edge_fields, "to_node");
    const nodeTypes = meta.node_types[fType];
    const edgeTypes = meta.edge_types[eType];

    const nodesParsed = parseIntegers(
        buf,
        arrayStart(buf, "nodes", nodesKey),
        Float64Array,
        info.node_count * nf,
        Number.MAX_SAFE_INTEGER,
    );
    const edgesParsed = parseIntegers(
        buf,
        arrayStart(buf, "edges", nodesParsed.end),
        Uint32Array,
        info.edge_count * ef,
        0xffffffff,
    );
    const parsedStrings = parseStrings(buf, arrayStart(buf, "strings", edgesParsed.end));
    const strings = parsedStrings.strings;
    // The strings are the document's last field: only its closing brace may follow.
    let tail = parsedStrings.end + 1;
    while (isSpace(buf[tail])) tail++;
    if (buf[tail] !== 125) {
        throw new Error("malformed heap snapshot: the document does not end after the strings");
    }
    const nodes = nodesParsed.values;
    const edges = edgesParsed.values;
    const count = nodes.length / nf;

    const weak = edgeTypes.indexOf("weak");
    const internal = edgeTypes.indexOf("internal");
    const shortcut = edgeTypes.indexOf("shortcut");
    const indexEdges = new Set(["element", "hidden"].map((name) => edgeTypes.indexOf(name)));
    if (nodes.length % nf !== 0 || edges.length % ef !== 0) {
        throw new Error("malformed heap snapshot: the arrays do not align with their fields");
    }
    if (count !== info.node_count || edges.length / ef !== info.edge_count) {
        throw new Error(
            `malformed heap snapshot: ${count} nodes and ${edges.length / ef} edges, the header says ${info.node_count} and ${info.edge_count}`,
        );
    }
    const firstEdge = new Uint32Array(count + 1);
    let edgeEnd = 0;
    for (let n = 0; n < count; n++) {
        firstEdge[n] = edgeEnd;
        edgeEnd += nodes[n * nf + fEdgeCount] * ef;
        if (nodes[n * nf + fName] >= strings.length) {
            throw new Error(`malformed heap snapshot: node ${n} names a missing string`);
        }
    }
    if (edgeEnd !== edges.length) {
        throw new Error("malformed heap snapshot: the nodes' edge counts do not add up to the edges");
    }
    firstEdge[count] = edgeEnd;
    for (let e = 0; e < edges.length; e += ef) {
        const to = edges[e + eTo];
        if (to % nf !== 0 || to >= nodes.length) {
            throw new Error(`malformed heap snapshot: edge ${e / ef} points outside the nodes`);
        }
        if (!indexEdges.has(edges[e + eType]) && edges[e + eName] >= strings.length) {
            throw new Error(`malformed heap snapshot: edge ${e / ef} names a missing string`);
        }
    }

    return {
        meta,
        count,
        nf,
        ef,
        nodes,
        edges,
        strings,
        firstEdge,
        type: (n) => nodeTypes[nodes[n * nf + fType]],
        name: (n) => strings[nodes[n * nf + fName]],
        id: (n) => nodes[n * nf + fId],
        size: (n) => nodes[n * nf + fSize],
        edgeType: (e) => edgeTypes[edges[e + eType]],
        edgeName: (e) => {
            const value = edges[e + eName];
            return indexEdges.has(edges[e + eType]) ? `[${value}]` : strings[value];
        },
        edgeTo: (e) => edges[e + eTo] / nf,
        /** Whether edge `e` of node `from` keeps its target alive (not weak; shortcuts only from the root). */
        strong: (e, from) => {
            const t = edges[e + eType];
            return t !== weak && (t !== shortcut || from === 0);
        },
        /**
         * The edges the dominator tree uses: the strong ones, except the table's half of a WeakMap
         * entry. A WeakMap value is retained by its key and its table together; as in Chrome
         * DevTools (`JSHeapSnapshot.isEssentialEdge`), only the key's edge counts, so the value is
         * charged to the key. DevTools' other exclusions (debugger- and other-context-owned
         * edges into page objects) are not applied; they changed none of the heap memory plan's
         * numbers on the snapshots it was checked against.
         */
        dominating: (e, from) => {
            const t = edges[e + eType];
            if (t === weak || (t === shortcut && from !== 0)) return false;
            if (t === internal) {
                const match = WEAKMAP_EDGE.exec(strings[edges[e + eName]]);
                if (match && Number(match[1]) === nodes[from * nf + fId]) return false;
            }
            return true;
        },
    };
}

/** The name V8 gives a WeakMap entry's internal edges; group 1 is the table's node id. */
const WEAKMAP_EDGE = /^\d+ \/ part of key \(.*? @\d+\) -> value \(.*? @\d+\) pair in WeakMap \(table @(\d+)\)$/;

/** A node's label: `type:name` for objects, closures and natives, the type for the rest. */
export function nodeKey(s, n) {
    const type = s.type(n);
    return type === "object" || type === "closure" || type === "native" ? `${type}:${s.name(n)}` : type;
}

/** Totals by node type and by `nodeKey`. */
export function summarize(s) {
    const byType = new Map();
    const byKey = new Map();
    let total = 0;
    for (let n = 0; n < s.count; n++) {
        const size = s.size(n);
        total += size;
        bump(byType, s.type(n), size);
        bump(byKey, nodeKey(s, n), size);
    }
    return { nodes: s.count, total, byType: sorted(byType), byKey: sorted(byKey) };
}

/** What `b` has that `a` has not (`added`) and the reverse (`freed`), by node id, grouped by `nodeKey`. */
export function diffSnapshots(a, b) {
    const idsOf = (s) => {
        const ids = new Set();
        for (let n = 0; n < s.count; n++) ids.add(s.id(n));
        return ids;
    };
    const only = (s, others) => {
        const groups = new Map();
        let total = 0;
        for (let n = 0; n < s.count; n++) {
            if (!others.has(s.id(n))) {
                total += s.size(n);
                bump(groups, nodeKey(s, n), s.size(n));
            }
        }
        return { total, groups: sorted(groups) };
    };
    return { added: only(b, idsOf(a)), freed: only(a, idsOf(b)) };
}

/**
 * Shortest retainer paths: a breadth-first walk from the root over strong edges. `pathOf(n)` lists
 * `{ node, edge }` steps from n up to the root (`edge` is the edge that holds `node`); null when n
 * is unreachable.
 */
export function retainers(s) {
    const parentEdge = new Int32Array(s.count).fill(-1);
    const parentNode = new Int32Array(s.count).fill(-1);
    const queue = new Int32Array(s.count);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    parentNode[0] = 0;
    while (head < tail) {
        const n = queue[head++];
        for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e += s.ef) {
            if (!s.strong(e, n)) continue;
            const to = s.edgeTo(e);
            if (parentNode[to] !== -1) continue;
            parentNode[to] = n;
            parentEdge[to] = e;
            queue[tail++] = to;
        }
    }
    const pathOf = (n, max = 40) => {
        if (parentNode[n] === -1) return null;
        const steps = [];
        for (let cur = n; cur !== 0 && steps.length < max; cur = parentNode[cur]) {
            steps.push({ node: cur, edge: parentEdge[cur] });
        }
        return steps;
    };
    return { pathOf, reachable: (n) => parentNode[n] !== -1 };
}

/**
 * Retained sizes from the dominator tree (Cooper, Harvey and Kennedy's iterative algorithm over a
 * postorder of the graph of `dominating` edges). `retained(n)` is 0 for an unreachable node; `idom(n)` is the
 * node's immediate dominator (-1 for the root and unreachable nodes).
 */
export function dominators(s) {
    const C = s.count;
    const post = new Int32Array(C).fill(-1);
    const order = new Int32Array(C);
    let visited = 0;
    const stack = new Int32Array(C);
    const cursor = new Uint32Array(C);
    const seen = new Uint8Array(C);
    let sp = 0;
    stack[sp] = 0;
    cursor[sp] = s.firstEdge[0];
    sp++;
    seen[0] = 1;
    while (sp > 0) {
        const n = stack[sp - 1];
        let e = cursor[sp - 1];
        let child = -1;
        for (; e < s.firstEdge[n + 1]; e += s.ef) {
            if (!s.dominating(e, n)) continue;
            const to = s.edgeTo(e);
            if (seen[to]) continue;
            seen[to] = 1;
            child = to;
            e += s.ef;
            break;
        }
        cursor[sp - 1] = e;
        if (child === -1) {
            sp--;
            post[n] = visited;
            order[visited++] = n;
        } else {
            stack[sp] = child;
            cursor[sp] = s.firstEdge[child];
            sp++;
        }
    }

    // Predecessors over the same edges, as compressed rows.
    const predStart = new Uint32Array(C + 1);
    for (let n = 0; n < C; n++) {
        if (!seen[n]) continue;
        for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e += s.ef) {
            if (s.dominating(e, n)) predStart[s.edgeTo(e) + 1]++;
        }
    }
    for (let i = 0; i < C; i++) predStart[i + 1] += predStart[i];
    const preds = new Int32Array(predStart[C]);
    const fill = predStart.slice(0, C);
    for (let n = 0; n < C; n++) {
        if (!seen[n]) continue;
        for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e += s.ef) {
            if (s.dominating(e, n)) preds[fill[s.edgeTo(e)]++] = n;
        }
    }

    // Immediate dominators by postorder number; the root has the highest.
    const root = post[0];
    const idomPost = new Int32Array(visited).fill(-1);
    idomPost[root] = root;
    for (let changed = true; changed;) {
        changed = false;
        for (let i = visited - 1; i >= 0; i--) {
            if (i === root) continue;
            const n = order[i];
            let best = -1;
            for (let p = predStart[n]; p < predStart[n + 1]; p++) {
                const q = post[preds[p]];
                if (q < 0 || idomPost[q] < 0) continue;
                if (best < 0) {
                    best = q;
                    continue;
                }
                let a = best;
                let b = q;
                while (a !== b) {
                    while (a < b) a = idomPost[a];
                    while (b < a) b = idomPost[b];
                }
                best = a;
            }
            if (best >= 0 && idomPost[i] !== best) {
                idomPost[i] = best;
                changed = true;
            }
        }
    }

    // Children come before their dominator in postorder, so one pass sums the subtrees.
    const retainedPost = new Float64Array(visited);
    for (let i = 0; i < visited; i++) retainedPost[i] += s.size(order[i]);
    for (let i = 0; i < visited; i++) {
        if (i !== root) retainedPost[idomPost[i]] += retainedPost[i];
    }
    return {
        retained: (n) => (post[n] < 0 ? 0 : retainedPost[post[n]]),
        idom: (n) => (post[n] < 0 || post[n] === root ? -1 : order[idomPost[post[n]]]),
        depth: (n) => {
            if (post[n] < 0) return -1;
            let d = 0;
            for (let i = post[n]; i !== root; i = idomPost[i]) d++;
            return d;
        },
    };
}

/**
 * A `JSProxy` node's target: V8 lists a proxy's fields as hidden edges in layout order (properties,
 * target, handler) and leaves out an empty properties store, so the target is the first hidden edge
 * to something other than an internal array (checked against Chrome 153 snapshots). -1 when none.
 */
function proxyTarget(s, n) {
    for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e += s.ef) {
        if (s.edgeType(e) === "hidden" && s.type(s.edgeTo(e)) !== "array") return s.edgeTo(e);
    }
    return -1;
}

/** Whether node `n` is a JS array whose elements are exactly 0, 1 and 2, all strings (`[name, path, ext]`). */
function isStringTriple(s, n) {
    if (n < 0 || s.type(n) !== "object" || s.name(n) !== "Array") return false;
    const seen = [false, false, false];
    for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e += s.ef) {
        if (s.edgeType(e) !== "element") continue;
        const index = Number(s.edgeName(e).slice(1, -1));
        const type = s.type(s.edgeTo(e));
        if (
            !(index <= 2) ||
            seen[index] ||
            (type !== "string" && type !== "concatenated string" && type !== "sliced string")
        ) {
            return false;
        }
        seen[index] = true;
    }
    return seen.every(Boolean);
}

const MB = 1024 * 1024;

/**
 * The numbers the heap memory plan's slices check (`docs/plan/heap-memory.md`):
 * - `proxies`: every `JSProxy`, and `tupleProxies`, those whose target is an array with string
 *   elements at 0, 1 and 2 and no other element edge (an asset tuple made a Svelte `$state` proxy;
 *   a snapshot shows no edge for a small-integer element, so `[a, b, c, 1]` would count too);
 * - `largeProxies`: proxies retaining at least `largeProxyBytes` (`count`), and `retainedBytes`, the
 *   retained size of the outermost ones (a large proxy inside another's dominator subtree is counted
 *   once, in its ancestor);
 * - `duplicateStrings`: strings of at least `largeStringBytes` that share their size and their first
 *   1,024 characters with another (a snapshot keeps no more of a string, so these are likely, not
 *   proven, copies of one text; `extraBytes` is what the extra copies would cost);
 * - `fontFaces`, `styleSheets`: Blink's `FontFace` and `CSSStyleSheet` objects.
 * Content is never reported, only sizes and counts.
 */
export function heapReport(s, { largeProxyBytes = 256 * 1024, largeStringBytes = MB } = {}) {
    let total = 0;
    let proxies = 0;
    let tupleProxies = 0;
    let fontFaces = 0;
    let styleSheets = 0;
    const proxyNodes = [];
    const strings = new Map();
    for (let n = 0; n < s.count; n++) {
        total += s.size(n);
        const type = s.type(n);
        if (type === "native") {
            const name = s.name(n);
            if (name === "system / JSProxy") {
                proxies++;
                proxyNodes.push(n);
                if (isStringTriple(s, proxyTarget(s, n))) tupleProxies++;
            } else if (name === "FontFace") {
                fontFaces++;
            } else if (name === "CSSStyleSheet") {
                styleSheets++;
            }
        } else if (type === "string" && s.size(n) >= largeStringBytes) {
            const hash = `${s.size(n)}:${createHash("sha1").update(s.name(n)).digest("hex")}`;
            const group = strings.get(hash) ?? { count: 0, bytes: s.size(n) };
            group.count++;
            strings.set(hash, group);
        }
    }
    const { retained, idom } = dominators(s);
    const large = new Set(proxyNodes.filter((n) => retained(n) >= largeProxyBytes));
    let largeBytes = 0;
    for (const n of large) {
        let nested = false;
        for (let up = idom(n); up > 0 && !nested; up = idom(up)) nested = large.has(up);
        if (!nested) largeBytes += retained(n);
    }
    const largeCount = large.size;
    let duplicateGroups = 0;
    let extraBytes = 0;
    for (const group of strings.values()) {
        if (group.count > 1) {
            duplicateGroups++;
            extraBytes += (group.count - 1) * group.bytes;
        }
    }
    return {
        nodes: s.count,
        totalBytes: total,
        proxies,
        tupleProxies,
        largeProxies: { count: largeCount, retainedBytes: largeBytes },
        duplicateStrings: { groups: duplicateGroups, extraBytes },
        fontFaces,
        styleSheets,
    };
}

export const formatMB = (bytes) => `${(bytes / MB).toFixed(2)} MB`;

function bump(map, key, size) {
    const entry = map.get(key);
    if (entry) {
        entry.count++;
        entry.bytes += size;
    } else {
        map.set(key, { count: 1, bytes: size });
    }
}

function sorted(map) {
    return [...map].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.bytes - a.bytes);
}
