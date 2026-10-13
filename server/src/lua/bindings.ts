import { createHash, randomUUID } from "node:crypto";
import type { CbsEvaluator, CbsHost } from "../../../shared/cbs/evaluator.ts";
import { CbsLimitError, type CbsUsage } from "../../../shared/cbs/limits.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message, character, groupChat, loreBook } from "../../../shared/database.ts";
import type { CallbackName, CallbackPayloads, CallbackResult, GenerationQuestion } from "../../../shared/jobs.ts";
import type {
    InlaySignature,
    ModelModeExtended,
    RequestArgs,
    RequestSource,
    StreamResponseChunk,
} from "../../../shared/llm/request.ts";
import { activateLore } from "../../../shared/lore/activation.ts";
import type { MultiModal, OpenAIChat } from "../../../shared/openai.ts";
import { pickHashRand } from "../../../shared/hashRand.ts";
import { type InlayResource, RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { MessageGuard } from "../jobs/generationLock.ts";
import { createJobCbsHost, jobModuleLorebooks, serverCbsLimits } from "../jobs/cbsHost.ts";
import type { JobChannel } from "../jobs/channel.ts";
import { failureOf, JobWriteConflictError, markFailure, type RunningJob } from "../jobs/generationJobs.ts";
import { type JobScope, refreshCharacter, refreshChat, scopeChat } from "../jobs/jobScope.ts";
import { requestChatDataOuter } from "../llm/outer.ts";
import type { requestDataResponse } from "../llm/request.ts";
import type { JobRequestSpec, LlmRequests } from "../llm/requests.ts";
import { mainModelTakesImages, tokenScopeFor } from "../llm/settings.ts";
import type { TokenCounter } from "../prompt/tokens.ts";
import { readStorageFile, storageFileExists, writeStorageFile } from "../routes/storage.ts";
import { type EmbeddingEnv, type EmbeddingsService, HypaProcesser } from "../prompt/embeddings.ts";
import type { HostContext, LuaHost } from "../scripts/workerPool.ts";
import {
    createJobTools,
    type JobTools,
    type JobToolSet,
    type JobToolState,
    MAX_JOB_TOOL_CALLS,
} from "../mcp/jobTools.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import { createCbsEvaluator } from "../../../shared/cbs/evaluator.ts";

/**
 * A failure that ends the job whatever the script does with it (Phase 5 slice 8a): a write
 * conflict, a barrier failure, a channel timeout or disconnect, an abort, a protocol failure. The
 * binding latches it outside Lua (a script's `pcall` cannot swallow it) and raises it into the
 * script; the runner checks the latch after every run and ends the job with it.
 */
export class LuaJobFatalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LuaJobFatalError";
    }
}

export type LuaBindingDeps = {
    job: RunningJob;
    scope: JobScope;
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    rootDir: string;
    savePath: string;
    llm: LlmRequests;
    tokens: TokenCounter;
    /**
     * The character the run executes for (the speaking member in a group send, the chat screen's
     * character for a button): the character getters and setters address it. Null for none.
     */
    runCharacterId: string | null;
    /** The chat's owner (or the selection): CBS, lore, and the last-message fallback read it. */
    engineCharacterId: string;
    /** `{{trigger_id}}` while a manual trigger runs. */
    triggerId?: string | null;
    /** The job's CBS evaluation time, shared by every run of it (`serverCbsLimits`); its own when absent. */
    cbsUsage?: CbsUsage;
    /** The embeddings service (Phase 5 slice 10); without one, a similarity search fails with an error. */
    embeddings?: EmbeddingsService;
    /**
     * The remote MCP clients and the job's tool state (Phase 5 slice 12); without them the job's
     * requests offer no tools.
     */
    mcp?: { registry: McpRegistry; state: JobToolState };
    /** Called once with the first fatal failure: the runner aborts the run in progress with it. */
    onFatal?: (error: LuaJobFatalError) => void;
    /**
     * The generation lock: a chat write touching a message any generation owns, this job's own
     * included, is skipped (the client's `liveWrite` has no generation capability either).
     */
    lock?: MessageGuard;
    /**
     * A render's snapshot (the script transform, Phase 5 slice 13): `scope` is the target's own copy
     * and is never read again from the store; a chat-variable write changes that copy's `scriptstate`
     * only (the target's later stages see it, nothing persists); any other chat write is refused (a
     * fatal failure of the target), and the run's character is the scope's.
     */
    frozen?: boolean;
};

/**
 * A trigger's working copy while its `triggerlua` effect runs (Phase 5 slice 8b): the client's
 * `runScripted` with `chat` given. The chat functions read and edit `chat` in place (the trigger
 * reads it back afterwards); the chat-variable functions go through the trigger's own accessors.
 */
export type LuaWorkingCopy = {
    chat: Chat;
    getVar(key: string): string;
    setVar(key: string, value: string): boolean;
};

/** The executing character's fields a Lua setter wrote (the trigger merges them into its copy). */
export type CharacterPatchListener = (characterId: string, patch: Record<string, unknown>) => void;

/**
 * The bindings' job services for the native trigger runtime and the command executor (slice 8b),
 * behind the same latch and fence as the host functions: one fatal policy for Lua and native work.
 */
export type LuaBindingServices = {
    /** Raises a latched failure, or latches an abort of the job or of `ctx`. */
    fence(ctx?: HostContext): void;
    /** Latches `error` as the job's fatal failure and returns it. */
    latch(error: unknown): LuaJobFatalError;
    /** The job's chat as stored now (the last copy once it is gone). */
    liveChat(): Chat;
    /** Whether the job's chat is still stored. */
    chatExists(): boolean;
    /** Reads the job's chat and characters again; false when the chat is gone. */
    refresh(): boolean;
    writeChat(build: (chat: Chat) => ChatOp[] | null, ctx?: HostContext): void;
    /** The stored-merge `setChatVarOf` of the job's chat: true when it changed. */
    setChatVar(key: string, value: string, ctx?: HostContext): boolean;
    getChatVar(key: string): string;
    /** Patches the run's character; false when it is gone. */
    patchCharacter(patch: Record<string, unknown>, ctx: HostContext): boolean;
    /** Sets `personaPrompt` of the persona `personaId`; false when it is gone. */
    patchPersonaPrompt(personaId: string, value: string, ctx: HostContext): boolean;
    /** `options.signal` withdraws the question: an ordinary failure, not the job's. */
    ask(question: GenerationQuestion, ctx: HostContext, options?: { signal?: AbortSignal }): Promise<unknown>;
    notice(notice: Parameters<JobChannel["notice"]>[0]): void;
    /** A request of the job, recorded as `source` made it (and for `messageId`, where the caller knows it). */
    request(
        arg: RequestArgs,
        mode: ModelModeExtended,
        ctx: HostContext,
        source: RequestSource,
        meta?: { messageId?: string },
    ): Promise<requestDataResponse>;
    collectStreamText(stream: ReadableStream<StreamResponseChunk>): Promise<string>;
    /**
     * The `generateImage` callback for `characterId`: the stored inlay's id, or null when the tab could
     * not. `skipDisconnected`: no tab attached is null too (a reply's inlay image, slice 11a), not the
     * job's end.
     */
    generateImageInlay(
        prompt: string,
        negative: string,
        characterId: string,
        ctx: HostContext,
        options?: { timeoutMs?: number; skipDisconnected?: boolean },
    ): Promise<string | null>;
    tokenize(text: string): Promise<number>;
    /** `loadLoreBookV3Prompt` of the job's chat (the live chat and the chat owner). */
    activateLore(ctx: HostContext): ReturnType<typeof activateLore>;
    /** The server CBS of the job's chat with `chara` (the chat's character when none). */
    parse(text: string, chara: character | groupChat | null | undefined): string;
    /** `calcString` of `src/ts/process/infunctions.ts`, bound to the job's chat. */
    calc(text: string): number;
    /**
     * The job's embeddings with its settings and keys, ended by the job's or `ctx`'s abort. The keys
     * stay inside the embeddings module: no script, CBS text, or notice gets the env.
     */
    embeddings(ctx: HostContext): EmbeddingEnv;
    /**
     * The client's similarity search (`new HypaProcesser()`, `addText(values)`,
     * `similaritySearch(source)`): `values` ordered by their similarity to `source`.
     */
    similarity(source: string, values: string[], ctx: HostContext): Promise<string[]>;
};

