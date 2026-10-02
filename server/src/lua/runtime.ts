import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { LuaFactory, type LuaEngine } from "wasmoon";

/**
 * The Lua engine lifecycle inside one script worker, ported from the previous attempt's runtime
 * (`risuai-fastify` `server/fastify/src/prompt/luaRuntime.ts`) without its bindings. The worker owns
 * one wasm module and runs one Lua task at a time.
 *
 * The budget: one count hook per wasm module, installed on every engine's states, raises inside
 * the Lua state that runs (`L`) when the run is aborted or its budget is spent. Every thread and
 * coroutine inherits it, and it is never freed, so a coroutine resumed after an `:await()` always
 * points at a live hook. wasmoon's own limits (`functionTimeout`, `thread.run({ timeout })`) are not
 * used: their hooks capture the first deadline, raise on the installing thread instead of the
 * running one, and leave their functions behind. The budget is the worker thread's busy time
 * (`eventLoopUtilization`) since the run started, less its synchronous host calls and the regexes
 * its host calls spawned; a host wait leaves the thread idle, so it is not charged. A C-level
 * runaway (a pathological pattern) never reaches the hook; the pool's watchdog terminates the worker.
 */
export const DEFAULT_LUA_CPU_MS = 3000;
export const LUA_MEMORY_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_SLEEP_MS = 2000;
export const MAX_TOTAL_SLEEP_MS = 6000;
export const MAX_HOST_ARG_CHARS = 16 * 1024 * 1024;
export const MAX_OUTSTANDING_HOST_CALLS = 64;
export const MAX_LOG_MESSAGE_CHARS = 64 * 1024;
export const MAX_LOG_CHARS_PER_RUN = 1024 * 1024;
export const MAX_RESULT_JSON_CHARS = 16 * 1024 * 1024;
export const LUA_BUDGET_MESSAGE = "Lua CPU budget exceeded (timeout)";
const PREPARED_ENGINE_TARGET = 2;
const HOOK_INSTRUCTION_COUNT = 1000;
const LUA_MASK_COUNT = 8;

export type LuaIdentity = {
    characterId: string | null;
    chatId: string | null;
    presetId: string | null;
    personaId: string | null;
};

/** What a host call's first argument grants, from the run's access keys (`scriptings.ts` id sets). */
export type HostAccess = "safe" | "lowLevel" | "editDisplay" | null;

export type LuaRunInput = {
    code: string;
    mode: string;
    data?: unknown;
    meta?: unknown;
    lowLevelAccess?: boolean;
    identity: LuaIdentity;
    /** The CPU budget of this run (at most the per-run limit, less when the job's budget is low). */
    cpuMs: number;
    /** Host functions the caller serves, by name: awaited (`fn(...):await()`) or synchronous. */
    asyncHost?: string[];
    syncHost?: string[];
};

export type LuaRunOutput = {
    res: unknown;
    stopSending: boolean;
    error?: string;
    /**
     * Where `error` came from: loading the code (its top level), as the client's `doString` before
     * its dispatch catch, or the dispatched handler.
     */
    failedAt?: "load" | "dispatch";
    timedOut?: boolean;
    aborted?: boolean;
    cpuMs: number;
    memory: { used: number; max: number };
};

export type LuaRunHooks = {
    callAsync(name: string, args: unknown[], access: HostAccess): Promise<unknown>;
    callSync(name: string, args: unknown[], access: HostAccess): unknown;
    log(value: string): void;
    /** True once the run is aborted (the abort message or the shared abort flag). */
    aborted(): boolean;
};

export class LuaAbortError extends Error {
    constructor() {
        super("request aborted");
    }
}

class LuaBudgetError extends Error {
    constructor() {
        super(LUA_BUDGET_MESSAGE);
    }
}

type Budget = { cpuMs: number; startActive: number; excludedMs: number; aborted: () => boolean };

type RunState = {
    hooks: LuaRunHooks;
    budget: Budget;
    safeIds: Set<string>;
    lowLevelIds: Set<string>;
    editDisplayIds: Set<string>;
    stopSending: boolean;
    sleptMs: number;
    logChars: number;
    outstanding: number;
};

type PreparedEngine = { engine: LuaEngine; bind: (state: RunState) => void };

