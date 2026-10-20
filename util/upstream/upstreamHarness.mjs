// Loads a bounded part of upstream RisuAI's client code into plain Node, read from a pinned commit of an
// upstream checkout, so `checkBinCompat.mjs` can run upstream's own `.bin` database decoder and boot
// defaults on metatron's output without installing or starting the upstream app.
//
// - Sources come from `git show <UPSTREAM_COMMIT>:<path>`, so the checkout's HEAD and working tree do
//   not matter; only the pinned commit must exist in it.
// - `REAL` modules run as upstream wrote them (TypeScript transpiled with `typescript`, no Svelte
//   compiler: a rune evaluated at load or a `$state` read fails loudly).
// - `EXTRACT` modules are built from named upstream functions cut out of a browser-heavy module.
// - `OVERRIDES` give fixed values where a value matters (the web build's platform flags, the store
//   object, `uuid`).
// - Every other import is a recording stub: a callable Proxy whose property reads, writes, calls,
//   constructions, key enumeration and descriptor reads are recorded with their phase (except `then`).
//   A check fails on a recorded use it has not approved; this is not a full browser emulation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Upstream RisuAI commit the check reads (`git rev-parse HEAD` of the checkout it was written against). */
export const UPSTREAM_COMMIT = "669b12ceabe1c5066d3dadbe0973f2188d10cc97";
/**
 * Exact versions of the two libraries upstream's decoder uses, as upstream's `pnpm-lock.yaml` resolves
 * them for its root importer at `UPSTREAM_COMMIT` (the manifest says `msgpackr: 1.10.1`,
 * `fflate: ^0.8.2`). Re-check both when moving the pin.
 */
export const UPSTREAM_PACKAGES = { msgpackr: "1.10.1", fflate: "0.8.2" };

/** Upstream modules loaded as written: the decoder, `setDatabase`, `checkNewFormat`, and what they call. */
const REAL = new Set([
    "src/ts/storage/risuSave.ts",
    "src/ts/storage/database.svelte.ts",
    "src/ts/storage/defaultPrompts.ts",
    "src/ts/bootstrap.ts",
    "src/ts/util.ts",
    "src/ts/characters.ts",
    "src/ts/process/templates/templates.ts",
    "src/ts/gui/colorscheme.ts",
    "src/ts/process/memory/hypav3.ts",
    "src/ts/translator/presets.ts",
    "src/ts/chatLoadPages.ts",
    "src/ts/defaulthotkeys.ts",
    "src/ts/model/modellist.ts",
    "src/ts/model/types.ts",
    "src/ts/model/providers/openai.ts",
    "src/ts/model/providers/google.ts",
    "src/ts/model/providers/anthropic.ts",
]);

/** Private upstream functions a REAL module also exports here, for the boot pass. */
const EXTRA_EXPORTS = { "src/ts/bootstrap.ts": ["checkNewFormat", "assignIds"] };

/**
 * Named functions cut out of a module that cannot load outside the browser, with what they need.
 * The rest of such a module is stubbed.
 */
const EXTRACT = {
    "src/ts/globalApi.svelte.ts": {
        prelude: 'import { DBState } from "src/ts/stores.svelte";',
        functions: ["checkCharOrder"],
    },
    "src/ts/polyfill.ts": {
        // structuredClone handles every value a database holds; the rfdc fallback must never run.
        prelude: 'const rfdcClone = () => { throw new Error("harness: the rfdc fallback is not loaded"); };',
        functions: ["safeStructuredClone"],
    },
};

/**
 * Fixed values for some exports of a non-REAL module (a JavaScript expression each). `complete`: an
 * import of any other name is a harness error, not a stub. The platform flags are the web build's.
 */
const OVERRIDES = {
    "src/ts/platform.ts": {
        complete: true,
        values: {
            isTauri: "false",
            isNodeServer: "false",
            isWeb: "true",
            isMobile: "false",
            isFirefox: "false",
            isIOS: "() => false",
        },
    },
    "src/ts/stores.svelte.ts": { values: { DBState: "globalThis.__upstreamHarness.DBState" } },
    "pkg:uuid": {
        prelude: 'import { randomUUID } from "node:crypto";',
        values: { v4: "() => randomUUID()" },
    },
};