export type LuaBindings = {
    host: LuaHost;
    /** The latched fatal failure, if a host call hit one. */
    fatal(): LuaJobFatalError | null;
    evaluator: CbsEvaluator;
    services: LuaBindingServices;
    /** Runs `fn` with the chat functions on `working` (a trigger's copy); the previous slot is restored after. */
    withWorking<T>(working: LuaWorkingCopy, fn: () => Promise<T>): Promise<T>;
    /** Calls `listener` after every Lua setter that wrote the run's character; returns the unsubscribe. */
    observeCharacterPatches(listener: CharacterPatchListener): () => void;
    /**
     * The native `request` trigger (`requestChatData`'s `runTrigger(…, 'request', …)`) every request
     * of these bindings runs before each attempt (Phase 5 slice 9); null for none.
     */
    setRequestTrigger(trigger: ((formated: OpenAIChat[]) => Promise<OpenAIChat[]>) | null): void;
    /** `getInlayAsset`: an inlay's media as a data URI (a signature: its JSON text) with its type, or null. */
    readInlay(id: string): Promise<{ type: string; data: string; width?: number; height?: number } | null>;
};

type ParsedPrompt = { role: string; content: string }[];

const textEncoder = new TextEncoder();

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** The client's `mediaKey`: `assets/inlay_<sha256>.<ext>`. */
function mediaKey(bytes: Uint8Array, ext: string): string {
    const safeExt = ext.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "bin";
    return `assets/inlay_${sha256Hex(bytes)}.${safeExt}`;
}

/** The client's `mimeOf` of an inlay. */
function mimeOf(meta: InlayResource): string {
    const ext = meta.ext.toLowerCase();
    if (meta.type === "image") {
        return `image/${ext === "jpg" ? "jpeg" : ext}`;
    }
    if (meta.type === "audio") {
        return `audio/${ext === "mp3" ? "mpeg" : ext}`;
    }
    if (meta.type === "video") {
        return `video/${ext}`;
    }
    return "application/json";
}

/** Rejects with the signal's reason when it aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        promise.catch(() => {});
        return Promise.reject(signal.reason ?? new Error("request aborted"));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("request aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
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
}

/**
 * The 50 Lua host functions the runtime does not own (it owns `stopChat`, `logMain`, `sleep`, and
 * `request`), served on the main thread for one job (Phase 5 slice 8a, ported from
 * the former `src/ts/process/scriptings.ts`). Each one keeps the client's exposure (synchronous, or a promise
 * the script awaits), its guard (the run's key, through `HostContext.access`: Safe is `safe` or
 * `lowLevel`, Safe|Edit adds `editDisplay`, Low is `lowLevel`; a refused key returns nil), and its
 * results. The table-taking functions cross as JSON through the prelude's wrappers
 * (`alertSelectMain`, `upsertLocalLoreBookMain`, `similarityMain`, `simpleLLMMain`, and the
 * immediate-nil `alertInputMain`/`alertConfirmMain`).
 *
 * Chat functions work on the job's chat (`scope`), by index resolved to message ids when called,
 * and write through `job.write`; after each write the chat is read again with its revision and sent
 * to the tab. A refused write of a message another generation owns is skipped with a warning, as
 * the client's `liveWrite`; any other conflict is fatal. Character functions address the run's
 * character, read live from the store.
 */