/** The parts of wasmoon 1.16's C API the hook needs; not in its public types. */
type LuaWasmInternals = {
    module: { addFunction(fn: (L: number, ar: number) => void, signature: string): number };
    lua_pushstring(L: number, s: string): void;
    lua_error(L: number): number;
    lua_sethook(L: number, fn: number | null, mask: number, count: number): void;
};

const activeMs = (): number => performance.eventLoopUtilization().active;

type PushThread = { address: number; lua: LuaWasmInternals };
type PushExtension = {
    name?: string;
    pushValue(thread: PushThread, decoration: { target: unknown }, userdata?: unknown): boolean;
    isType(): boolean;
    close(): void;
};
type ExtensionHost = {
    typeExtensions: Array<{ extension: PushExtension }>;
    registerTypeExtension(priority: number, extension: PushExtension): void;
};

/** Above wasmoon's own extensions (the highest is the promise one, at 5). */
const VALUE_GUARD_PRIORITY = 10;

/**
 * Nothing that enters Lua refers to a worker JS object. With wasmoon's proxy extension (the
 * default), an object pushed to Lua is a live proxy, and through `__proto__` a run could change
 * `Object.prototype` for every later run on the worker. Every push goes through this guard first:
 * an error, thrown by a host function or by wasmoon itself, or a rejection, becomes its message
 * string (no stack, so no server paths); any other object or array becomes a copied Lua table,
 * whose values pass the guard again. Promises and functions keep wasmoon's handling.
 */
function installValueGuard(engine: LuaEngine): void {
    const host = engine.global as unknown as ExtensionHost;
    const table = host.typeExtensions.find(({ extension }) => extension.name === "js_table")?.extension;
    if (!table) {
        throw new Error("wasmoon table extension not found");
    }
    host.registerTypeExtension(VALUE_GUARD_PRIORITY, {
        pushValue(thread, { target }, userdata) {
            if (typeof target !== "object" || target === null) {
                return false;
            }
            if (target instanceof Error) {
                thread.lua.lua_pushstring(thread.address, String(target.message));
                return true;
            }
            if (Promise.resolve(target) === target || typeof (target as { then?: unknown }).then === "function") {
                return false;
            }
            return table.pushValue(thread, { target }, userdata);
        },
        isType: () => false,
        close: () => {},
    });
}

/**
 * Runs before the prelude in every server engine, stripping the libraries in place (the global
 * tables are the ones in `package.loaded`). In Node, wasmoon's `os.execute` and `io.popen` reach
 * `child_process`, `io` reaches the wasm module's in-memory file system (which the one-use engines
 * of a worker share), `debug` reaches the registry, hooks, and upvalues, and `load` accepts
 * precompiled chunks, which can corrupt the Lua heap. So `io` goes, `debug` keeps only `traceback`,
 * `os` keeps its clock and date functions, `require` finds only modules already loaded (`json`),
 * `load` takes text chunks only, and `print` writes to the log sink.
 */
export const LUA_HARDENING = `
require("json")
package.searchers = { package.searchers[1] }
package.path = ""
package.cpath = ""
package.loadlib = nil
package.searchpath = nil
io = nil
package.loaded.io = nil
local traceback = debug.traceback
debug = { traceback = traceback }
package.loaded.debug = debug
os.execute = nil
os.exit = nil
os.getenv = nil
os.remove = nil
os.rename = nil
os.tmpname = nil
os.setlocale = nil
string.dump = nil
dofile = nil
loadfile = nil
local rawload = load
load = function(chunk, name, mode, ...)
    if select("#", ...) > 0 then
        return rawload(chunk, name, "t", ...)
    end
    return rawload(chunk, name, "t")
end
local logLine = printMain
printMain = nil
print = function(...)
    local parts = {}
    for i = 1, select("#", ...) do
        parts[i] = tostring((select(i, ...)))
    end
    logLine(table.concat(parts, "\\t"))
end
`;

/**
 * The client's `luaCodeWrapper` (`src/ts/process/scriptings.ts`) without the trailing user code,
 * plus the server's JSON wrappers of the table-taking functions.
 */
