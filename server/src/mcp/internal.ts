import type { character, Chat, groupChat, Message } from "../../../shared/database.ts";
import type { CallbackName, CallbackPayloads, GenerationQuestion } from "../../../shared/jobs.ts";
import type {
    ModelModeExtended,
    RequestArgs,
    RPCToolCallContent,
    ToolDescriptor,
} from "../../../shared/llm/request.ts";
import { AIACCESS_TOOLS, callAiAccessTool } from "../../../shared/mcp/aiaccess.ts";
import { callGraphMemTool, GRAPHMEM_TOOLS } from "../../../shared/mcp/graphmem.ts";
import type { MCPTool, RisuAccessHost, RisuAccessWrite } from "../../../shared/mcp/risuaccess/host.ts";
import { createRisuAccess } from "../../../shared/mcp/risuaccess/index.ts";
import type { RisuModule } from "../../../shared/modules.ts";
import { CHARACTER_FIXED_FIELDS, detachPatch, MutationValidationError } from "../../../shared/mutationValidation.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import { type ResourceBatchOperation, type ResourceStore, ResourceValidationError } from "../data/resourceStore.ts";
import { JobWriteConflictError, type RunningJob } from "../jobs/generationJobs.ts";
import type { JobScope } from "../jobs/jobScope.ts";
import { messages } from "../llm/messages.ts";
import type { requestDataResponse } from "../llm/request.ts";
import { type EmbeddingEnv, HypaProcesser } from "../prompt/embeddings.ts";
import type { HostContext } from "../scripts/workerPool.ts";

/** How long the tab has to say which chat of a character it shows (`selectedChat`). */
const SELECTED_CHAT_TIMEOUT_MS = 30_000;

/** The bindings' services the internal tools use, under the job's one fatal policy. */
export type InternalToolServices = {
    fence(ctx?: HostContext): void;
    latch(error: unknown): Error;
    /** Reads the job's chat and characters again (after a write a tool made). */
    refresh(): boolean;
    ask(question: GenerationQuestion, ctx: HostContext, options?: { signal?: AbortSignal }): Promise<unknown>;
    tryCallback<N extends CallbackName>(
        name: N,
        payload: CallbackPayloads[N],
        ctx: HostContext,
        options?: { timeoutMs?: number },
    ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
    request(arg: RequestArgs, mode: ModelModeExtended, ctx: HostContext): Promise<requestDataResponse>;
    getChatVar(key: string): string;
    setChatVar(key: string, value: string, ctx?: HostContext): boolean;
    embeddings(ctx: HostContext): EmbeddingEnv;
};

export type InternalToolDeps = {
    job: RunningJob;
    scope: JobScope;
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    services: InternalToolServices;
    /** Whether the owner's tab is attached, after the attach grace. */
    ownerAttached(ctx: HostContext): Promise<boolean>;
    /** The job's `runLLM` calls in progress (one at a time: a nested one is refused). */
    llm: { active: number };
};

/** An internal MCP that runs on the server for a job: its tools, and a call. */
export type InternalMcp = {
    tools: ToolDescriptor[];
    call(tool: string, args: unknown, ctx: HostContext): Promise<RPCToolCallContent[]>;
};

const descriptors = (tools: MCPTool[]): ToolDescriptor[] =>
    tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

/** A record with `entries` applied as own properties (`undefined` removes one), as `writeEntries` does. */
function applyEntries(data: unknown, entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        Object.defineProperty(next, key, { value, writable: true, enumerable: true, configurable: true });
    }
    for (const [key, value] of entries) {
        if (value === undefined) {
            delete next[key];
        } else {
            Object.defineProperty(next, key, { value, writable: true, enumerable: true, configurable: true });
        }
    }
    return next;
}

/**
 * The internal MCPs that run on the server for a job (Phase 5 slice 12b): `internal:aiaccess`,
 * `internal:risuai`, and `internal:graphmem`. The tools and their logic are the tab's
 * (`shared/mcp/`); what differs is the host each runs on:
 *
 * - `internal:aiaccess` `runLLM` is a request of the job (`services.request`: the job's settings,
 *   tools, and budget). One runs at a time: a `runLLM` asked for while another of the job is running
 *   is refused.
 * - `internal:risuai` reads the store as it is now, not the job's frozen projection (a consent
 *   prompt stays open for a while, and the write that follows must see the record of that moment).
 *   Its consent is an `alertConfirm` question; a write validates the patch as the tab does
 *   (`detachPatch`, the fixed fields), applies it to the record the handler read (at that revision:
 *   a record changed in between is refused, not rebased), and is sent to the tab as a `resource`
 *   event. An empty id is the job's character; its chat history
 *   is the job's chat. Another character's history is the chat the owner's tab has selected for it
 *   (`selectedChat`), read from the store.
 * - `internal:graphmem` keeps its graph in the job chat's variable `graphmem_graph` and searches
 *   with the job's embeddings.
 */