export function createLuaBindings(deps: LuaBindingDeps): LuaBindings {
    const { job, scope, store, kinds } = deps;
    const kindOf = (name: string): ResourceKind => {
        const kind = kinds.get(name);
        if (!kind) {
            throw new Error(`Unknown resource kind ${name}`);
        }
        return kind;
    };
    const charactersKind = kindOf(RESOURCE_KIND.characters);
    const personasKind = kindOf(RESOURCE_KIND.personas);
    const inlaysKind = kindOf(RESOURCE_KIND.inlays);
    const ref = { chaId: scope.characterId, chatId: scope.chatId };
    let fatalError: LuaJobFatalError | null = null;
    /** Latches the first fatal failure and returns the error to raise into the script. */
    const latch = (error: unknown): LuaJobFatalError => {
        const fatal =
            error instanceof LuaJobFatalError
                ? error
                : // The replacement keeps the failure's stage and request (`markFailure`).
                  markFailure(
                      new LuaJobFatalError(error instanceof Error ? error.message : String(error)),
                      failureOf(error),
                  );
        if (!fatalError) {
            fatalError = fatal;
            deps.onFatal?.(fatal);
        }
        return fatalError;
    };
    /**
     * Before every host function and every write: a latched failure raises again (a script that
     * caught it gets no further effect), and an aborted job or host call is fatal.
     */
    const fence = (ctx?: HostContext) => {
        if (fatalError) {
            throw fatalError;
        }
        if (job.signal.aborted || ctx?.signal.aborted) {
            throw latch(new LuaJobFatalError("request aborted"));
        }
    };

    let lastChat: Chat | undefined = scopeChat(scope);
    /** The job's chat as last read (the live chat; the last copy once it is gone, as the client keeps it). */
    const liveChat = (): Chat => (scopeChat(scope) ?? lastChat) as Chat;
    /** A trigger's working copy while its Lua runs (`withWorking`), else none. */
    let working: LuaWorkingCopy | null = null;
    /** The run's chat: the trigger's working copy, else the live chat (the client's `engineChat`). */
    const engineChat = (): Chat => working?.chat ?? liveChat();
    const characterListeners = new Set<CharacterPatchListener>();
    /** After a Lua setter wrote the run's character: the active triggers merge the fields into their copies. */
    const characterPatched = (patch: Record<string, unknown>) => {
        if (deps.runCharacterId) {
            for (const listener of [...characterListeners]) {
                listener(deps.runCharacterId, patch);
            }
        }
    };
    const engineCharacter = () => scope.db.characters.find((entry) => entry?.chaId === deps.engineCharacterId);
    const runCharacter = (): character | groupChat | undefined => {
        if (!deps.runCharacterId) {
            return undefined;
        }
        if (deps.frozen) {
            return scope.db.characters.find((entry) => entry?.chaId === deps.runCharacterId);
        }
        return (store.get(charactersKind, deps.runCharacterId)?.data ?? undefined) as character | groupChat | undefined;
    };
    const refreshAll = () => {
        if (deps.frozen) {
            return;
        }
        if (refreshChat(store, scope)) {
            lastChat = scopeChat(scope);
        }
        refreshCharacter(store, kinds, scope, deps.engineCharacterId);
        if (deps.runCharacterId && deps.runCharacterId !== deps.engineCharacterId) {
            refreshCharacter(store, kinds, scope, deps.runCharacterId);
        }
    };

    /**
     * One write to the job's chat: the chat is read again first and `build` makes the ops from it
     * (indexes resolved, messages and metadata copied from the stored state, never an older copy),
     * written with that revision; nothing when it returns null.
     */
    const writeChat = (build: (chat: Chat) => ChatOp[] | null, ctx?: HostContext): void => {
        fence(ctx);
        if (deps.frozen) {
            throw latch(new LuaJobFatalError("A render does not write the chat"));
        }
        refreshAll();
        const current = scopeChat(scope);
        if (!current) {
            return;
        }
        const ops = build(current);
        if (!ops || ops.length === 0) {
            return;
        }
        if (deps.lock && touchesGenerating(ops, current)) {
            console.warn("[Lua] A chat change was refused: a message is being generated");
            return;
        }
        try {
            job.write(() => ({
                chats: [
                    { characterId: scope.characterId, chatId: scope.chatId, baseRevision: scope.chatRevision, ops },
                ],
            }));
        } catch (error) {
            if (
                error instanceof JobWriteConflictError &&
                error.conflicts.length > 0 &&
                error.conflicts.every((conflict) => conflict.kind === "chat" && conflict.reason === "generating")
            ) {
                // A message another generation owns: skipped, as the client's `liveWrite` skips it.
                console.warn("[Lua] A chat change was refused: a message is being generated");
                refreshAll();
                return;
            }
            throw latch(error);
        }
        refreshAll();
        job.emitRecords({ chats: [{ characterId: scope.characterId, id: scope.chatId }] });
    };

    /** Whether `ops` rewrite or remove a message a generation owns (the store lets this job's own through). */
    const touchesGenerating = (ops: ChatOp[], chat: Chat): boolean => {
        const ids: string[] = [];
        for (const op of ops) {
            if (op.op === "setText" || op.op === "setTranslation") {
                ids.push(op.id);
            } else if (op.op === "setMessage") {
                ids.push(op.message.chatId!);
            } else if (op.op === "remove") {
                ids.push(...op.ids);
            } else if (op.op === "replace" || op.op === "delete") {
                ids.push(...chat.message.map((message) => message.chatId!));
            }
        }
        return ids.some((id) => deps.lock!.holder(scope.characterId, scope.chatId, id) !== null);
    };

    /** `setChatVarOf` for the job's chat: the whole `scriptstate` as stored now, true when it changed. */
    const setChatVar = (key: string, value: string, ctx?: HostContext): boolean => {
        const stateKey = "$" + key;
        if (deps.frozen) {
            // The render's own copy: the target's later stages read it, nothing is stored.
            fence(ctx);
            const chat = scopeChat(scope);
            if (!chat || chat.scriptstate?.[stateKey] === value) {
                return false;
            }
            chat.scriptstate = { ...(chat.scriptstate ?? {}), [stateKey]: value };
            return true;
        }
        let changed = false;
        writeChat((chat) => {
            if (chat.scriptstate?.[stateKey] === value) {
                return null;
            }
            changed = true;
            return [{ op: "meta", set: { scriptstate: { ...(chat.scriptstate ?? {}), [stateKey]: value } } }];
        }, ctx);
        return changed;
    };

    const cbsHost: CbsHost = createJobCbsHost(scope, {
        rootDir: deps.rootDir,
        setChatVar: (key, value) => setChatVar(key, value),
        client: job.context.client,
        triggerId: deps.triggerId ?? null,
        limits: serverCbsLimits(deps.cbsUsage ?? { usedMs: 0 }),
    });
    const bounded = createCbsEvaluator(cbsHost);
    /**
     * Every CBS evaluation of the run. A reached limit is the job's, not the text's or a script's: it
     * is latched, so the job ends with it whatever evaluated the text (a Lua `cbs` inside `pcall`, a
     * regex script's host call, a trigger effect), and nothing is evaluated after a fatal failure.
     */
    const evaluator: CbsEvaluator = {
        risuChatParser: (text, arg) => {
            if (fatalError) {
                throw fatalError;
            }
            try {
                return bounded.risuChatParser(text, arg);
            } catch (error) {
                if (error instanceof CbsLimitError) {
                    const name = engineCharacter()?.name;
                    throw latch(new LuaJobFatalError(name ? `${error.message} (${name})` : error.message));
                }
                throw error;
            }
        },
    };
    const parse = (text: string) =>
        evaluator.risuChatParser(text, { chara: engineCharacter() as character, chatRef: ref });

    const embeddingEnv = (ctx: HostContext): EmbeddingEnv => {
        if (!deps.embeddings) {
            throw new Error("The embeddings service is not available");
        }
        return deps.embeddings.forJob({
            db: scope.db,
            // The write-only memory key is in the request projection, never in the job's `db`.
            supaMemoryKey: scope.request.db.supaMemoryKey ?? "",
            signal: AbortSignal.any([job.signal, ctx.signal]),
        });
    };
    const similarity = async (source: string, values: string[], ctx: HostContext): Promise<string[]> => {
        fence(ctx);
        const processer = new HypaProcesser(embeddingEnv(ctx));
        try {
            await processer.addText(values);
            fence(ctx);
            return await processer.similaritySearch(source);
        } finally {
            // An abort inside the search is the job's end, whatever the caller does with the error.
            fence(ctx);
        }
    };

    /** Patches the run's character (`updateCharacter`): the record read again on the one retry. */
    const patchCharacter = (patch: Record<string, unknown>, ctx: HostContext): boolean => {
        fence(ctx);
        const id = deps.runCharacterId;
        if (!id || !store.get(charactersKind, id)) {
            return false;
        }
        let applied = false;
        try {
            job.write(() => {
                const row = store.get(charactersKind, id);
                applied = !!row;
                return row
                    ? {
                          ops: [
                              {
                                  kind: charactersKind,
                                  id,
                                  baseRevision: row.revision,
                                  data: { ...(row.data as object), ...patch },
                              },
                          ],
                      }
                    : {};
            });
        } catch (error) {
            throw latch(error);
        }
        if (applied) {
            refreshAll();
            job.emitRecords({ refs: [{ kind: RESOURCE_KIND.characters, id }] });
        }
        return applied;
    };

    /**
     * `updatePersona(id, { personaPrompt })`: the one entry of the personas list, the others kept,
     * read again on the one retry; false when the persona is gone (never recreated).
     */
    const patchPersonaPrompt = (personaId: string, value: string, ctx: HostContext): boolean => {
        fence(ctx);
        let applied = false;
        try {
            job.write(() => {
                const row = store.get(personasKind, SINGLETON_RESOURCE_ID);
                const list = Array.isArray(row?.data) ? (row.data as Record<string, unknown>[]) : [];
                const index = list.findIndex((entry) => entry?.id === personaId);
                applied = !!row && index !== -1;
                if (!row || index === -1) {
                    return {};
                }
                const next = list.slice();
                next[index] = { ...list[index], personaPrompt: value };
                return {
                    ops: [{ kind: personasKind, id: SINGLETON_RESOURCE_ID, baseRevision: row.revision, data: next }],
                };
            });
        } catch (error) {
            throw latch(error);
        }
        if (applied) {
            job.emitRecords({ refs: [{ kind: RESOURCE_KIND.personas, id: SINGLETON_RESOURCE_ID }] });
        }
        return applied;
    };

    const isSafe = (ctx: HostContext) => ctx.access === "safe" || ctx.access === "lowLevel";
    const isSafeOrEdit = (ctx: HostContext) => isSafe(ctx) || ctx.access === "editDisplay";
    const isLow = (ctx: HostContext) => ctx.access === "lowLevel";
    const messages = () => engineChat().message;
    const project = (message: Message | undefined) =>
        message ? { role: message.role, data: message.data, time: message.time ?? 0 } : null;
    const roleOf = (role: unknown): "user" | "char" => (role === "user" ? "user" : "char");
    /** The client's `replaceCopyMessage`: the copy's message objects may be shared, so they are replaced. */
    const replaceCopyMessage = (chat: Chat, index: number, message: Message) => {
        chat.message[index < 0 ? chat.message.length + index : index] = message;
    };

    /** A channel question; a non-answered outcome raises in the script, a lost owner also ends the job. */
    const ask = async (
        question: GenerationQuestion,
        ctx: HostContext,
        options: { signal?: AbortSignal } = {},
    ): Promise<unknown> => {
        const result = await untilAborted(
            options.signal ? job.channel.ask(question, { signal: options.signal }) : job.channel.ask(question),
            ctx.signal,
        );
        if (result.outcome === "answered") {
            return result.value;
        }
        const message = `The ${question.kind} question ended: ${result.outcome}${result.error ? ` (${result.error})` : ""}`;
        // The caller withdrew its own question: its failure, not the job's.
        if (result.outcome === "aborted" && options.signal?.aborted) {
            throw new Error(message);
        }
        if (result.outcome === "timedOut" || result.outcome === "disconnected" || result.outcome === "aborted") {
            throw latch(new LuaJobFatalError(message));
        }
        throw new Error(message);
    };

    /**
     * A client callback; the answer's value, or an ordinary failure's text (a hook that failed, an
     * unregistered capability). A barrier or protocol failure, a timeout, a disconnect, or an abort
     * is fatal. The chat and characters are read again afterwards (the barrier flushed the tab).
     */
    const tryCallback = async <N extends CallbackName>(
        name: N,
        payload: CallbackPayloads[N],
        ctx: HostContext,
        options: { timeoutMs?: number; skipDisconnected?: boolean } = {},
    ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
        let result: CallbackResult;
        // Nothing is asked of the tab once the call or the job is over.
        fence(ctx);
        try {
            result = await untilAborted(
                job.channel.callback(
                    name,
                    payload,
                    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined,
                ),
                ctx.signal,
            );
        } finally {
            refreshAll();
        }
        if (options.skipDisconnected && result.outcome === "disconnected") {
            fence(ctx);
            return { ok: false, error: result.error ?? "No owner was connected" };
        }
        switch (result.outcome) {
            case "answered":
                return { ok: true, value: result.value };
            case "refused":
                return { ok: false, error: result.error ?? `The ${name} callback was refused` };
            case "failed":
                if (result.failure === "hook") {
                    return { ok: false, error: result.error ?? `The ${name} hook failed` };
                }
                throw latch(new LuaJobFatalError(`The ${name} callback failed (${result.failure}): ${result.error}`));
            default:
                throw latch(new LuaJobFatalError(`The ${name} callback ended: ${result.outcome}`));
        }
    };

    /** `tryCallback` with null for an ordinary failure. */
    const callback = async <N extends CallbackName>(
        name: N,
        payload: CallbackPayloads[N],
        ctx: HostContext,
        options: { timeoutMs?: number; skipDisconnected?: boolean } = {},
    ): Promise<unknown | null> => {
        const answer = await tryCallback(name, payload, ctx, options);
        return answer.ok ? answer.value : null;
    };

    /** Whether a stored inlay is a usable image: an image record whose media file is stored. */
    const isImageInlay = async (id: string) => {
        const meta = store.get(inlaysKind, id)?.data as InlayResource | undefined;
        if (!meta || meta.type !== "image" || typeof meta.asset !== "string" || meta.asset === "") {
            return false;
        }
        return await storageFileExists(deps.savePath, meta.asset);
    };
    /** `isImageInlay`, then the call's fence: an abort during the file check stops what follows. */
    const usableImage = async (id: string, ctx: HostContext) => {
        const usable = await isImageInlay(id);
        fence(ctx);
        return usable;
    };

    /** The answer `{ id }` of an image callback: the id asked for (if any), stored as a usable image. */
    const answeredInlayId = async (value: unknown, expected: string | null, ctx: HostContext): Promise<string> => {
        const id =
            value !== null && typeof value === "object" && !Array.isArray(value)
                ? (value as { id?: unknown }).id
                : undefined;
        if (typeof id !== "string" || (expected !== null && id !== expected) || !(await usableImage(id, ctx))) {
            throw latch(new LuaJobFatalError("The client answered an image inlay that is not stored"));
        }
        return id;
    };

    /** An inlay record written by the job (a new one, or replacing the one with `id`). */
    const writeInlay = (id: string, data: InlayResource, ctx: HostContext) => {
        fence(ctx);
        try {
            job.write(() => ({
                ops: [{ kind: inlaysKind, id, baseRevision: store.get(inlaysKind, id)?.revision ?? null, data }],
            }));
        } catch (error) {
            throw latch(error);
        }
        job.emitRecords({ refs: [{ kind: RESOURCE_KIND.inlays, id }] });
    };

    /** `getInlayAsset`: an inlay's media as a data URI (a signature: its JSON text), or null. */
    const readInlay = async (id: string) => {
        const row = store.get(inlaysKind, id);
        if (!row) {
            return null;
        }
        const meta = row.data as InlayResource;
        const base = {
            type: meta.type,
            ...(meta.width !== undefined ? { width: meta.width } : {}),
            ...(meta.height !== undefined ? { height: meta.height } : {}),
        };
        if (meta.type === "signature") {
            return { ...base, data: meta.text ?? "" };
        }
        if (!meta.asset) {
            return null;
        }
        const bytes = await readStorageFile(deps.savePath, meta.asset);
        if (!bytes) {
            return null;
        }
        return { ...base, data: `data:${mimeOf(meta)};base64,${Buffer.from(bytes).toString("base64")}` };
    };

    /** The image inlay `id` drawn by the tab's canvas (`inlayImage`), or null when the tab could not. */
    const drawInlay = async (payload: CallbackPayloads["inlayImage"], ctx: HostContext): Promise<string | null> => {
        const value = await callback("inlayImage", payload, ctx);
        return value === null ? null : await answeredInlayId(value, payload.id, ctx);
    };

    /** The `generateImage` callback: the stored inlay's id, or null for an ordinary failure. */
    const generateImageInlay = async (
        prompt: string,
        negative: string,
        characterId: string,
        ctx: HostContext,
        options: { timeoutMs?: number; skipDisconnected?: boolean } = {},
    ): Promise<string | null> => {
        const answer = await callback("generateImage", { prompt, negative, characterId }, ctx, options);
        return answer === null ? null : await answeredInlayId(answer, null, ctx);
    };

    /** The job's channel for the request layer: a callback it makes (an interceptor) refreshes the view after. */
    const refreshingChannel: JobChannel = {
        notice: (notice) => job.channel.notice(notice),
        ask: (question, options) => job.channel.ask(question, options),
        callback: async (name, payload, options) => {
            try {
                return await job.channel.callback(name, payload, options);
            } finally {
                refreshAll();
            }
        },
    };

    /** The job's MCP tools (slice 12), set below once the services exist; none without a registry. */
    let jobTools: JobTools | null = null;

    /** The native `request` trigger every request runs (`setRequestTrigger`), or none. */
    let requestTrigger: ((formated: OpenAIChat[]) => Promise<OpenAIChat[]>) | null = null;

    /**
     * A request of the job: the client's outer `requestChatData` around the server request layer. A
     * failure it throws that names no stage yet is the request's (its tool list included); a script's
     * (a replacer, the `request` trigger) or a write's keeps its own.
     */
    const request = (
        arg: RequestArgs,
        mode: ModelModeExtended,
        ctx: HostContext,
        source: RequestSource,
        meta?: { messageId?: string },
    ): Promise<requestDataResponse> =>
        runRequest(arg, mode, ctx, source, meta).catch((error: unknown) => {
            throw markFailure(error, { stage: "request" });
        });

    const runRequest = async (
        arg: RequestArgs,
        mode: ModelModeExtended,
        ctx: HostContext,
        source: RequestSource,
        meta?: { messageId?: string },
    ): Promise<requestDataResponse> => {
        const signal = AbortSignal.any([job.signal, ctx.signal]);
        const replacer = async <N extends "replacerbeforeRequest" | "replacerafterRequest">(
            name: N,
            payload: CallbackPayloads[N],
        ) => {
            let value: unknown;
            try {
                value = await callback(name, payload, ctx);
            } catch (error) {
                throw markFailure(error, { stage: "script" });
            }
            if (value === null) {
                // Registered when the job started, gone now (the hook threw or was removed): the
                // browser path's invokeHook rejects, so the request does too.
                throw markFailure(new Error(`The ${name} hook failed`), { stage: "script" });
            }
            return value;
        };
        const db = scope.request.db;
        // The client's `getTools()`: once per request, before the retry loop, whatever the mode.
        let toolSet: JobToolSet | null = null;
        if (jobTools) {
            try {
                toolSet = await jobTools.list(ctx);
            } catch (error) {
                // The job's end or a latched failure goes on as it is; a tool list that failed fails
                // the request, as the client's `getTools()` rejects.
                fence(ctx);
                return {
                    type: "fail",
                    result: `MCP: ${error instanceof Error ? error.message : String(error)}`,
                    noRetry: true,
                };
            }
        }
        const tools: JobRequestSpec["tools"] = {
            descriptors: toolSet?.descriptors ?? [],
            charge: () => (jobTools ? jobTools.charge() : true),
            limit: MAX_JOB_TOOL_CALLS,
            call: async (name, args) => {
                if (!jobTools || !toolSet) {
                    return [{ type: "text", text: `Tool ${name} not found on any MCP` }];
                }
                return jobTools.call(toolSet, name, args, ctx);
            },
        };
        return requestChatDataOuter(arg, mode, {
            db,
            signal,
            ...(requestTrigger ? { requestTrigger } : {}),
            isFatal: (error) => error instanceof LuaJobFatalError || fatalError !== null || signal.aborted,
            attempt: (attemptArg) =>
                deps.llm.runInJob({
                    jobId: job.id,
                    loaded: scope.request,
                    mode,
                    arg: attemptArg,
                    source,
                    chatRef: arg.chatRef ?? ref,
                    messageId: meta?.messageId ?? null,
                    tokenScope: tokenScopeFor(db),
                    mainModelImageInput: mainModelTakesImages(db),
                    channel: refreshingChannel,
                    parseCbs: (text, chatRef) => evaluator.risuChatParser(text, chatRef ? { chatRef } : undefined),
                    inlays: {
                        saveSignature: async (id: string, signature: InlaySignature) => {
                            writeInlay(
                                id,
                                { name: id, ext: "json", type: "signature", text: JSON.stringify(signature) },
                                ctx,
                            );
                            return id;
                        },
                        writeImage: async (image) => {
                            const drawn = await drawInlay(
                                { id: image.id, mimeType: image.mimeType, data: image.data },
                                ctx,
                            );
                            if (!drawn) {
                                throw new Error("The inlay image could not be written");
                            }
                            return drawn;
                        },
                        setAsset: async (asset) => {
                            const base64 = asset.data.slice(asset.data.indexOf(",") + 1);
                            const bytes = new Uint8Array(Buffer.from(base64, "base64"));
                            const key = mediaKey(bytes, asset.ext);
                            fence(ctx);
                            // The bytes are content-addressed: a file written as the job ends is inert.
                            await writeStorageFile(deps.savePath, key, bytes);
                            writeInlay(
                                asset.id,
                                { name: asset.name, ext: asset.ext, type: "audio", asset: key, size: bytes.byteLength },
                                ctx,
                            );
                        },
                    },
                    alertError: (text) => job.channel.notice({ kind: "alertError", payload: { message: text } }),
                    endJob: (message, failure) => {
                        latch(markFailure(new LuaJobFatalError(message), { stage: "request", ...failure }));
                    },
                    tools,
                    toolCalls: {
                        read: () => {
                            refreshAll();
                            return scopeChat(scope)?.toolCalls;
                        },
                        // Added to the map as stored (another writer's entries stay).
                        write: (record) =>
                            writeChat(() => [{ op: "meta", merge: { toolCalls: { [record.call.id]: record } } }], ctx),
                    },
                    signal,
                }),
            ...(job.hooks.replacers.beforeRequest
                ? {
                      beforeRequest: async (formated: OpenAIChat[], model: string) => {
                          const value = await replacer("replacerbeforeRequest", { messages: formated, model });
                          if (!Array.isArray(value)) {
                              throw latch(
                                  markFailure(
                                      new LuaJobFatalError("The replacerbeforeRequest answer is not a message list"),
                                      { stage: "script" },
                                  ),
                              );
                          }
                          return value as OpenAIChat[];
                      },
                  }
                : {}),
            ...(job.hooks.replacers.afterRequest
                ? {
                      afterRequest: async (text: string, model: string) => {
                          const value = await replacer("replacerafterRequest", { text, model });
                          if (typeof value !== "string") {
                              throw latch(
                                  markFailure(new LuaJobFatalError("The replacerafterRequest answer is not a string"), {
                                      stage: "script",
                                  }),
                              );
                          }
                          return value;
                      },
                  }
                : {}),
        });
    };

    /** `collectLuaStreamText`: the last snapshot's first entry. */
    const collectStreamText = async (stream: ReadableStream<StreamResponseChunk>) => {
        const reader = stream.getReader();
        let text = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (value && typeof value["0"] === "string") {
                    text = value["0"];
                }
            }
        } finally {
            reader.releaseLock();
        }
        return text;
    };

    const parseLuaOptions = (optionsStr?: unknown) => {
        if (!optionsStr || typeof optionsStr !== "string") {
            return {};
        }
        try {
            const parsed = JSON.parse(optionsStr);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            return {};
        }
    };

    /** `LLMMain` and `axLLMMain`: the prompt parsed before the key check, as the client parses it. */
    const llmMain = async (args: unknown[], ctx: HostContext, mode: "model" | "otherAx") => {
        const [, promptStr, useMultimodal = false, optionsStr = ""] = args;
        const prompt = JSON.parse(promptStr as string) as ParsedPrompt;
        if (!isLow(ctx)) {
            return undefined;
        }
        const promptbody: OpenAIChat[] = prompt.map((dict) => {
            let role: "system" | "user" | "assistant" = "assistant";
            switch (dict["role"]) {
                case "system":
                case "sys":
                    role = "system";
                    break;
                case "user":
                    role = "user";
                    break;
                case "assistant":
                case "bot":
                case "char": {
                    role = "assistant";
                    break;
                }
            }
            return { content: dict["content"] ?? "", role };
        });
        if (useMultimodal) {
            for (const msg of promptbody) {
                const inlays: string[] = [];
                msg.content = msg.content.replace(
                    /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                    (_match: string, p1: string, p2: string) => {
                        if (msg.role === "assistant") {
                            if (p2 && p1 === "inlayeddata") {
                                inlays.push(p2);
                            }
                        } else if (p2) {
                            inlays.push(p2);
                        }
                        return "";
                    },
                );
                const multimodals: MultiModal[] = [];
                for (const inlay of inlays) {
                    const inlayData = await readInlay(inlay);
                    fence(ctx);
                    multimodals.push({
                        type: inlayData?.type as MultiModal["type"],
                        base64: inlayData?.data as string,
                        width: inlayData?.width,
                        height: inlayData?.height,
                    });
                }
                msg.multimodals = multimodals.length > 0 ? multimodals : undefined;
            }
        }
        const options = parseLuaOptions(optionsStr) as { streaming?: boolean };
        const result = await request(
            {
                formated: promptbody,
                bias: {},
                useStreaming: options.streaming === true,
                forceStreaming: options.streaming === true,
                noMultiGen: true,
                chatRef: ref,
            } as RequestArgs,
            mode,
            ctx,
            "lua",
        );
        if (result.type === "fail") {
            return JSON.stringify({ success: false, result: "Error: " + result.result });
        }
        if (result.type === "streaming") {
            try {
                return JSON.stringify({ success: true, result: await collectStreamText(result.result) });
            } catch (error) {
                return JSON.stringify({ success: false, result: "Error: " + error });
            }
        }
        if (result.type === "multiline") {
            return JSON.stringify({ success: false, result: result.result });
        }
        return JSON.stringify({ success: true, result: result.result });
    };

    /** `loadLoreBookV3Prompt` of the job's chat as stored now, for `selectedChar` (the chat owner). */
    const activateJobLore = (selectedChar: character, ctx: HostContext) => {
        return activateLore(
            {
                character: selectedChar,
                chat: liveChat(),
                moduleLorebooks: jobModuleLorebooks(scope, ref),
                loreBookDepth: scope.db.loreBookDepth,
                loreBookToken: scope.db.loreBookToken,
                userName: cbsHost.getUserName(ref),
            },
            {
                clone: (value) => structuredClone(value),
                findCharacterName: (id) => cbsHost.findCharacterById(id)?.name,
                getChatVar: (key) => cbsHost.getChatVar(key, ref),
                setChatVar: (key, value) => {
                    setChatVar(key, value, ctx);
                },
                pickHashRand,
                parseCBS: (text) => evaluator.risuChatParser(text, { chara: selectedChar, chatRef: ref }),
                tokenize: (text) => deps.tokens.count(text, tokenScopeFor(scope.request.db)),
                testRegex: async (pattern, flags, text) => {
                    const result = await ctx.regex({ op: "test", pattern, flags, input: text });
                    if ("error" in result) {
                        throw new Error(result.error);
                    }
                    return result.value === true;
                },
            },
        );
    };

    const lastMessageOf = (role: "char" | "user") => {
        const chat = engineChat();
        if (!chat) {
            return "";
        }
        let pointer = chat.message.length - 1;
        while (pointer >= 0) {
            if (chat.message[pointer].role === role) {
                return chat.message[pointer].data;
            }
            pointer--;
        }
        return null;
    };

    const sync: NonNullable<LuaHost["sync"]> = {
        getChatVar: ([, key]) => (working ? working.getVar(key as string) : cbsHost.getChatVar(key as string, ref)),
        setChatVar: ([, key, value], ctx) => {
            if (!isSafeOrEdit(ctx)) {
                return undefined;
            }
            if (working) {
                working.setVar(key as string, value as string);
            } else {
                setChatVar(key as string, value as string, ctx);
            }
            return undefined;
        },
        setChatVarChanged: ([, key, value], ctx) => {
            if (!isSafeOrEdit(ctx)) {
                return undefined;
            }
            const changed = working
                ? working.setVar(key as string, value as string)
                : setChatVar(key as string, value as string, ctx);
            return changed === true ? true : undefined;
        },
        getGlobalVar: ([, key]) => cbsHost.getGlobalChatVar(key as string, ref),
        alertError: ([, value], ctx) => {
            if (isSafe(ctx)) {
                job.channel.notice({ kind: "alertError", payload: { message: String(value) } });
            }
            return undefined;
        },
        alertNormal: ([, value], ctx) => {
            if (isSafe(ctx)) {
                job.channel.notice({ kind: "alertNormal", payload: { message: String(value) } });
            }
            return undefined;
        },
        getChatMain: ([, index]) => JSON.stringify(project(messages().at(index as number))),
        getChatData: ([, index]) => messages().at(index as number)?.data ?? "",
        getChatRole: ([, index]) => messages().at(index as number)?.role ?? "",
        getRecentChatsMain: ([, count]) => {
            const chats = messages();
            const safeCount = Math.max(0, Math.floor((count as number) || 0));
            const start = Math.max(0, chats.length - safeCount);
            return JSON.stringify(chats.slice(start).map((v) => project(v)));
        },
        setChat: ([, index, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (working) {
                const message = working.chat.message?.at(index as number);
                if (message) {
                    replaceCopyMessage(working.chat, index as number, { ...message, data: (value as string) ?? "" });
                }
                return undefined;
            }
            writeChat((chat) => {
                const message = chat.message.at(index as number);
                return message?.chatId ? [{ op: "setText", id: message.chatId, text: (value as string) ?? "" }] : null;
            }, ctx);
            return undefined;
        },
        setChatRole: ([, index, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (working) {
                const message = working.chat.message?.at(index as number);
                if (message) {
                    replaceCopyMessage(working.chat, index as number, { ...message, role: roleOf(value) });
                }
                return undefined;
            }
            writeChat((chat) => {
                const message = chat.message.at(index as number);
                return message?.chatId
                    ? [{ op: "setMessage", message: { ...structuredClone(message), role: roleOf(value) } }]
                    : null;
            }, ctx);
            return undefined;
        },
        cutChat: ([, start, end], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (working) {
                working.chat.message = working.chat.message.slice(start as number, end as number);
                return undefined;
            }
            writeChat((chat) => {
                const kept = new Set(chat.message.slice(start as number, end as number));
                const removed = chat.message.filter((message) => !kept.has(message)).map((message) => message.chatId!);
                return removed.length > 0 ? [{ op: "remove", ids: removed }] : null;
            }, ctx);
            return undefined;
        },
        removeChat: ([, index], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (working) {
                working.chat.message.splice(index as number, 1);
                return undefined;
            }
            writeChat((chat) => {
                const message = chat.message.at(index as number);
                return message?.chatId ? [{ op: "remove", ids: [message.chatId] }] : null;
            }, ctx);
            return undefined;
        },
        addChat: ([, role, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (working) {
                working.chat.message.push({ role: roleOf(role), data: (value as string) ?? "" });
                return undefined;
            }
            writeChat(
                () => [
                    {
                        op: "append",
                        messages: [{ role: roleOf(role), data: (value as string) ?? "", chatId: randomUUID() }],
                        anchor: { end: true },
                    },
                ],
                ctx,
            );
            return undefined;
        },
        insertChat: ([, index, role, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (working) {
                working.chat.message.splice(index as number, 0, { role: roleOf(role), data: (value as string) ?? "" });
                return undefined;
            }
            writeChat((chat) => {
                // Where `splice(index, 0, ...)` would insert.
                const all = chat.message;
                const at = index as number;
                const position = at < 0 ? Math.max(all.length + at, 0) : Math.min(at, all.length);
                const anchor = position === 0 ? { start: true as const } : { after: all[position - 1].chatId! };
                return [
                    {
                        op: "append",
                        messages: [{ role: roleOf(role), data: (value as string) ?? "", chatId: randomUUID() }],
                        anchor,
                    },
                ];
            }, ctx);
            return undefined;
        },
        getChatLength: () => messages().length,
        getFullChatMain: () => JSON.stringify(messages().map((v) => project(v))),
        cbs: ([value]) => parse(value as string),
        setFullChatMain: ([, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            const realValue = JSON.parse(value as string) as { role: unknown; data: unknown }[];
            if (working) {
                // The copy's list: the final application gives the messages new ids.
                working.chat.message = realValue.map((v) => ({
                    role: v.role as Message["role"],
                    data: v.data as string,
                }));
                return undefined;
            }
            // A whole-list replacement: the messages get new ids, as before.
            const replaced: Message[] = realValue.map((v) => ({
                role: v.role as Message["role"],
                data: v.data as string,
                chatId: randomUUID(),
            }));
            writeChat((chat) => [{ op: "replace", chat: { ...structuredClone(chat), message: replaced } }], ctx);
            return undefined;
        },
        reloadDisplay: (_args, ctx) => {
            if (isSafe(ctx)) {
                job.channel.notice({ kind: "reloadDisplay", payload: {} });
            }
            return undefined;
        },
        reloadChat: ([, index], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            // The displayed (live) chat's message at that position.
            const live = liveChat().message;
            const message = Number.isInteger(index) && (index as number) >= 0 ? live[index as number] : undefined;
            if (message?.chatId) {
                job.channel.notice({
                    kind: "reloadChat",
                    payload: { chaId: scope.characterId, chatId: scope.chatId, messageId: message.chatId },
                });
            }
            return undefined;
        },
        getName: () => {
            const target = runCharacter();
            return target ? target.name : "";
        },
        setName: ([, name], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (typeof name !== "string") {
                throw new Error("Invalid data type");
            }
            if (patchCharacter({ name }, ctx)) {
                characterPatched({ name });
            }
            return undefined;
        },
        getDescription: (_args, ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            const target = runCharacter();
            if (target?.type === "group") {
                throw new Error("Character is a group");
            }
            return target ? target.desc : "";
        },
        setDescription: ([, desc], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (typeof desc !== "string") {
                throw new Error("Invalid data type");
            }
            if (runCharacter()?.type === "group") {
                throw new Error("Character is a group");
            }
            if (patchCharacter({ desc }, ctx)) {
                characterPatched({ desc });
            }
            return undefined;
        },
        getCharacterFirstMessage: () => {
            const target = runCharacter();
            return target ? target.firstMessage : "";
        },
        setCharacterFirstMessage: ([, data], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (typeof data !== "string") {
                return false;
            }
            const applied = patchCharacter({ firstMessage: data }, ctx);
            if (applied) {
                characterPatched({ firstMessage: data });
            }
            return applied;
        },
        getPersonaName: () => cbsHost.getUserName(ref),
        getPersonaDescription: () => parse(cbsHost.getPersonaPrompt(ref)),
        getAuthorsNote: () => engineChat()?.note ?? "",
        getBackgroundEmbedding: (_args, ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            const target = runCharacter();
            return target ? target.backgroundHTML : "";
        },
        setBackgroundEmbedding: ([, data], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (typeof data !== "string") {
                return false;
            }
            const applied = patchCharacter({ backgroundHTML: data }, ctx);
            if (applied) {
                characterPatched({ backgroundHTML: data });
            }
            return applied;
        },
        getLoreBooksMain: ([, search]) => {
            const selectedChar = engineCharacter() as character | groupChat;
            if (selectedChar.type !== "character") {
                return undefined;
            }
            const loreSources: loreBook[][] = [
                engineChat()?.localLore ?? [],
                selectedChar.globalLore,
                jobModuleLorebooks(scope, ref),
            ];
            const found = [];
            for (const source of loreSources) {
                for (const b of source) {
                    if (b.comment === search) {
                        found.push({
                            ...b,
                            content: evaluator.risuChatParser(b.content, { chara: selectedChar, chatRef: ref }),
                        });
                    }
                }
            }
            return JSON.stringify(found);
        },
        upsertLocalLoreBookMain: ([, name, content, optionsJson], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            if (runCharacter()?.type !== "character") {
                return undefined;
            }
            const options = JSON.parse(optionsJson as string) as {
                alwaysActive?: boolean;
                insertOrder?: number;
                key?: string;
                secondKey?: string;
                regex?: boolean;
            };
            const { alwaysActive = false, insertOrder = 100, key = "", regex = false, secondKey = "" } = options;
            const upserted = (localLore: loreBook[] | undefined): loreBook[] => {
                const newLocalLoreBooks = (structuredClone(localLore ?? []) as loreBook[]).filter(
                    (book) => book.comment !== name,
                );
                newLocalLoreBooks.push({
                    alwaysActive,
                    comment: name as string,
                    content: content as string,
                    insertorder: insertOrder,
                    mode: "normal",
                    key,
                    secondkey: secondKey,
                    selective: !!secondKey,
                    useRegex: regex,
                });
                return newLocalLoreBooks;
            };
            if (working) {
                working.chat.localLore = upserted(working.chat.localLore);
                return undefined;
            }
            writeChat((chat) => [{ op: "meta", set: { localLore: upserted(chat.localLore) } }], ctx);
            return undefined;
        },
        getCharacterLastMessage: () => {
            const found = lastMessageOf("char");
            // The client falls back to the selected character's greeting: the chat's owner here.
            return found === null ? (engineCharacter() as character).firstMessage : found;
        },
        getUserLastMessage: () => lastMessageOf("user") ?? "",
    };

    const async: NonNullable<LuaHost["async"]> = {
        alertInputMain: async ([, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            const answer = await ask({ kind: "alertInput", payload: { message: String(value) } }, ctx);
            return typeof answer === "string"
                ? answer
                : answer === null || answer === undefined
                  ? undefined
                  : String(answer);
        },
        alertSelectMain: async ([, optionsJson], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            const options = JSON.parse(optionsJson as string) as unknown;
            if (!Array.isArray(options)) {
                throw new Error("alertSelect needs a list of options");
            }
            const answer = await ask({ kind: "alertSelect", payload: { options: options.map(String) } }, ctx);
            return typeof answer === "string"
                ? answer
                : answer === null || answer === undefined
                  ? undefined
                  : String(answer);
        },
        alertConfirmMain: async ([, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            const answer = await ask({ kind: "alertConfirm", payload: { message: String(value) } }, ctx);
            return answer ? true : false;
        },
        getTokens: async ([, value], ctx) => {
            if (!isSafe(ctx)) {
                return undefined;
            }
            return await deps.tokens.count(value as string, tokenScopeFor(scope.request.db));
        },
        similarityMain: async ([, source, value], ctx) => {
            if (!isLow(ctx)) {
                return undefined;
            }
            // The table crosses as JSON both ways (the prelude encodes the values and decodes the result).
            const values = JSON.parse(value as string) as unknown;
            return JSON.stringify(
                await similarity(source as string, Array.isArray(values) ? (values as string[]) : [], ctx),
            );
        },
        generateImage: async ([, value, negValue = ""], ctx) => {
            if (!isLow(ctx)) {
                return undefined;
            }
            const target = runCharacter();
            if (!target || target.type === "group" || !deps.runCharacterId) {
                // No character to generate for: refused without asking the tab.
                return "Error: Image generation failed";
            }
            const id = await generateImageInlay(String(value ?? ""), String(negValue ?? ""), deps.runCharacterId, ctx);
            return id === null ? "Error: Image generation failed" : `{{inlay::${id}}}`;
        },
        getCharacterImageMain: async (_args, ctx) => {
            const character = engineCharacter();
            if (!character || character.type === "group" || !character.image) {
                return "";
            }
            const key = character.image;
            if (await usableImage(key, ctx)) {
                return `{{inlayed::${key}}}`;
            }
            const drawn = await drawInlay({ id: key, asset: key }, ctx);
            return drawn ? `{{inlayed::${drawn}}}` : "";
        },
        getPersonaImageMain: async (_args, ctx) => {
            const icon = scope.effectivePersona.icon;
            if (!icon) {
                return "";
            }
            if (await usableImage(icon, ctx)) {
                return `{{inlayed::${icon}}}`;
            }
            const drawn = await drawInlay({ id: icon, asset: icon }, ctx);
            return drawn ? `{{inlayed::${drawn}}}` : "";
        },
        hash: async ([, value]) => sha256Hex(textEncoder.encode(value as string)),
        LLMMain: (args, ctx) => llmMain(args, ctx, "model"),
        axLLMMain: (args, ctx) => llmMain(args, ctx, "otherAx"),
        simpleLLMMain: async ([, prompt], ctx) => {
            if (!isLow(ctx)) {
                return undefined;
            }
            const result = await request(
                {
                    formated: [{ role: "user", content: prompt as string }],
                    bias: {},
                    useStreaming: false,
                    noMultiGen: true,
                    chatRef: ref,
                } as RequestArgs,
                "model",
                ctx,
                "lua",
            );
            if (result.type === "fail") {
                return JSON.stringify({ success: false, result: "Error: " + result.result });
            }
            if (result.type === "streaming" || result.type === "multiline") {
                return JSON.stringify({ success: false, result: result.result });
            }
            return JSON.stringify({ success: true, result: result.result });
        },
        loadLoreBooksMain: async ([, reserveArg], ctx) => {
            if (!isLow(ctx)) {
                return undefined;
            }
            const selectedChar = engineCharacter() as character | groupChat | undefined;
            if (selectedChar?.type !== "character") {
                return undefined;
            }
            const counter = (text: string) => deps.tokens.count(text, tokenScopeFor(scope.request.db));
            const activation = await activateJobLore(selectedChar, ctx);
            fence(ctx);
            // The prelude calls `loadLoreBooksMain(id)` with no reserve: `maxContext - undefined` is
            // NaN, which caps nothing, as on the client.
            const reserve = reserveArg === null ? undefined : reserveArg;
            const maxContext = scope.db.maxContext - (reserve as number);
            if (maxContext < 0) {
                return JSON.stringify([]);
            }
            let totalTokens = 0;
            const loreBooks: { data: string; role: string }[] = [];
            for (const book of activation.actives) {
                const parsed = evaluator.risuChatParser(book.prompt, { chara: selectedChar, chatRef: ref }).trim();
                if (parsed.length === 0) {
                    continue;
                }
                const tokens = await counter(parsed);
                if (totalTokens + tokens > maxContext) {
                    break;
                }
                totalTokens += tokens;
                loreBooks.push({ data: parsed, role: book.role === "assistant" ? "char" : book.role });
            }
            return JSON.stringify(loreBooks);
        },
    };

    // Every host function checks the latch and the abort first.
    const guardedSync: NonNullable<LuaHost["sync"]> = {};
    for (const [name, fn] of Object.entries(sync)) {
        guardedSync[name] = (args, ctx) => {
            fence(ctx);
            return fn(args, ctx);
        };
    }
    const guardedAsync: NonNullable<LuaHost["async"]> = {};
    for (const [name, fn] of Object.entries(async)) {
        guardedAsync[name] = async (args, ctx) => {
            fence(ctx);
            const value = await fn(args, ctx);
            fence(ctx);
            return value;
        };
    }
    const services: LuaBindingServices = {
        fence,
        latch,
        liveChat,
        chatExists: () => scopeChat(scope) !== undefined,
        refresh: () => {
            refreshAll();
            return scopeChat(scope) !== undefined;
        },
        writeChat,
        setChatVar,
        getChatVar: (key) => cbsHost.getChatVar(key, ref),
        patchCharacter,
        patchPersonaPrompt,
        ask,
        notice: (notice) => job.channel.notice(notice),
        request,
        collectStreamText,
        generateImageInlay,
        tokenize: (text) => deps.tokens.count(text, tokenScopeFor(scope.request.db)),
        activateLore: (ctx) => activateJobLore(engineCharacter() as character, ctx),
        parse: (text, chara) =>
            evaluator.risuChatParser(text, { chara: (chara ?? undefined) as character, chatRef: ref }),
        calc: (text) => cbsHost.calcString(text),
        embeddings: embeddingEnv,
        similarity,
    };
    if (deps.mcp) {
        jobTools = createJobTools({
            job,
            scope,
            store,
            kinds,
            state: deps.mcp.state,
            registry: deps.mcp.registry,
            services: {
                fence,
                latch,
                refresh: services.refresh,
                ask,
                notice: services.notice,
                tryCallback,
                // `internal:aiaccess` `runLLM`, the only request an internal MCP makes.
                request: (arg, mode, ctx) => request(arg, mode, ctx, "mcp"),
                getChatVar: services.getChatVar,
                setChatVar,
                embeddings: embeddingEnv,
            },
        });
    }
    return {
        host: { sync: guardedSync, async: guardedAsync },
        fatal: () => fatalError,
        evaluator,
        services,
        async withWorking(next, fn) {
            const previous = working;
            working = next;
            try {
                return await fn();
            } finally {
                working = previous;
            }
        },
        observeCharacterPatches(listener) {
            characterListeners.add(listener);
            return () => characterListeners.delete(listener);
        },
        setRequestTrigger(trigger) {
            requestTrigger = trigger;
        },
        readInlay,
    };
}
