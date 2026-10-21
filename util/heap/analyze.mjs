// Command-line analysis of V8 `.heapsnapshot` files (`util/heap/snapshot.mjs`).
//
// Usage (a 500 MB snapshot needs a large heap: `node --max-old-space-size=16000 ...`):
//   node util/heap/analyze.mjs summary <snapshot> [--top 30]
//       totals by node type and by constructor
//   node util/heap/analyze.mjs diff <before> <after> [--top 30]
//       what the second snapshot of the same page added and freed, by node id
//   node util/heap/analyze.mjs strings <snapshot> [--min-mb 1] [--prefix 0] [--keys]
//       large strings with their shortest retainer path (content shown only with --prefix N)
//   node util/heap/analyze.mjs paths <snapshot> <label> [--depth 7] [--top 12] [--prefix 0] [--keys]
//       nodes with this label (`native:system / JSProxy`, `object:Map`, `string`, ...) grouped by
//       their retainer path's first `--depth` steps (indices folded), with one full sample each
//   node util/heap/analyze.mjs top <snapshot> [--depth 4] [--top 40]
//       the largest retainers (dominator retained size) at most `--depth` levels below the root
//   node util/heap/analyze.mjs report <snapshot> [--json]
//       the heap numbers the measurements check (`heapReport`)
//
// Snapshots of user data stay local: nothing here prints string content unless asked (--prefix N),
// and no property key unless asked (--keys): a key can be user text, so without it a property edge
// shows as `<key:LENGTH>`. Indices, closure variable names (code) and V8's own internal edge names
// are always shown; an internal or weak edge name of another shape is redacted too. Paths group by
// their real names either way.
import {
    diffSnapshots,
    dominators,
    formatMB,
    heapReport,
    loadSnapshot,
    nodeKey,
    retainers,
    summarize,
} from "./snapshot.mjs";

const [command, ...rest] = process.argv.slice(2);
const positional = [];
const options = {};
for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
        const key = rest[i].slice(2);
        options[key] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    } else {
        positional.push(rest[i]);
    }
}
const num = (key, fallback) => (options[key] === undefined ? fallback : Number(options[key]));

const label = (s, n, prefix = 0) => {
    if (s.type(n) === "string") {
        return prefix > 0 ? `string ${JSON.stringify(s.name(n).slice(0, prefix))}` : `string(${formatMB(s.size(n))})`;
    }
    return nodeKey(s, n).slice(0, 70);
};
// The names V8 itself gives internal and weak edges (native fields, WeakMap entries).
const V8_EDGE_NAMES = [
    /^\d+$/,
    /^[A-Za-z_$][\w$]{0,63}$/,
    /^\d+ \/ [\w:]{1,80}$/,
    /^\d+ \/ part of key \([\w/ .:<>-]*? @\d+\) -> value \([\w/ .:<>-]*? @\d+\) pair in WeakMap \(table @\d+\)$/,
];
const keys = options.keys === "true";
const edgeLabel = (s, edge, reveal) => {
    const name = s.edgeName(edge);
    if (reveal) return name;
    switch (s.edgeType(edge)) {
        case "element":
        case "hidden":
        case "context":
            return name;
        case "internal":
        case "weak":
        case "shortcut":
            return /^\[\d+\]$/.test(name) || V8_EDGE_NAMES.some((pattern) => pattern.test(name))
                ? name
                : `<key:${name.length}>`;
        default:
            return `<key:${name.length}>`;
    }
};
const describePath = (s, steps, { fold = false, prefix = 0, reveal = keys } = {}) =>
    steps === null
        ? "(unreachable)"
        : steps
              .map(({ node, edge }) => {
                  let name = edgeLabel(s, edge, reveal);
                  if (fold && /^\[\d+\]$/.test(name)) name = "[i]";
                  if (fold && /^\d+$/.test(name)) name = "#";
                  return `${label(s, node, prefix)} <-${name}-`;
              })
              .join(" ");
const rows = (groups, top) =>
    groups
        .slice(0, top)
        .map((g) => `  ${formatMB(g.bytes).padStart(10)}  ${String(g.count).padStart(8)}  ${g.key.slice(0, 90)}`)
        .join("\n");

