import { TAB_MCP_IDENTIFIERS } from "../../../shared/jobs.ts";
import type { RPCToolCallContent, ToolDescriptor } from "../../../shared/llm/request.ts";
import { isToolContentEntry } from "../../../shared/llm/validate.ts";
import { jobModules } from "../jobs/cbsHost.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import type { JobScope } from "../jobs/jobScope.ts";
import { collectSecrets, createRedactor } from "../llm/redact.ts";
import type { HostContext } from "../scripts/workerPool.ts";
import { MAX_TOOL_LIST_BYTES, MAX_TOOL_LIST_TOOLS, type McpIo, type McpRefresh } from "./client.ts";
import { callDiceTool, DICE_TOOLS } from "./dice.ts";
import { createInternalMcps, type InternalToolServices } from "./internal.ts";
import type { McpRegistry } from "./registry.ts";

/** The tool calls the models of one job may ask for, across its requests and speakers. */
export const MAX_JOB_TOOL_CALLS = 64;
/** A tab-resident tool's callbacks: a directory picker or a credential prompt is the user's own time. */
export const TAB_MCP_TIMEOUT_MS = 5 * 60_000;
/**
 * How long a tab-resident tool waits for the owner's socket before it counts as away: a job starts
 * before its tab has attached, and a tab reconnects after a network change.
 */
export const TAB_ATTACH_GRACE_MS = 10_000;

/** The MCP a job may call although no module names it (the tab's `callOnlyMCPUrls`): its tools are not offered. */
const CALL_ONLY_IDENTIFIER = "internal:risuai";

type Route =
    | {
          kind: "local";
          identifier: string;
          call: (tool: string, args: unknown, ctx: HostContext) => Promise<RPCToolCallContent[]>;
      }
    | { kind: "remote"; identifier: string; url: string }
    | { kind: "tab"; identifier: string };

/** The tools of one job: what its requests offer, and where a tool's call goes (the first MCP that has the name). */
export type JobToolSet = { descriptors: ToolDescriptor[]; routes: Map<string, Route> };

/** A job's tool state, shared by its runs (`JobRunState.tools`). */
export type JobToolState = {
    /** The set per identifier list (a `presetChain` pick may name other modules), built once. */
    sets: Map<string, Promise<JobToolSet>>;
    attempts: number;
    warned: boolean;
    /** The `runLLM` calls of `internal:aiaccess` in progress (one at a time). */
    llm: { active: number };
};

export function createJobToolState(): JobToolState {
    return { sets: new Map(), attempts: 0, warned: false, llm: { active: 0 } };
}

/**
 * The bindings' services the tools use, under the job's one fatal policy: `ask` (a channel question;
 * its `signal` withdraws it, an ordinary failure) and `tryCallback` (a client callback: the value, or
 * an ordinary failure's text; a fatal outcome throws, latched) among them.
 */
export type JobToolServices = InternalToolServices & {
    notice(notice: Parameters<RunningJob["channel"]["notice"]>[0]): void;
};

export type JobTools = {
    /** The job's tool set (built by the job, not by the caller: `ctx` only bounds this wait). */
    list(ctx: HostContext): Promise<JobToolSet>;
    /** Charges one tool call a model asked for; false once the job's budget is spent. */
    charge(): boolean;
    /**
     * Runs a tool. A tool's own failure is a text result for the model
     * (`Tool call failed with error: ...`); a fatal outcome (an abort, a lost or silent tab after the
     * callback was sent, a barrier or protocol failure) throws the job's latched failure.
     */
    call(set: JobToolSet, name: string, args: unknown, ctx: HostContext): Promise<RPCToolCallContent[]>;
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a log line shows of an identifier: never a URL's path or query (it may carry a key). */
function shown(identifier: string, url?: string): string {
    if (url === undefined) {
        return identifier.startsWith("stdio:") ? "stdio:" : identifier;
    }
    try {
        return new URL(url).origin;
    } catch {
        return "an MCP URL";
    }
}

/** The descriptors a tab answered for `mcpList`: the three fields, bounded as a remote list is. */
function tabDescriptors(value: unknown): ToolDescriptor[] {
    if (!Array.isArray(value)) {
        throw new Error("The tool list is not a list");
    }
    const tools: ToolDescriptor[] = [];
    let bytes = 0;
    for (const entry of value) {
        if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name === "") {
            continue;
        }
        if (entry.description !== undefined && typeof entry.description !== "string") {
            continue;
        }
        if (!isPlainObject(entry.inputSchema)) {
            continue;
        }
        const tool = { name: entry.name, description: entry.description ?? "", inputSchema: entry.inputSchema };
        bytes += Buffer.byteLength(JSON.stringify(tool));
        if (tools.length >= MAX_TOOL_LIST_TOOLS || bytes > MAX_TOOL_LIST_BYTES) {
            throw new Error("The tool list is too large");
        }
        tools.push(tool);
    }
    return tools;
}