export const LUA_PRELUDE = `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end


function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

-- Server additions (Phase 5 slice 8a): host calls carry primitives only, so the client functions
-- that take or return a table cross as JSON here; the public names and their returns are the
-- client's. A refused key returns nil at once where the client does (the host checks again).
local function __safeKey(id)
    local access = __risuAccess(id)
    return access == "safe" or access == "lowLevel"
end

function alertInput(id, value)
    if not __safeKey(id) then
        return nil
    end
    return alertInputMain(id, value)
end

function alertSelect(id, value)
    if not __safeKey(id) then
        return nil
    end
    return alertSelectMain(id, json.encode(value))
end

function alertConfirm(id, value)
    if not __safeKey(id) then
        return nil
    end
    return alertConfirmMain(id, value)
end

function upsertLocalLoreBook(id, name, content, options)
    return upsertLocalLoreBookMain(id, name, content, json.encode(options))
end

-- A host answer that crosses as JSON, as a promise of its decoded value. A refused call answers nil,
-- and nil stays nil for the awaiter: resolving a Lua-made promise with an explicit nil would hand the
-- script a null userdata, which is not what the client's functions give.
local function __decoded(promise)
    return Promise.create(function(resolve, reject)
        promise:next(function(result)
            if result == nil then
                resolve()
            else
                resolve(json.decode(result))
            end
        end, reject)
    end)
end

function similarity(id, source, value)
    return __decoded(similarityMain(id, source, json.encode(value)))
end

function simpleLLM(id, prompt)
    return __decoded(simpleLLMMain(id, prompt))
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end

    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end

    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end

    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end

    throw('Invalid type')
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__"..name
    return setChatVarChanged(id, escapedName, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)
`;

export function isLuaTimeoutError(error: unknown): boolean {
    return /timeout/i.test(error instanceof Error ? error.message : String(error));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Host calls carry only primitives: a Lua table arrives as a proxy, which cannot cross a thread. */
function checkHostArgs(name: string, args: unknown[]): void {
    let chars = 0;
    for (const arg of args) {
        if (typeof arg === "string") {
            chars += arg.length;
        } else if (arg !== null && arg !== undefined && typeof arg !== "number" && typeof arg !== "boolean") {
            throw new Error(`${name}: host function arguments must be strings, numbers, booleans, or nil`);
        }
    }
    if (chars > MAX_HOST_ARG_CHARS) {
        throw new Error(`${name}: host function arguments too large`);
    }
}

function isPrimitive(value: unknown): boolean {
    return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value);
}

/** A result crosses the worker boundary by structured clone: a Lua table proxy does not, so it is dropped. */
function plain(value: unknown): unknown {
    return isPrimitive(value) ? value : undefined;
}

/**
 * What enters Lua from JS is a primitive too. With `injectObjects`, a JS object or array reaches
 * Lua as a live proxy of the worker's own object, and through `__proto__` a run could change
 * `Object.prototype` for every later run on the worker. Structured data crosses as a JSON string,
 * as the client prelude's `*Main` functions already expect.
 */
function primitiveIn(name: string, value: unknown): unknown {
    if (!isPrimitive(value)) {
        throw new Error(`${name}: a value passed to Lua must be a string, number, boolean, or nil`);
    }
    return value;
}