switch (command) {
    case "summary": {
        const s = loadSnapshot(positional[0]);
        const summary = summarize(s);
        console.log(`nodes ${summary.nodes}, self size ${formatMB(summary.total)}`);
        console.log("--- by type\n" + rows(summary.byType, 20));
        console.log("--- by constructor\n" + rows(summary.byKey, num("top", 30)));
        break;
    }
    case "diff": {
        const a = loadSnapshot(positional[0]);
        const b = loadSnapshot(positional[1]);
        const { added, freed } = diffSnapshots(a, b);
        console.log(`added ${formatMB(added.total)}, freed ${formatMB(freed.total)}`);
        console.log("--- added\n" + rows(added.groups, num("top", 30)));
        console.log("--- freed\n" + rows(freed.groups, num("top", 30)));
        break;
    }
    case "strings": {
        const s = loadSnapshot(positional[0]);
        const { pathOf } = retainers(s);
        const min = num("min-mb", 1) * 1024 * 1024;
        const prefix = num("prefix", 0);
        const big = [];
        for (let n = 0; n < s.count; n++) if (s.type(n) === "string" && s.size(n) >= min) big.push(n);
        big.sort((x, y) => s.size(y) - s.size(x));
        for (const n of big) {
            console.log(`${formatMB(s.size(n))} id ${s.id(n)} ${label(s, n, prefix)}`);
            console.log(`    ${describePath(s, pathOf(n, 14), { prefix })}\n`);
        }
        break;
    }
    case "paths": {
        const s = loadSnapshot(positional[0]);
        const want = positional[1];
        const { pathOf } = retainers(s);
        const depth = num("depth", 7);
        const prefix = num("prefix", 0);
        const groups = new Map();
        let count = 0;
        let bytes = 0;
        for (let n = 0; n < s.count; n++) {
            if (nodeKey(s, n) !== want) continue;
            count++;
            bytes += s.size(n);
            // Grouped by the real names; shown redacted unless --keys.
            const steps = pathOf(n, depth);
            const key = describePath(s, steps, { fold: true, reveal: true });
            const group = groups.get(key) ?? {
                count: 0,
                sample: n,
                shown: describePath(s, steps, { fold: true, prefix }),
            };
            group.count++;
            groups.set(key, group);
        }
        console.log(`${want}: ${count} nodes, self size ${formatMB(bytes)}`);
        for (const group of [...groups.values()].sort((x, y) => y.count - x.count).slice(0, num("top", 12))) {
            console.log(
                `${group.count}\n    ${group.shown}\n    sample: ${describePath(s, pathOf(group.sample, 30), { prefix })}\n`,
            );
        }
        break;
    }
    case "top": {
        const s = loadSnapshot(positional[0]);
        const dom = dominators(s);
        const maxDepth = num("depth", 4);
        const found = [];
        for (let n = 0; n < s.count; n++) {
            if (dom.retained(n) >= 1024 * 1024 && dom.depth(n) <= maxDepth) found.push(n);
        }
        found.sort((x, y) => dom.retained(y) - dom.retained(x));
        for (const n of found.slice(0, num("top", 40))) {
            console.log(`${formatMB(dom.retained(n)).padStart(10)}  d${dom.depth(n)}  ${label(s, n)}  id ${s.id(n)}`);
        }
        break;
    }
    case "report": {
        const report = heapReport(loadSnapshot(positional[0]));
        if (options.json) {
            console.log(JSON.stringify(report));
        } else {
            console.log(`self size ${formatMB(report.totalBytes)} in ${report.nodes} nodes`);
            console.log(`proxies ${report.proxies} (asset tuples ${report.tupleProxies})`);
            console.log(
                `large proxies ${report.largeProxies.count}, the outermost retaining ${formatMB(report.largeProxies.retainedBytes)}`,
            );
            console.log(
                `likely duplicate large strings (same size and first 1,024 characters): ${report.duplicateStrings.groups} groups, extra ${formatMB(report.duplicateStrings.extraBytes)}`,
            );
            console.log(`FontFace ${report.fontFaces}, CSSStyleSheet ${report.styleSheets}`);
        }
        break;
    }
    default:
        console.error("usage: node util/heap/analyze.mjs summary|diff|strings|paths|top|report <snapshot> ...");
        process.exit(2);
}