const STUB_ROOT = "upstream:/";
const MSGPACKR_URL = "upstream:/lib/msgpackr";

/**
 * Process-wide state the generated modules reach through `globalThis.__upstreamHarness`: the store
 * object, the stub factory, and the record of stub uses.
 */
function createHarnessState() {
    const state = {
        DBState: { db: undefined },
        phase: "load",
        uses: [],
        stub(label) {
            return makeStub(state, label);
        },
        record(label) {
            state.uses.push({ phase: state.phase, label });
        },
    };
    return state;
}

function makeStub(state, label) {
    const target = function () {};
    return new Proxy(target, {
        get(_target, prop) {
            if (prop === "then") return undefined;
            state.record(`${label}.${String(prop)}`);
            if (typeof prop === "symbol") {
                return prop === Symbol.toPrimitive ? () => `[stub ${label}]` : undefined;
            }
            return makeStub(state, `${label}.${prop}`);
        },
        set(_target, prop) {
            state.record(`${label}.${String(prop)}=`);
            return true;
        },
        has(_target, prop) {
            state.record(`${label} has ${String(prop)}`);
            return false;
        },
        ownKeys(target) {
            state.record(`${label} ownKeys`);
            return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
            state.record(`${label} descriptor ${String(prop)}`);
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        apply() {
            state.record(`${label}()`);
            return makeStub(state, `${label}()`);
        },
        construct() {
            state.record(`new ${label}`);
            return makeStub(state, `new ${label}`);
        },
    });
}

function git(upstreamDir, args) {
    return execFileSync("git", ["-C", upstreamDir, ...args], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/** The supplied package directory must hold exactly the pinned package and version. */
function checkPackage(dir, name) {
    if (!dir) throw new Error(`no ${name} package directory given`);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== UPSTREAM_PACKAGES[name]) {
        throw new Error(
            `${dir} holds ${manifest.name}@${manifest.version}, upstream ${UPSTREAM_COMMIT.slice(0, 8)} uses ${name}@${UPSTREAM_PACKAGES[name]}`,
        );
    }
    return path.resolve(dir);
}

function transpile(source, fileName) {
    const out = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            isolatedModules: true,
            useDefineForClassFields: true,
        },
    });
    const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
        throw new Error(`${fileName}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, "\n")}`);
    }
    return out.outputText;
}