/** One worker's runtime: a factory with `json.lua` mounted and a pool of prepared one-use engines. */
export function createLuaRuntime(options: { jsonLua: string }) {
    let factoryPromise: Promise<LuaFactory> | null = null;
    const prepared: PreparedEngine[] = [];
    // Pending while an engine boots; a run does not start while it is held, and no boot overlaps a run.
    let bootGate: Promise<void> | null = null;
    let running = false;
    // What the hook charges: the active run's budget, or a boot's while an engine prepares.
    let current: Budget | null = null;
    let fault: ((error: unknown) => void) | null = null;
    let hook: number | null = null;

    function factory(): Promise<LuaFactory> {
        factoryPromise ??= (async () => {
            const created = new LuaFactory();
            await created.mountFile("json.lua", options.jsonLua);
            return created;
        })().catch((error: unknown) => {
            factoryPromise = null;
            throw error;
        });
        return factoryPromise;
    }

    /** Installs the module's one hook on the engine's main state and its callback context. */
    function installHook(engine: LuaEngine): void {
        const lua = (engine.global as unknown as { lua: LuaWasmInternals }).lua;
        hook ??= lua.module.addFunction((L) => {
            const budget = current;
            if (!budget) {
                return;
            }
            if (budget.aborted()) {
                lua.lua_pushstring(L, "request aborted");
                lua.lua_error(L);
            } else if (activeMs() - budget.startActive - budget.excludedMs > budget.cpuMs) {
                lua.lua_pushstring(L, LUA_BUDGET_MESSAGE);
                lua.lua_error(L);
            }
        }, "vii");
        // The function type extension's callback context is the parent of every JS-to-Lua call
        // thread; a thread inherits its parent's hook when it is created.
        const extensions = (engine.global as unknown as { typeExtensions: Array<{ extension: unknown }> })
            .typeExtensions;
        const states = [engine.global.address];
        for (const { extension } of extensions) {
            const context = (extension as { callbackContext?: { address: number } }).callbackContext;
            if (context) {
                states.push(context.address);
            }
        }
        for (const state of states) {
            lua.lua_sethook(state, hook, LUA_MASK_COUNT, HOOK_INSTRUCTION_COUNT);
        }
    }

    async function createPrepared(): Promise<PreparedEngine> {
        const engine = await (await factory()).createEngine({ injectObjects: true, traceAllocations: true });
        const previous = current;
        current = { cpuMs: DEFAULT_LUA_CPU_MS, startActive: activeMs(), excludedMs: 0, aborted: () => false };
        try {
            engine.global.setMemoryMax(LUA_MEMORY_MAX_BYTES);
            installValueGuard(engine);
            installHook(engine);
            const bind = declareBuiltins(engine);
            await runChunk(engine, LUA_HARDENING);
            await runChunk(engine, LUA_PRELUDE);
            return { engine, bind };
        } catch (error) {
            engine.global.close();
            throw error;
        } finally {
            current = previous;
        }
    }

    function refill(): void {
        if (running || bootGate || prepared.length >= PREPARED_ENGINE_TARGET) {
            return;
        }
        bootGate = (async () => {
            try {
                while (prepared.length < PREPARED_ENGINE_TARGET && !running) {
                    prepared.push(await createPrepared());
                }
            } catch {
                // A failed boot leaves the next run to boot its own engine.
            } finally {
                bootGate = null;
            }
        })();
    }

    async function acquire(): Promise<PreparedEngine> {
        while (bootGate) {
            await bootGate;
        }
        return prepared.shift() ?? (await createPrepared());
    }

    async function run(input: LuaRunInput, hooks: LuaRunHooks): Promise<LuaRunOutput> {
        if (running) {
            throw new Error("A Lua run is already active in this worker");
        }
        running = true;
        const budget: Budget = { cpuMs: input.cpuMs, startActive: activeMs(), excludedMs: 0, aborted: hooks.aborted };
        const state: RunState = {
            hooks,
            budget,
            safeIds: new Set(),
            lowLevelIds: new Set(),
            editDisplayIds: new Set(),
            stopSending: false,
            sleptMs: 0,
            logChars: 0,
            outstanding: 0,
        };
        const result: LuaRunOutput = {
            res: undefined,
            stopSending: false,
            cpuMs: 0,
            memory: { used: 0, max: LUA_MEMORY_MAX_BYTES },
        };
        // A Lua step that a JS promise callback resumes throws outside any await (wasmoon's
        // `async` steps); the worker reports such an error here, and it ends the run.
        const faulted = new Promise<never>((_, reject) => {
            fault = reject;
        });
        let engine: LuaEngine | null = null;
        try {
            if (hooks.aborted()) {
                throw new LuaAbortError();
            }
            const acquired = await acquire();
            engine = acquired.engine;
            // The engine boot is not the run's: the budget starts with the user code.
            budget.startActive = activeMs();
            current = budget;
            acquired.bind(state);
            declareProxied(engine, state, input);
            try {
                await Promise.race([runChunk(engine, input.code), faulted]);
            } catch (error) {
                // A load failure or a top-level runaway leaves nothing to dispatch.
                result.error = errorMessage(error);
                result.failedAt = "load";
                return result;
            }
            if (hooks.aborted()) {
                throw new LuaAbortError();
            }
            const accessKey = randomUUID();
            if (input.mode === "editDisplay") {
                state.editDisplayIds.add(accessKey);
            } else {
                state.safeIds.add(accessKey);
                if (input.lowLevelAccess) {
                    state.lowLevelIds.add(accessKey);
                }
            }
            try {
                const res = await Promise.race([dispatch(engine, input, accessKey), faulted]);
                if (res === false) {
                    state.stopSending = true;
                }
                result.res = res;
            } catch (error) {
                result.error = errorMessage(error);
                result.failedAt = "dispatch";
            }
            return result;
        } catch (error) {
            result.error = errorMessage(error);
            return result;
        } finally {
            result.cpuMs = Math.max(0, Math.round(activeMs() - budget.startActive - budget.excludedMs));
            current = null;
            fault = null;
            faulted.catch(() => {});
            result.stopSending = state.stopSending;
            if (hooks.aborted()) {
                result.aborted = true;
                result.error = "request aborted";
            } else if (result.error !== undefined && isLuaTimeoutError(result.error)) {
                result.timedOut = true;
            }
            if (result.res !== undefined) {
                try {
                    if (JSON.stringify(result.res).length > MAX_RESULT_JSON_CHARS) {
                        result.res = undefined;
                        result.error = "Lua result too large";
                    }
                } catch {
                    result.res = undefined;
                    result.error = "Lua result is not JSON data";
                }
            }
            if (engine) {
                result.memory.used = engine.global.getMemoryUsed();
                try {
                    // One run per engine: closing it, never returning it, keeps runs isolated.
                    engine.global.close();
                } catch {
                    // A closed engine is gone either way.
                }
            }
            running = false;
            refill();
        }
    }

    return {
        /** Boots the prepared engines ahead of the first run. */
        warm: async (): Promise<void> => {
            refill();
            while (bootGate) {
                await bootGate;
            }
        },
        run,
        /** Charges nothing for `ms` of the active run's busy time (a regex its host call spawned). */
        exclude(ms: number): void {
            if (running && current) {
                current.excludedMs += ms;
            }
        },
        /** Ends the active run with an error thrown outside its awaits; false when no run is active. */
        reportFault(error: unknown): boolean {
            if (!fault) {
                return false;
            }
            fault(error);
            return true;
        },
    };
}

