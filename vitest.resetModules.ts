import { vi } from "vitest";

// `vi.resetModules()` for this repository: it keeps `node_modules` and `shared/` modules evaluated and
// re-evaluates the rest, where Vitest's own re-evaluates everything.
//
// Why: about 100 test files reset the module graph before each test to get fresh client state (the
// storage tests' `boot()`), and a third of what one reset re-evaluates is the Svelte runtime and
// `shared/`, which hold no state a test needs fresh. Keeping them takes about 4 s off the gate
// (`docs/reports/measurements/toolchain/test-gate-cpu-profile-2026-11-12.md`).
//
// What makes it safe:
// - Nothing kept imports anything reset: packages import packages, and `shared/` imports only itself and
//   packages (`STRUCTURE.md` T2). So no kept module holds a stale instance of a reset one.
// - A kept module that was bound to a mock stays right only while the mock registry is unchanged.
//   `vi.mock` is hoisted above every import, so it is; `vi.doMock` and `vi.doUnmock` change the registry
//   mid-file, so the reset after one of them is Vitest's full reset.
// - `shared/` test helpers (`tests/` directories, `*.test.ts`) are not kept: a fixture may hold state.
//
// What a test must know: module-level state inside a package or `shared/` (the Svelte runtime, a
// memoization cache) now outlives `vi.resetModules()` within a test file.
//
// This reads Vitest's worker state (`__vitest_worker__`), which is not public API. When its shape is not
// the expected one, nothing is installed and Vitest's reset stays; `vitest.resetModules.test.ts` then
// fails, so an upgrade that changes the shape is noticed.

/** The fields Vitest's reset clears on a module of its runner (`resetModules` in `vitest/dist/chunks/utils.*.js`). */
type RunnerModule = { promise?: unknown; exports?: unknown; evaluated?: boolean };
type WorkerState = {
    config?: { root?: unknown };
    evaluatedModules?: { idToModuleMap?: Map<string, RunnerModule> };
};

const installedKey = Symbol.for("risu.resetModules.installed");

/** Whether a reset keeps module `id` (an absolute file path, perhaps with a query) of the project at `root`. */
export function keepsModule(id: string, root: string): boolean {
    if (id.includes("/node_modules/")) {
        return true;
    }
    const shared = `${root}/shared/`;
    return id.startsWith(shared) && !/\/tests\/|\.test\.ts/.test(id.slice(shared.length - 1));
}

/** Replaces `vi.resetModules` with the selective reset; a second call (a second setup run) does nothing. */
export function installSelectiveModuleReset(): void {
    if (Reflect.get(vi, installedKey)) {
        return;
    }
    const worker = Reflect.get(globalThis, "__vitest_worker__") as WorkerState | undefined;
    const modules = worker?.evaluatedModules?.idToModuleMap;
    const root = worker?.config?.root;
    if (typeof modules?.forEach !== "function" || typeof root !== "string") {
        return;
    }

    const resetAll = vi.resetModules.bind(vi);
    let registryChanged = false;
    const noting = <T extends (...args: never[]) => unknown>(original: T): T =>
        ((...args: never[]) => {
            registryChanged = true;
            return original.apply(vi, args);
        }) as T;
    vi.doMock = noting(vi.doMock);
    vi.doUnmock = noting(vi.doUnmock);

    vi.resetModules = () => {
        if (registryChanged) {
            registryChanged = false;
            return resetAll();
        }
        // Vitest's reset runs unchanged (it has its own skip rules); the kept modules get back what it cleared.
        const kept: [RunnerModule, unknown, unknown][] = [];
        modules.forEach((module, id) => {
            if (module.evaluated && keepsModule(id, root)) {
                kept.push([module, module.promise, module.exports]);
            }
        });
        resetAll();
        for (const [module, promise, exports] of kept) {
            module.promise = promise;
            module.exports = exports;
            module.evaluated = true;
        }
        return vi;
    };
    Reflect.set(vi, installedKey, true);
}