/** Each runtime import of an emitted module: the target specifier and the names it reads. */
function importsOf(js, fileName) {
    const sf = ts.createSourceFile(fileName, js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const found = [];
    const namespaces = new Map();
    for (const statement of sf.statements) {
        if (ts.isImportDeclaration(statement)) {
            const spec = statement.moduleSpecifier.text;
            const names = [];
            const clause = statement.importClause;
            if (clause?.name) names.push("default");
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
            }
            if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, names);
            found.push({ spec, names });
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
            const spec = statement.moduleSpecifier.text;
            const names = [];
            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    names.push((element.propertyName ?? element.name).text);
                }
            } else {
                names.push("*");
            }
            found.push({ spec, names });
        }
    }
    // `import * as ns`: the members read as `ns.member`.
    if (namespaces.size > 0) {
        const visit = (node) => {
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                namespaces.has(node.expression.text)
            ) {
                namespaces.get(node.expression.text).push(node.name.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return found;
}

/** `functions` cut out of `source` (TypeScript), each with its `export`. */
function extractFunctions(source, fileName, functions) {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const parts = [];
    for (const name of functions) {
        const node = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
        if (!node) throw new Error(`${fileName}: function ${name} not found at ${UPSTREAM_COMMIT.slice(0, 8)}`);
        const text = source.slice(node.getStart(sf), node.end);
        parts.push(text.startsWith("export ") ? text : `export ${text}`);
    }
    return parts.join("\n\n");
}

/**
 * Registers the loader and imports upstream's decoder and boot functions. One call per process: the
 * hooks stay registered, and they act only on upstream modules and the harness's own.
 *
 * @param {{ upstreamDir: string, msgpackrDir: string, fflateDir: string }} options
 */
export async function loadUpstream({ upstreamDir, msgpackrDir, fflateDir }) {
    if (!upstreamDir) throw new Error("no upstream checkout given");
    try {
        git(upstreamDir, ["cat-file", "-e", `${UPSTREAM_COMMIT}^{commit}`]);
    } catch {
        throw new Error(`${upstreamDir} does not contain upstream commit ${UPSTREAM_COMMIT}`);
    }
    const msgpackr = checkPackage(msgpackrDir, "msgpackr");
    const fflate = checkPackage(fflateDir, "fflate");
    const fflateUrl = pathToFileURL(path.join(fflate, "esm/index.mjs")).href;
    const tree = new Set(git(upstreamDir, ["ls-tree", "-r", "--name-only", UPSTREAM_COMMIT, "--", "src"]).split("\n"));
    const sources = new Map();
    const readSource = (id) => {
        if (!sources.has(id)) sources.set(id, git(upstreamDir, ["show", `${UPSTREAM_COMMIT}:${id}`]));
        return sources.get(id);
    };

    /** An upstream file path for an import from `parentId`, or a `pkg:` id for a package. */
    const resolveId = (spec, parentId) => {
        let p;
        if (spec.startsWith("./") || spec.startsWith("../")) p = path.posix.join(path.posix.dirname(parentId), spec);
        else if (spec.startsWith("src/")) p = path.posix.normalize(spec);
        else return `pkg:${spec}`;
        for (const candidate of [p, `${p}.ts`, `${p}.js`, `${p}/index.ts`]) {
            if (tree.has(candidate)) return candidate;
        }
        return p;
    };

    // Emitted JavaScript per loadable module, and the names every importer reads from each other module
    // (collected before anything links: ESM checks a module's exports before running any body).
    const emitted = new Map();
    const wanted = new Map();
    const want = (id, names) => {
        if (!wanted.has(id)) wanted.set(id, new Set());
        for (const name of names) wanted.get(id).add(name);
    };
    const emit = (id) => {
        if (REAL.has(id)) {
            let js = transpile(readSource(id), id);
            if (EXTRA_EXPORTS[id]) js += `\nexport { ${EXTRA_EXPORTS[id].join(", ")} };\n`;
            return js;
        }
        const extract = EXTRACT[id];
        return transpile(`${extract.prelude}\n${extractFunctions(readSource(id), id, extract.functions)}\n`, id);
    };
    const queue = [...REAL, ...Object.keys(EXTRACT)];
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        if (emitted.has(id)) continue;
        const js = emit(id);
        emitted.set(id, js);
        for (const { spec, names } of importsOf(js, id)) {
            const target = resolveId(spec, id);
            want(target, names);
            if ((REAL.has(target) || EXTRACT[target]) && !emitted.has(target)) queue.push(target);
        }
    }

    const harness = createHarnessState();
    globalThis.__upstreamHarness = harness;

    /** A module whose exports are overrides and recording stubs. */
    const stubModule = (id, names) => {
        const override = OVERRIDES[id] ?? { values: {} };
        const extract = EXTRACT[id];
        const own = new Set(extract ? extract.functions : []);
        const lines = ["const H = globalThis.__upstreamHarness;"];
        if (override.prelude) lines.push(override.prelude);
        if (extract) lines.push(emitted.get(id));
        for (const name of names) {
            if (name === "*") throw new Error(`harness: export * from ${id}, which is not a REAL module`);
            if (own.has(name)) continue;
            const value = override.values[name];
            if (value === undefined && override.complete) throw new Error(`harness: ${id} has no override for ${name}`);
            const expr = value ?? `H.stub(${JSON.stringify(`${id}#${name}`)})`;
            lines.push(name === "default" ? `export default (${expr});` : `export const ${name} = (${expr});`);
        }
        return lines.join("\n");
    };

    const toUrl = (id) => {
        if (id === "pkg:msgpackr/index-no-eval") return MSGPACKR_URL;
        if (id === "pkg:fflate") return fflateUrl;
        return `${STUB_ROOT}${id}`;
    };

    registerHooks({
        resolve(specifier, context, nextResolve) {
            const parent = context.parentURL;
            if (parent?.startsWith(STUB_ROOT) && !specifier.startsWith("node:")) {
                const parentId = parent.slice(STUB_ROOT.length);
                const id = resolveId(specifier, parentId);
                const url = toUrl(id);
                if (url === `${STUB_ROOT}${id}` && !emitted.has(id) && !wanted.has(id)) {
                    // A dynamic import nothing imports statically: a module of one recorded default.
                    harness.record(`import(${id})`);
                }
                return { url, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
            if (url === MSGPACKR_URL) {
                const names = [...(wanted.get("pkg:msgpackr/index-no-eval") ?? [])];
                const lines = [
                    'import { createRequire } from "node:module";',
                    `const m = createRequire(${JSON.stringify(pathToFileURL(path.join(msgpackr, "package.json")).href)})(${JSON.stringify(path.join(msgpackr, "dist/index-no-eval.cjs"))});`,
                    ...names.map((name) =>
                        name === "default" ? "export default m;" : `export const ${name} = m.${name};`,
                    ),
                ];
                return { format: "module", source: lines.join("\n"), shortCircuit: true };
            }
            if (url.startsWith(STUB_ROOT)) {
                const id = url.slice(STUB_ROOT.length);
                const source = REAL.has(id) ? emitted.get(id) : stubModule(id, [...(wanted.get(id) ?? ["default"])]);
                return { format: "module", source, shortCircuit: true };
            }
            return nextLoad(url, context);
        },
    });

    const load = await runPhase(harness, "load", async () => ({
        risuSave: await import(`${STUB_ROOT}src/ts/storage/risuSave.ts`),
        database: await import(`${STUB_ROOT}src/ts/storage/database.svelte.ts`),
        bootstrap: await import(`${STUB_ROOT}src/ts/bootstrap.ts`),
    }));
    if (load.threw) throw load.error;
    const { risuSave, database, bootstrap } = load.value;
    return {
        harness,
        load: { consoleCounts: load.consoleCounts, uses: load.uses },
        decodeRisuSave: risuSave.decodeRisuSave,
        setDatabase: database.setDatabase,
        checkNewFormat: bootstrap.checkNewFormat,
        assignIds: bootstrap.assignIds,
        realModules: [...REAL],
        extracted: Object.entries(EXTRACT).map(([id, { functions }]) => `${id}: ${functions.join(", ")}`),
        overridden: Object.keys(OVERRIDES),
        stubbedModules: [...wanted.keys()].filter((id) => !REAL.has(id) && !EXTRACT[id]).sort(),
    };
}

/**
 * Runs `fn` with the console captured (nothing reaches the terminal) and stub uses attributed to
 * `phase`. Resolves to `{ value, threw, error, consoleCounts, uses }`; `error` is the thrown value, kept so
 * the caller decides what it may print.
 */
export async function runPhase(harness, phase, fn) {
    const methods = ["log", "info", "warn", "error", "debug", "trace"];
    const saved = Object.fromEntries(methods.map((m) => [m, console[m]]));
    const consoleCounts = Object.fromEntries(methods.map((m) => [m, 0]));
    for (const m of methods) console[m] = () => consoleCounts[m]++;
    const before = harness.uses.length;
    harness.phase = phase;
    try {
        return { value: await fn(), threw: false, error: undefined, consoleCounts, uses: harness.uses.slice(before) };
    } catch (error) {
        return { value: undefined, threw: true, error, consoleCounts, uses: harness.uses.slice(before) };
    } finally {
        harness.phase = "idle";
        for (const m of methods) console[m] = saved[m];
    }
}