/** Runs a chunk on a thread of its own; globals it defines land on the shared `_G`, as `doString` does. */
async function runChunk(engine: LuaEngine, code: string): Promise<void> {
    const global = engine.global;
    const thread = global.newThread();
    const threadIndex = global.getTop();
    try {
        thread.loadString(code);
        await thread.run(0);
    } finally {
        global.remove(threadIndex);
    }
}

async function dispatch(engine: LuaEngine, input: LuaRunInput, accessKey: string): Promise<unknown> {
    const get = (name: string) => engine.global.get(name) as ((...args: unknown[]) => unknown) | undefined;
    const call = async (name: string, ...args: unknown[]) => {
        const fn = get(name);
        return plain(fn ? await fn(...args) : undefined);
    };
    switch (input.mode) {
        case "input":
            return await call("onInput", accessKey);
        case "output":
            return await call("onOutput", accessKey);
        case "start":
            return await call("onStart", accessKey);
        case "onButtonClick":
            return await call("onButtonClick", accessKey, primitiveIn("onButtonClick", input.data));
        case "editRequest":
        case "editDisplay":
        case "editInput":
        case "editOutput": {
            const fn = get("callListenMain");
            if (!fn) {
                return undefined;
            }
            const raw = await fn(input.mode, accessKey, JSON.stringify(input.data), JSON.stringify(input.meta ?? {}));
            return typeof raw === "string" ? JSON.parse(raw) : undefined;
        }
        default:
            return await call(input.mode, accessKey);
    }
}

/** The abort checkpoint and the budget check of every host call. */
function checkpoint(state: RunState): void {
    if (state.hooks.aborted()) {
        throw new LuaAbortError();
    }
    const budget = state.budget;
    if (activeMs() - budget.startActive - budget.excludedMs > budget.cpuMs) {
        throw new LuaBudgetError();
    }
}