/**
 * The MCP tools of one job run (Phase 5 slice 12): the server's port of `getTools` and `callTool`
 * (`src/ts/process/mcp/mcp.ts`) for a job's requests.
 *
 * The identifiers are the `mcp.url` of the job's modules, each once, in module order. A remote
 * server (`http(s)://`, or `stdio:` JSON with a `url`) goes through the process's registry;
 * `internal:dice`, `internal:aiaccess`, `internal:risuai`, and `internal:graphmem` run here
 * (`internal.ts`); `internal:fs`, `internal:googlesearch`, and a `plugin:` MCP the tab registered
 * when the job was created run in the owner's tab (`mcpList`, `mcpTool`). `internal:risuai` can be
 * called although no module names it; its tools are then not offered (the tab's call-only rule).
 *
 * The set is built once per job and identifier list, at the first request that needs it, and kept
 * for the job: a remote server that cannot be reached or initialized offers no tools (a warning), as
 * does a tab-resident kind while no tab is attached; a tab's tool list that fails, or a `stdio:`
 * entry that names a command, fails the request, as the tab's `getTools()` rejects. A build that
 * failed is not kept.
 */
export function createJobTools(deps: {
    job: RunningJob;
    scope: JobScope;
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    state: JobToolState;
    registry: McpRegistry;
    services: JobToolServices;
}): JobTools {
    const { job, scope, state, registry, services } = deps;
    // The identifier, the tool name, and the arguments never carry a stored LLM credential out.
    const redactor = createRedactor(collectSecrets(scope.request.db));
    const warn = (message: string) => console.warn("[MCP]", redactor.text(message));

    const ioFor = (identifier: string, ctx: HostContext): McpIo => ({
        signal: AbortSignal.any([job.signal, ctx.signal]),
        openUrl: (url) => {
            services.fence(ctx);
            services.notice({ kind: "openURL", payload: { url } });
        },
        askCode: async (cancel) => {
            const code = await services.ask(
                { kind: "alertInput", payload: { message: "Input Authorization Code" } },
                ctx,
                { signal: cancel },
            );
            return typeof code === "string" ? code : "";
        },
        writeRefresh: (entry: McpRefresh) => {
            services.fence(ctx);
            try {
                // Read again inside the build: the one retry of a conflict sees the stored list.
                job.write(() => registry.refreshChanges(identifier, entry));
            } catch (error) {
                throw services.latch(error);
            }
        },
    });

    /** Whether the owner's tab is attached, waiting `TAB_ATTACH_GRACE_MS` for it at most. */
    const ownerAttached = async (ctx: HostContext): Promise<boolean> => {
        const deadline = Date.now() + TAB_ATTACH_GRACE_MS;
        while (!job.ownerAttached()) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            services.fence(ctx);
        }
        return true;
    };

    const internal = createInternalMcps({
        job,
        scope,
        store: deps.store,
        kinds: deps.kinds,
        services,
        ownerAttached,
        llm: state.llm,
    });

    const identifiers = (): string[] => {
        const seen = new Set<string>();
        for (const module of jobModules(scope)) {
            const url = module?.mcp?.url;
            if (typeof url === "string" && url !== "") {
                seen.add(url);
            }
        }
        return [...seen];
    };

    const build = async (ids: string[], ctx: HostContext): Promise<JobToolSet> => {
        const descriptors: ToolDescriptor[] = [];
        const routes = new Map<string, Route>();
        const offer = (route: Route, tools: ToolDescriptor[]) => {
            for (const tool of tools) {
                descriptors.push(tool);
                if (!routes.has(tool.name)) {
                    routes.set(tool.name, route);
                }
            }
        };
        for (const identifier of ids) {
            services.fence(ctx);
            if (redactor.carries(identifier)) {
                warn("An MCP identifier carries a stored credential; it is not used");
                continue;
            }
            if (identifier === "internal:dice") {
                offer({ kind: "local", identifier, call: callDiceTool }, DICE_TOOLS);
                continue;
            }
            if (Object.hasOwn(internal, identifier)) {
                offer({ kind: "local", identifier, call: internal[identifier].call }, internal[identifier].tools);
                continue;
            }
            const tabKind =
                TAB_MCP_IDENTIFIERS.includes(identifier) ||
                (identifier.startsWith("plugin:") && job.hooks.mcpTools.includes(identifier));
            if (tabKind) {
                if (!(await ownerAttached(ctx))) {
                    warn(`${shown(identifier)} offers no tools to this job: no tab is connected`);
                    continue;
                }
                const answer = await services.tryCallback("mcpList", { identifier }, ctx, {
                    timeoutMs: TAB_MCP_TIMEOUT_MS,
                });
                if (!answer.ok) {
                    throw new Error(`MCP ${shown(identifier)}: ${answer.error}`);
                }
                offer({ kind: "tab", identifier }, tabDescriptors(answer.value));
                continue;
            }
            if (identifier.startsWith("internal:")) {
                if (!state.warned) {
                    state.warned = true;
                    warn(`${identifier} is not a known internal MCP`);
                }
                continue;
            }
            let url = identifier;
            if (identifier.startsWith("stdio:")) {
                try {
                    const data = JSON.parse(identifier.slice("stdio:".length));
                    if (data.url) {
                        url = data.url;
                    } else if (data.command && data.args) {
                        throw new Error("stdio MCPs are not supported");
                    } else {
                        throw new Error("MCP JSON does not contain a valid URL");
                    }
                } catch (error) {
                    throw new Error(`Failed to parse MCP JSON: ${error}`);
                }
            }
            if (typeof url !== "string" || (!url.startsWith("https://") && !url.startsWith("http://"))) {
                warn(`MCP: Failed to initialize ${shown(identifier)}: Invalid MCP URL`);
                continue;
            }
            if (redactor.carries(url)) {
                warn("An MCP URL carries a stored credential; it is not used");
                continue;
            }
            const remote = url;
            // A server that cannot be initialized is left out; a tool list that fails after that
            // fails the build, and with it the request.
            const tools = await registry.use(identifier, remote, async (client) => {
                const io = ioFor(identifier, ctx);
                try {
                    await client.checkHandshake(io);
                } catch (error) {
                    // The job's end or a latched failure is not this server's failure.
                    services.fence(ctx);
                    warn(`MCP: Failed to initialize ${shown(identifier, remote)}: ${errorText(error)}`);
                    return null;
                }
                services.fence(ctx);
                return await client.getToolList(io);
            });
            services.fence(ctx);
            if (tools) {
                offer({ kind: "remote", identifier, url: remote }, tools);
            }
        }
        // Call-only: routes for an adapter that dispatches a name it did not offer (Anthropic, as in the tab).
        if (!ids.includes(CALL_ONLY_IDENTIFIER)) {
            const callOnly = internal[CALL_ONLY_IDENTIFIER];
            for (const tool of callOnly.tools) {
                if (!routes.has(tool.name)) {
                    routes.set(tool.name, { kind: "local", identifier: CALL_ONLY_IDENTIFIER, call: callOnly.call });
                }
            }
        }
        return { descriptors, routes };
    };

    const failure = (message: string): RPCToolCallContent[] => [
        { type: "text", text: `Tool call failed with error: ${redactor.text(message)}` },
    ];

    return {
        async list(ctx) {
            services.fence(ctx);
            const ids = identifiers();
            const key = JSON.stringify(ids);
            let building = state.sets.get(key);
            if (!building) {
                // The job builds it, whichever request asked first: that request's end does not end it.
                const jobCtx: HostContext = { ...ctx, signal: job.signal };
                building = build(ids, jobCtx);
                state.sets.set(key, building);
                building.catch(() => {
                    if (state.sets.get(key) === building) {
                        state.sets.delete(key);
                    }
                });
            }
            const signal = AbortSignal.any([job.signal, ctx.signal]);
            const waited = building;
            const set = await new Promise<JobToolSet>((resolve, reject) => {
                const onAbort = () => reject(signal.reason ?? new Error("request aborted"));
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
                waited.then(
                    (value) => {
                        signal.removeEventListener("abort", onAbort);
                        resolve(value);
                    },
                    (error) => {
                        signal.removeEventListener("abort", onAbort);
                        reject(error);
                    },
                );
            });
            services.fence(ctx);
            return set;
        },

        charge() {
            state.attempts++;
            return state.attempts <= MAX_JOB_TOOL_CALLS;
        },

        async call(set, name, args, ctx) {
            services.fence(ctx);
            const route = set.routes.get(name);
            if (!route) {
                return [{ type: "text", text: `Tool ${name} not found on any MCP` }];
            }
            if (redactor.carries(name) || redactor.carries(args)) {
                return failure("The tool call carries a stored credential; it is not sent");
            }
            let content: unknown;
            try {
                if (route.kind === "local") {
                    content = await route.call(name, args, ctx);
                } else if (route.kind === "remote") {
                    content = await registry.use(route.identifier, route.url, (client) =>
                        client.callTool(name, args, ioFor(route.identifier, ctx)),
                    );
                } else {
                    // Nobody to ask now is the tool's failure; a tab lost after the callback was sent
                    // is the callback's (fatal).
                    if (!(await ownerAttached(ctx))) {
                        return failure("The owner's tab is not connected");
                    }
                    const answer = await services.tryCallback(
                        "mcpTool",
                        { identifier: route.identifier, tool: name, args },
                        ctx,
                        { timeoutMs: TAB_MCP_TIMEOUT_MS },
                    );
                    if (!answer.ok) {
                        return failure(answer.error);
                    }
                    content = answer.value;
                }
            } catch (error) {
                // The job's end or a latched failure goes on as it is; anything else is the tool's.
                services.fence(ctx);
                return failure(errorText(error));
            }
            services.fence(ctx);
            if (!Array.isArray(content) || !content.every(isToolContentEntry)) {
                return failure("The tool answered a value that is not tool content");
            }
            return content as RPCToolCallContent[];
        },
    };
}