export function createInternalMcps(deps: InternalToolDeps): Record<string, InternalMcp> {
    const { job, scope, store, kinds, services } = deps;
    const kindOf = (name: string): ResourceKind => {
        const kind = kinds.get(name);
        if (!kind) {
            throw new Error(`Unknown resource kind ${name}`);
        }
        return kind;
    };
    const charactersKind = kindOf(RESOURCE_KIND.characters);
    const modulesKind = kindOf(RESOURCE_KIND.modules);
    const enabledKind = kindOf(RESOURCE_KIND.enabledModules);

    /** A failure that is the job's (latched, or its end) is raised again; anything else is the tool's own. */
    const fatal = (ctx: HostContext) => () => {
        services.fence(ctx);
        return false;
    };

    /** A checked, detached patch, or the refusal's text. */
    const prepare = (
        patch: Record<string, unknown>,
        checkField: (field: string) => void,
    ): { entries: [string, unknown][] } | { error: string } => {
        try {
            return { entries: detachPatch(patch, checkField) };
        } catch (error) {
            if (error instanceof MutationValidationError) {
                return { error: error.message };
            }
            throw error;
        }
    };

    /**
     * One job write of resource records. The ops carry the revisions the handler's patch was computed
     * from (read in the same tick), so a record changed in between conflicts again on the write's retry
     * and is refused, never rebased; a refused value is an answer too.
     */
    const write = (
        ctx: HostContext,
        ops: ResourceBatchOperation[],
        emit: { kind: string; id: string }[],
    ): RisuAccessWrite => {
        services.fence(ctx);
        if (ops.length === 0) {
            return { ok: true };
        }
        try {
            job.write(() => ({ ops }));
        } catch (error) {
            if (error instanceof ResourceValidationError) {
                return { ok: false, error: error.message };
            }
            if (error instanceof JobWriteConflictError) {
                return { ok: false, error: "The record changed while it was being written; nothing was changed" };
            }
            throw services.latch(error);
        }
        services.refresh();
        job.emitRecords({ refs: emit });
        return { ok: true };
    };

    const storedModules = () => {
        const row = store.get(modulesKind, SINGLETON_RESOURCE_ID);
        return { row, list: Array.isArray(row?.data) ? (row.data as RisuModule[]) : [] };
    };
    const storedEnabled = () => {
        const row = store.get(enabledKind, SINGLETON_RESOURCE_ID);
        return { row, list: Array.isArray(row?.data) ? (row.data as string[]) : [] };
    };
    const allCharacters = () =>
        (store.readKinds([charactersKind]).kinds[RESOURCE_KIND.characters] ?? []).map(
            (record) => record.data as DeepReadonly<character | groupChat>,
        );
    const storedCharacter = (chaId: string) =>
        (store.get(charactersKind, chaId)?.data ?? undefined) as DeepReadonly<character | groupChat> | undefined;
    const storedMessages = (characterId: string, chatId: string): readonly DeepReadonly<Message>[] | null => {
        const record = store.readRefs([], { chats: [{ characterId, id: chatId }] }).chats[0];
        return record?.data ? ((record.data as Chat).message ?? []) : null;
    };

    const risuAccessHost = (ctx: HostContext): RisuAccessHost => ({
        getCharacter: (id) =>
            id
                ? allCharacters().find((entry) => entry?.chaId === id || entry?.name === id)
                : storedCharacter(scope.characterId),
        findCharacter: storedCharacter,
        characters: allCharacters,
        currentMessages: async (char) => {
            if (char.chaId === scope.characterId) {
                return storedMessages(scope.characterId, scope.chatId) ?? [];
            }
            // The selection is the tab's own: it says which chat of that character it shows.
            if (!(await deps.ownerAttached(ctx))) {
                throw new Error("The chat history of another character needs the owner's tab, which is not connected");
            }
            const answer = await services.tryCallback("selectedChat", { characterId: char.chaId }, ctx, {
                timeoutMs: SELECTED_CHAT_TIMEOUT_MS,
            });
            services.fence(ctx);
            // The character may have changed while the tab answered: checked again as the handler did.
            const current = storedCharacter(char.chaId);
            if (!current) {
                throw new Error(`Character with ID ${char.chaId} not found.`);
            }
            if (current.type === "group") {
                throw new Error("The id pointed to a group chat, not a character.");
            }
            const chatId = answer.ok ? (answer.value as { chatId?: unknown } | null)?.chatId : undefined;
            const found = typeof chatId === "string" ? storedMessages(char.chaId, chatId) : null;
            if (!found) {
                throw new Error("The character has no selected chat");
            }
            return found;
        },
        updateCharacter: (chaId, patch) => {
            const prepared = prepare(patch, (field) => {
                if (CHARACTER_FIXED_FIELDS.has(field)) {
                    throw new MutationValidationError(field, "this character field cannot be patched");
                }
            });
            if ("error" in prepared) {
                return { ok: false, error: prepared.error };
            }
            const row = store.get(charactersKind, chaId);
            if (!row) {
                return { ok: false, notFound: true };
            }
            const ops: ResourceBatchOperation[] =
                prepared.entries.length === 0
                    ? []
                    : [
                          {
                              kind: charactersKind,
                              id: chaId,
                              baseRevision: row.revision,
                              data: applyEntries(row.data, prepared.entries),
                          },
                      ];
            return write(ctx, ops, [{ kind: RESOURCE_KIND.characters, id: chaId }]);
        },
        modules: () => storedModules().list,
        enabledModules: () => storedEnabled().list,
        findModule: (id) => storedModules().list.find((module) => module?.id === id),
        updateModule: (id, patch, enabled) => {
            const prepared = prepare(patch, (field) => {
                if (field === "id") {
                    throw new MutationValidationError(field, "a module's id cannot be changed");
                }
            });
            if ("error" in prepared) {
                return { ok: false, error: prepared.error };
            }
            const { row, list } = storedModules();
            const index = list.findIndex((module) => module?.id === id);
            if (!row || index === -1) {
                return { ok: false, notFound: true };
            }
            const ops: ResourceBatchOperation[] = [];
            if (prepared.entries.length > 0) {
                const next = list.slice();
                next[index] = applyEntries(list[index], prepared.entries) as unknown as RisuModule;
                ops.push({
                    kind: modulesKind,
                    id: SINGLETON_RESOURCE_ID,
                    baseRevision: row.revision,
                    data: next,
                });
            }
            // The module's fields and its enabled state in one write: both or neither.
            if (enabled !== undefined) {
                const stored = storedEnabled();
                const ids = new Set(stored.list);
                if (enabled) {
                    ids.add(id);
                } else {
                    ids.delete(id);
                }
                if (!stored.row) {
                    return { ok: false, error: "The enabled modules list is not stored; nothing was changed" };
                }
                ops.push({
                    kind: enabledKind,
                    id: SINGLETON_RESOURCE_ID,
                    baseRevision: stored.row.revision,
                    data: [...ids],
                });
            }
            return write(ctx, ops, [
                { kind: RESOURCE_KIND.modules, id: SINGLETON_RESOURCE_ID },
                { kind: RESOURCE_KIND.enabledModules, id: SINGLETON_RESOURCE_ID },
            ]);
        },
        confirm: async (tool, action) => {
            const answer = await services.ask(
                {
                    kind: "alertConfirm",
                    payload: {
                        message: messages.mcpAccessPrompt.replace("{{tool}}", tool).replace("{{action}}", action),
                    },
                },
                ctx,
            );
            services.fence(ctx);
            return answer === true;
        },
    });

    // The tools' schemas need no host: listed once.
    const risuAccessTools = descriptors(
        createRisuAccess({
            getCharacter: () => undefined,
            findCharacter: () => undefined,
            characters: () => [],
            currentMessages: async () => [],
            updateCharacter: () => ({ ok: false, notFound: true }),
            modules: () => [],
            enabledModules: () => [],
            findModule: () => undefined,
            updateModule: () => ({ ok: false, notFound: true }),
            confirm: async () => false,
        }).tools(),
    );

    return {
        "internal:aiaccess": {
            tools: descriptors(AIACCESS_TOOLS),
            call: (tool, args, ctx) =>
                callAiAccessTool(
                    {
                        runLLM: async (formated, mode) => {
                            if (deps.llm.active > 0) {
                                throw new Error(
                                    "runLLM cannot be called while another runLLM call of the job is running",
                                );
                            }
                            deps.llm.active++;
                            try {
                                return await services.request({ formated, bias: {} } as RequestArgs, mode, ctx);
                            } finally {
                                deps.llm.active--;
                            }
                        },
                    },
                    tool,
                    args,
                ),
        },
        "internal:risuai": {
            tools: risuAccessTools,
            call: (tool, args, ctx) => createRisuAccess(risuAccessHost(ctx), fatal(ctx)).call(tool, args),
        },
        "internal:graphmem": {
            tools: descriptors(GRAPHMEM_TOOLS),
            call: (tool, args, ctx) =>
                callGraphMemTool(
                    {
                        getVar: (key) => services.getChatVar(key),
                        setVar: (key, value) => {
                            services.setChatVar(key, value, ctx);
                        },
                        search: async (names) => {
                            const processer = new HypaProcesser(services.embeddings(ctx));
                            await processer.embedDocuments(names);
                            services.fence(ctx);
                            return async (term) => {
                                const found = await processer.similaritySearch(term);
                                services.fence(ctx);
                                return found;
                            };
                        },
                        fatal: fatal(ctx),
                    },
                    tool,
                    args,
                ),
        },
    };
}