function callAsync(state: RunState, name: string, args: unknown[], access: HostAccess): Promise<unknown> {
    checkpoint(state);
    checkHostArgs(name, args);
    if (state.outstanding >= MAX_OUTSTANDING_HOST_CALLS) {
        throw new Error(`More than ${MAX_OUTSTANDING_HOST_CALLS} host calls outstanding`);
    }
    state.outstanding++;
    return state.hooks
        .callAsync(name, args, access)
        .then((value) => primitiveIn(name, value))
        .finally(() => {
            state.outstanding--;
        });
}

function callSync(state: RunState, name: string, args: unknown[], access: HostAccess): unknown {
    checkpoint(state);
    checkHostArgs(name, args);
    // The worker is blocked while the main thread answers; that time is not the run's.
    const start = activeMs();
    try {
        return primitiveIn(name, state.hooks.callSync(name, args, access));
    } finally {
        state.budget.excludedMs += activeMs() - start;
    }
}

function log(state: RunState, value: unknown): void {
    const text = String(value).slice(0, MAX_LOG_MESSAGE_CHARS);
    if (state.logChars + text.length > MAX_LOG_CHARS_PER_RUN) {
        return;
    }
    state.logChars += text.length;
    state.hooks.log(text);
}

function accessOf(state: RunState, id: unknown): HostAccess {
    if (typeof id !== "string") {
        return null;
    }
    if (state.lowLevelIds.has(id)) {
        return "lowLevel";
    }
    if (state.safeIds.has(id)) {
        return "safe";
    }
    return state.editDisplayIds.has(id) ? "editDisplay" : null;
}

/**
 * The host functions this runtime owns, declared once per engine; the run's state is bound before
 * its code runs. `sleep` and `request` are served on the main thread (the request window is the
 * server's), with the client's id checks.
 */
function declareBuiltins(engine: LuaEngine): (state: RunState) => void {
    let state: RunState | null = null;
    const bound = (): RunState => {
        if (!state) {
            throw new Error("Lua host function called outside a run");
        }
        return state;
    };
    engine.global.set("stopChat", (id: string) => {
        const current = bound();
        checkpoint(current);
        if (current.safeIds.has(id)) {
            current.stopSending = true;
        }
    });
    engine.global.set("logMain", (value: string) => {
        const current = bound();
        checkpoint(current);
        log(current, value);
    });
    engine.global.set("printMain", (value: string) => {
        // The hardening keeps this as `print`'s sink; before a run binds, it has nowhere to go.
        if (state) {
            log(state, value);
        }
    });
    engine.global.set("sleep", (id: string, time: number) => {
        const current = bound();
        checkpoint(current);
        if (!current.safeIds.has(id)) {
            return undefined;
        }
        if (current.sleptMs >= MAX_TOTAL_SLEEP_MS) {
            return false;
        }
        const ms = Math.min(Math.max(0, Number(time) || 0), MAX_SLEEP_MS, MAX_TOTAL_SLEEP_MS - current.sleptMs);
        current.sleptMs += ms;
        return callAsync(current, "sleep", [ms], "safe").then(() => true);
    });
    // What a key grants, for the prelude's wrappers of the client functions that return nil at once
    // on a refused key and a promise otherwise; the host checks the key again.
    engine.global.set("__risuAccess", (id: string) => {
        const current = bound();
        checkpoint(current);
        return accessOf(current, id) ?? undefined;
    });
    engine.global.set("request", (id: string, url: string) => {
        const current = bound();
        checkpoint(current);
        if (!current.lowLevelIds.has(id)) {
            return undefined;
        }
        return callAsync(current, "request", [String(url ?? "")], "lowLevel");
    });
    return (next) => {
        state = next;
    };
}

/** The caller's host functions, declared on the engine before the run's code. */
function declareProxied(engine: LuaEngine, state: RunState, input: LuaRunInput): void {
    for (const name of input.asyncHost ?? []) {
        engine.global.set(name, (...args: unknown[]) => callAsync(state, name, args, accessOf(state, args[0])));
    }
    for (const name of input.syncHost ?? []) {
        engine.global.set(name, (...args: unknown[]) => callSync(state, name, args, accessOf(state, args[0])));
    }
}
