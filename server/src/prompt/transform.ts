import { createHash, randomUUID } from "node:crypto";
import type { character, Chat, groupChat } from "../../../shared/database.ts";
import { type GenerationContext, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { createScriptCache, type RegexScriptEffect } from "../../../shared/scripts/regex.ts";
import {
    MAX_TRANSFORM_REQUEST_TEXT_BYTES,
    MAX_TRANSFORM_TEXT_BYTES,
    TRANSFORM_SNAPSHOT_TTL_MS,
    type TransformContinueRequest,
    type TransformEmotion,
    type TransformRequest,
    type TransformResponse,
    type TransformResult,
    type TransformTarget,
} from "../../../shared/transform.ts";
import { GenerationRunnerError, type RunningJob } from "../jobs/generationJobs.ts";
import { type JobScope, jobScopeKinds, loadJobScope, scopeChat } from "../jobs/jobScope.ts";
import { createJobRunState, createRunSetup, type GenerationRunnerDeps, type RunSetup } from "../jobs/runSetup.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import type { LuaBudget } from "../scripts/workerPool.ts";
import { runLuaEdit, runScriptTail } from "./scripts.ts";
import { createTransformCache } from "./transformCache.ts";
import { TriggerEffectLimitError } from "./triggers.ts";

/** The transform cannot run now (maintenance, shutdown, too much queued work, its deadline): 503. */
export class TransformUnavailableError extends Error {}

/** A second call whose snapshot is gone (expired, used, another client, another epoch): 409. */
export class TransformSnapshotError extends Error {}

/** A request names targets the snapshot does not hold, or misses some: 400. */
export class TransformRequestError extends Error {}

/** A render tried to write: never reaches the store (the target fails). */
class TransformWriteRefusedError extends Error {
    constructor() {
        super("A render does not write");
    }
}

/** Transform requests running at once; the next ones wait in a queue of `MAX_QUEUED`. */
const MAX_ACTIVE = 4;
const MAX_QUEUED = 32;
/** Snapshots waiting for their second call, per client and in all. */
const MAX_SNAPSHOTS_PER_CLIENT = 4;
const MAX_SNAPSHOTS = 16;
/** What one snapshot keeps of its targets: their texts and the variables their Lua wrote. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Owners whose group members the cache probe remembers (`ownerMembers`). */
const MAX_OWNER_MEMBERS = 256;

/** What every target of one request shares: one Lua budget and CBS time. */
type Shared = {
    budget: LuaBudget;
    cbsUsage: { usedMs: number };
};

/** One target's run: its own scope copy, setup, and regex caches, its text so far. */
type TargetRun = {
    target: TransformTarget;
    key: string;
    generation: number;
    setup: RunSetup;
    source: character | groupChat;
    /** The variables as loaded (the target's writes are the entries of its copy that differ). */
    baseline: Chat["scriptstate"];
    scriptCache: ReturnType<typeof createScriptCache>;
    assetMatches: Map<string, string>;
    text: string;
};

/** One request (or a snapshot's two calls): its abort, its deadline, the epoch and maintenance it was admitted in. */
type Lifecycle = {
    controller: AbortController;
    /** `Date.now()` past which the render is over (from the first call's admission, queue time included). */
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    epoch: string;
    pauses: number;
};

type Snapshot = {
    id: string;
    clientId: string;
    mode: TransformRequest["mode"];
    life: Lifecycle;
    shared: Shared;
    runs: Map<string, TargetRun>;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** JSON with every object's keys sorted: the same value is the same text. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
            ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : entry,
    );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Aborts `controller` when `signal` aborts (at once when it already has); returns the unlink. */
function link(signal: AbortSignal, controller: AbortController): () => void {
    if (signal.aborted) {
        controller.abort(signal.reason ?? new Error("request aborted"));
        return () => {};
    }
    const onAbort = () => controller.abort(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
}

/** The bytes a target's run keeps: its text and the variables its Lua wrote. */
function retainedBytes(run: TargetRun): number {
    let bytes = Buffer.byteLength(run.text);
    const state = scopeChat(run.setup.scope)?.scriptstate ?? {};
    for (const [key, value] of Object.entries(state)) {
        if (run.baseline?.[key] !== value) {
            bytes += Buffer.byteLength(key) + Buffer.byteLength(String(value));
        }
    }
    return bytes;
}

/**
 * The script transform: `processScriptFull`'s `editdisplay` and `editprocess` stages for targets
 * the tab sends, read-only. One `loadJobScope` per request the cache does not answer whole (the ids
 * the tab captured; a missing record fails the request, 404), then per target an isolated run on a
 * copy of that snapshot: its own chat object (`scriptstate` copied: a Lua or CBS variable write
 * changes it for the target's later stages and is never stored), its own owner object and character
 * list, its own regex and dynamic-asset caches, and a setup built as a job's (`createRunSetup`) on
 * a job that cannot write, ask, or call the tab, with frozen bindings (no character or chat
 * re-read, chat writes refused). The targets share one Lua budget and CBS time.
 *
 * `editdisplay`, in the client's order: Lua `editDisplay` on the source character (the speaking
 * member in a group) with `meta.index`; the `display` trigger on the chat's owner and chat, groups
 * included (today the selection's, skipped for a group: a recorded change); the tab's plugin
 * handlers (the two-call protocol); CBS, the regex scripts, the dynamic assets (`runScriptTail`):
 * `@@emo` returned as the target's emotions, `@@inject` discarded. `editprocess`: the plugin
 * handlers, then `runScriptTail`. A script's own failure keeps today's behavior (Lua: the input, the
 * next trigger; the display trigger: the text kept); an abort, a spent limit, a latched host
 * failure, a worker failure, or a refused write fails the target (`{ ok: false }`, nothing cached).
 * A text after the stages before the plugin handlers is bounded as the second call's texts are.
 *
 * Results are cached (`transformCache.ts`) under a digest of the epoch, the target, the context,
 * the handler set, the revisions the load read (every section and collection, the presets, the
 * modules, the owner, the source, a group's members), and the chat's variables, author's note,
 * local lore, name, modules, bound persona, bound presets, and greeting index; not the viewport or
 * the other messages. `noCache` replaces the entry. A cached result keeps its emotions;
 * the tab applies a key's emotions once. A request whose every target has an entry is answered
 * before the load (`cachedResults`: revisions and the chat's metadata only, no record parsed).
 *
 * Lifecycle: a request is registered (its controller, its deadline, the epoch, the maintenance
 * count) when it is admitted, before it waits for one of `MAX_ACTIVE` slots (`MAX_QUEUED` may wait;
 * more are refused). `pause` (maintenance) aborts every request, queued or running, and every
 * snapshot, and empties the cache; a request admitted before a maintenance never runs after it.
 * `close` (shutdown) refuses new work, aborts, and waits for the runs. One deadline,
 * `TRANSFORM_SNAPSHOT_TTL_MS` from the first call's admission, covers both calls of a snapshot.
 */
export function createTransformService(runnerDeps: GenerationRunnerDeps) {
    // No MCP: a render calls no tools.
    const deps: GenerationRunnerDeps = { ...runnerDeps, mcp: undefined };
    const { store, kinds } = deps;
    const cache = createTransformCache();
    const snapshots = new Map<string, Snapshot>();
    const lives = new Set<Lifecycle>();
    const running = new Set<Promise<unknown>>();
    let paused = 0;
    /** How many maintenances began: a request admitted before one does not run after it. */
    let pauses = 0;
    let closed = false;
    let active = 0;
    const queue: { grant: () => void }[] = [];

    const admitCheck = () => {
        if (closed) {
            throw new TransformUnavailableError("The server is shutting down");
        }
        if (paused > 0) {
            throw new TransformUnavailableError("The server data is being replaced");
        }
    };

    /** A request admitted now: registered (maintenance and shutdown reach it from here on). */
    const admit = (): Lifecycle => {
        admitCheck();
        const controller = new AbortController();
        const deadline = Date.now() + TRANSFORM_SNAPSHOT_TTL_MS;
        const life: Lifecycle = {
            controller,
            deadline,
            timer: setTimeout(
                () => controller.abort(new TransformUnavailableError("The render took too long")),
                TRANSFORM_SNAPSHOT_TTL_MS,
            ),
            epoch: store.epoch(),
            pauses,
        };
        life.timer.unref?.();
        lives.add(life);
        return life;
    };

    const retire = (life: Lifecycle) => {
        clearTimeout(life.timer);
        lives.delete(life);
    };

    /**
     * Throws when the request's lifetime ended (its abort, or its deadline, read from the clock: a
     * timer held back by synchronous work does not extend it) or a maintenance began since it was
     * admitted.
     */
    const stillValid = (life: Lifecycle) => {
        if (!life.controller.signal.aborted && Date.now() >= life.deadline) {
            life.controller.abort(new TransformUnavailableError("The render took too long"));
        }
        if (life.controller.signal.aborted) {
            throw life.controller.signal.reason ?? new Error("request aborted");
        }
        if (closed || paused > 0 || life.pauses !== pauses || store.epoch() !== life.epoch) {
            throw new TransformUnavailableError("The server data was replaced");
        }
    };

    /** Hands the slot to the next waiter, or frees it. */
    const releaseSlot = () => {
        const next = queue.shift();
        if (next) {
            next.grant();
        } else {
            active--;
        }
    };

    /** A slot among `MAX_ACTIVE`, ended by the lifetime's abort while it waits; resolves with its release. */
    const acquire = async (life: Lifecycle): Promise<() => void> => {
        const signal = life.controller.signal;
        stillValid(life);
        if (active < MAX_ACTIVE) {
            active++;
        } else {
            if (queue.length >= MAX_QUEUED) {
                throw new TransformUnavailableError("Too many renders are waiting");
            }
            await new Promise<void>((resolve, reject) => {
                const entry = {
                    grant: () => {
                        signal.removeEventListener("abort", onAbort);
                        resolve();
                    },
                };
                const onAbort = () => {
                    const index = queue.indexOf(entry);
                    if (index >= 0) {
                        queue.splice(index, 1);
                    }
                    reject(signal.reason ?? new Error("request aborted"));
                };
                signal.addEventListener("abort", onAbort, { once: true });
                queue.push(entry);
            });
        }
        // The slot is this caller's now.
        try {
            stillValid(life);
        } catch (error) {
            releaseSlot();
            throw error;
        }
        let released = false;
        return () => {
            if (!released) {
                released = true;
                releaseSlot();
            }
        };
    };

    /** Runs `work` counted among the running (shutdown waits for it). */
    const track = <T>(work: Promise<T>): Promise<T> => {
        running.add(work);
        void work.finally(() => running.delete(work)).catch(() => {});
        return work;
    };

    const dropSnapshot = (snapshot: Snapshot, reason?: Error) => {
        if (snapshots.get(snapshot.id) === snapshot) {
            snapshots.delete(snapshot.id);
        }
        if (reason) {
            snapshot.life.controller.abort(reason);
            retire(snapshot.life);
        }
    };

    /** A job that cannot write, ask, or call the tab: what the setup needs of one. */
    const readOnlyJob = (context: GenerationContext, signal: AbortSignal, epoch: string): RunningJob => ({
        id: `transform-${randomUUID()}`,
        kind: "send",
        context,
        command: null,
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted", error: "A render asks nothing" }),
            callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "A render calls nothing" }),
        },
        ownerAttached: () => false,
        epoch,
        signal,
        emit() {
            throw new TransformWriteRefusedError();
        },
        emitRecords: () => [],
        write() {
            throw new TransformWriteRefusedError();
        },
        onClientMessage: () => () => {},
    });

    /**
     * The members of a chat's owner as a load read them, by the owner's id and revision (none for a
     * character): the cache probe keys a request without reading the owner's record.
     */
    const ownerMembers = new Map<string, readonly string[]>();
    const membersKey = (characterId: string, revision: string) => `${characterId}\0${revision}`;

    /** The owner's members of a loaded scope (none for a character), remembered for the probe. */
    const scopeMembers = (scope: JobScope): readonly string[] => {
        const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId);
        const members = owner?.type === "group" ? [...(owner.characters ?? [])] : [];
        const revision = scope.revisions?.get(`characters/${scope.characterId}`);
        if (revision !== undefined) {
            const key = membersKey(scope.characterId, revision);
            ownerMembers.delete(key);
            ownerMembers.set(key, members);
            if (ownerMembers.size > MAX_OWNER_MEMBERS) {
                ownerMembers.delete(ownerMembers.keys().next().value!);
            }
        }
        return members;
    };

    /**
     * The key parts every target of a request shares: what decides the render besides the target,
     * and what decides the load's checks (the chat's binding, the records it names), so an entry
     * answers only a request whose load would have passed.
     */
    const baseKey = (
        request: TransformRequest,
        revisions: ReadonlyMap<string, string> | undefined,
        characterId: string,
        members: readonly string[],
        epoch: string,
        chat: Chat,
    ): unknown[] => {
        const characterIds = new Set<string>([characterId, ...members]);
        const included: [string, string][] = [];
        for (const [name, revision] of revisions ?? []) {
            const slash = name.indexOf("/");
            if (name.slice(0, slash) !== "characters" || characterIds.has(name.slice(slash + 1))) {
                included.push([name, revision]);
            }
        }
        included.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return [
            epoch,
            request.mode,
            request.context,
            request.client?.browserLanguage ?? "",
            request.handlers ?? null,
            included,
            // What a render reads of the chat besides its messages (the history stays as first
            // rendered), and its binding (the load's check).
            sha256(
                canonical({
                    scriptstate: chat.scriptstate ?? {},
                    GLGlobalVariables: chat.GLGlobalVariables ?? {},
                    note: chat.note ?? "",
                    localLore: chat.localLore ?? [],
                    loreOverrides: chat.loreOverrides ?? [],
                    name: chat.name ?? "",
                    modules: chat.modules ?? [],
                    bindedPersona: chat.bindedPersona ?? null,
                    promptPresetId: chat.promptPresetId ?? null,
                    modelPresetId: chat.modelPresetId ?? null,
                    fmIndex: chat.fmIndex ?? -1,
                }),
            ),
        ];
    };

    const targetKey = (
        base: unknown[],
        revisions: ReadonlyMap<string, string> | undefined,
        target: TransformTarget,
    ): string =>
        sha256(
            canonical([
                ...base,
                target.kind,
                target.kind === "message" ? (target.messageId ?? null) : null,
                target.chatIndex,
                target.sourceId,
                revisions?.get(`characters/${target.sourceId}`) ?? null,
                target.cbsConditions ?? {},
                sha256(target.source),
            ]),
        );

    /**
     * The request's results from the cache alone, when every target has an entry: it reads the
     * revisions and the chat's metadata (no record's data, no message), so a render the cache
     * answers never loads the job scope (the sections, presets, modules, and rendered characters
     * parsed). Null when a target must run, the owner's members are not known for its revision, or
     * the chat is gone: the request then loads as before (and its load reports a missing record or
     * a binding refusal).
     */
    const cachedResults = (request: TransformRequest, epoch: string): TransformResult[] | null => {
        if (request.targets.length === 0 || request.targets.some((target) => target.noCache)) {
            return null;
        }
        const { characterId, chatId } = request.context;
        const read = store.readKindRevisions(jobScopeKinds(kinds));
        const chatRecord = store.chatMeta(characterId, chatId);
        if (read.epoch !== epoch || !chatRecord) {
            return null;
        }
        const revisions = new Map<string, string>();
        for (const [kindName, records] of Object.entries(read.kinds)) {
            for (const record of records) {
                revisions.set(`${kindName}/${record.id}`, record.revision);
            }
        }
        const ownerRevision = revisions.get(`characters/${characterId}`);
        const members =
            ownerRevision === undefined ? undefined : ownerMembers.get(membersKey(characterId, ownerRevision));
        if (!members) {
            return null;
        }
        const base = baseKey(request, revisions, characterId, members, epoch, chatRecord.data as Chat);
        const results: TransformResult[] = [];
        for (const target of request.targets) {
            const key = targetKey(base, revisions, target);
            const hit = cache.get(key);
            if (!hit) {
                return null;
            }
            results.push({ id: target.id, ok: true, text: hit.text, emotions: hit.emotions, key, cached: true });
        }
        return results;
    };

    /** A target's own copy of the snapshot and its run. */
    const prepare = (
        scope: JobScope,
        context: GenerationContext,
        target: TransformTarget,
        shared: Shared,
        life: Lifecycle,
        key: string,
        generation: number,
    ): TargetRun => {
        const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId)!;
        const chat = scopeChat(scope)!;
        const copy: Chat = { ...chat, scriptstate: { ...(chat.scriptstate ?? {}) } };
        const characters = scope.db.characters.map((entry) =>
            entry === owner ? ({ ...owner, chats: [copy] } as typeof owner) : entry,
        );
        const targetScope: JobScope = { ...scope, db: { ...scope.db, characters } };
        const source = characters.find((entry) => entry?.chaId === target.sourceId);
        if (!source) {
            throw new Error("The target's character no longer exists");
        }
        const job = readOnlyJob(context, life.controller.signal, life.epoch);
        const state = { ...createJobRunState(job, shared.budget), cbsUsage: shared.cbsUsage };
        const setup = createRunSetup(
            job,
            deps,
            state,
            targetScope,
            { runCharacterId: source.chaId, engineCharacterId: scope.characterId },
            { frozen: true },
        );
        return {
            target,
            key,
            generation,
            setup,
            source,
            baseline: chat.scriptstate,
            scriptCache: createScriptCache(),
            assetMatches: new Map(),
            text: target.source,
        };
    };

    /** The stages before the plugin handlers: Lua `editDisplay` and the `display` trigger. */
    const head = async (run: TargetRun, mode: TransformRequest["mode"]) => {
        if (mode === "editdisplay") {
            const { setup, source, target } = run;
            let text = await runLuaEdit(setup, source, "editDisplay", run.text, { index: target.chatIndex });
            setup.check();
            const owner = setup.scope.db.characters.find((entry) => entry?.chaId === setup.scope.characterId);
            const chat = scopeChat(setup.scope);
            if (owner && chat) {
                try {
                    const result = await setup.runTrigger(owner as character, "display", {
                        chat,
                        displayMode: true,
                        displayData: text,
                    });
                    text = result?.displayData ?? text;
                } catch (error) {
                    if (
                        error instanceof LuaJobFatalError ||
                        error instanceof GenerationRunnerError ||
                        error instanceof TriggerEffectLimitError ||
                        setup.bindings.fatal() ||
                        setup.nativeCtx.signal.aborted
                    ) {
                        throw error;
                    }
                    // The script's own failure: logged and the text kept, as the client's catch does.
                    console.error("[Trigger]", error);
                }
            }
            setup.check();
            run.text = text;
        }
        if (Buffer.byteLength(run.text) > MAX_TRANSFORM_TEXT_BYTES) {
            throw new Error(`The text before the plugin handlers is over ${MAX_TRANSFORM_TEXT_BYTES} bytes`);
        }
    };

    /** The stages after the plugin handlers: CBS, the regex scripts, the dynamic assets. */
    const tail = async (run: TargetRun, mode: TransformRequest["mode"]): Promise<TransformEmotion[]> => {
        const { setup, source, target } = run;
        const emotions: TransformEmotion[] = [];
        const applyEffect = (effect: RegexScriptEffect) => {
            // `@@inject` writes nothing in a render.
            if (effect.kind === "emotion") {
                const image = (source as character).emotionImages?.find((emo) => emo[0] === effect.name);
                if (image) {
                    emotions.push({ name: image[0], image: image[1] });
                }
            }
        };
        run.text = await runScriptTail(
            { setup, scriptWorkers: deps.scriptWorkers, cache: run.scriptCache, assetMatches: run.assetMatches },
            source,
            run.text,
            mode,
            target.chatIndex,
            target.cbsConditions ?? {},
            applyEffect,
        );
        setup.check();
        return emotions;
    };

    /** A finished target: cached (unless its key moved on) and answered. */
    const finish = (run: TargetRun, emotions: TransformEmotion[], life: Lifecycle): TransformResult => {
        stillValid(life);
        cache.set(run.key, { text: run.text, emotions }, run.generation);
        return { id: run.target.id, ok: true, text: run.text, emotions, key: run.key, cached: false };
    };

    /** A target's failure is its own while the request lives; once the request ended, it ends the request. */
    const failure = (life: Lifecycle, error: unknown, id: string): TransformResult => {
        if (life.controller.signal.aborted) {
            throw life.controller.signal.reason ?? error;
        }
        stillValid(life);
        return { id, ok: false, error: errorText(error) };
    };

    const transform = async (request: TransformRequest, signal: AbortSignal): Promise<TransformResponse> => {
        const life = admit();
        const unlink = link(signal, life.controller);
        let kept: Snapshot | null = null;
        let release: (() => void) | null = null;
        try {
            release = await acquire(life);
            stillValid(life);
            // Answered from the cache without a load when it can be.
            const answered = cachedResults(request, life.epoch);
            stillValid(life);
            if (answered) {
                return { results: answered };
            }
            const context: GenerationContext = {
                characterId: request.context.characterId,
                chatId: request.context.chatId,
                presetId: request.context.presetId,
                modelPresetId: request.context.modelPresetId,
                personaId: request.context.personaId,
                selectedPersonaId: request.context.selectedPersonaId,
                mode: "transform",
                input: "",
                chatRevision: "",
                ...(request.client ? { client: request.client } : {}),
            };
            // A render, read-only: the chat's bound fields that exist must be the ones sent; an
            // unset or gone field renders with the tab's.
            const scope = loadJobScope(store, kinds, context, {
                binding: "display",
                // Besides the chat's characters, each target's source.
                characters: () => request.targets.map((target) => target.sourceId),
            });
            const chat = scopeChat(scope)!;
            const shared: Shared = { budget: deps.scriptWorkers.createBudget(), cbsUsage: { usedMs: 0 } };
            const base = baseKey(request, scope.revisions, scope.characterId, scopeMembers(scope), life.epoch, chat);
            const results: TransformResult[] = [];
            const pending: TargetRun[] = [];
            let retained = 0;
            for (const target of request.targets) {
                const key = targetKey(base, scope.revisions, target);
                if (target.noCache) {
                    cache.invalidate(key);
                } else {
                    const hit = cache.get(key);
                    if (hit) {
                        results.push({
                            id: target.id,
                            ok: true,
                            text: hit.text,
                            emotions: hit.emotions,
                            key,
                            cached: true,
                        });
                        continue;
                    }
                }
                try {
                    const run = prepare(scope, context, target, shared, life, key, cache.generation(key));
                    await head(run, request.mode);
                    if (request.handlers === undefined) {
                        results.push(finish(run, await tail(run, request.mode), life));
                        continue;
                    }
                    // The texts sent back together stay within the second call's limit, and the snapshot within its budget.
                    const bytes = retainedBytes(run);
                    const pendingText = pending.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
                    if (
                        retained + bytes > MAX_SNAPSHOT_BYTES ||
                        pendingText + Buffer.byteLength(run.text) > MAX_TRANSFORM_REQUEST_TEXT_BYTES
                    ) {
                        throw new Error("The render's texts are over the limit of one request");
                    }
                    retained += bytes;
                    pending.push(run);
                } catch (error) {
                    results.push(failure(life, error, target.id));
                }
            }
            stillValid(life);
            if (pending.length === 0) {
                return { results };
            }
            kept = {
                id: randomUUID(),
                clientId: request.clientId,
                mode: request.mode,
                life,
                shared,
                runs: new Map(pending.map((run) => [run.target.id, run])),
            };
            const snapshot = kept;
            // The deadline (or a maintenance) ends the snapshot too: it is no longer claimable once its runs' time is over.
            life.controller.signal.addEventListener(
                "abort",
                () => {
                    dropSnapshot(snapshot);
                    retire(life);
                },
                { once: true },
            );
            // The oldest snapshots give way: of this client, then of all.
            const own = [...snapshots.values()].filter((entry) => entry.clientId === request.clientId);
            for (const old of own.slice(0, Math.max(0, own.length + 1 - MAX_SNAPSHOTS_PER_CLIENT))) {
                dropSnapshot(old, new TransformSnapshotError("The render's snapshot was replaced"));
            }
            for (const old of [...snapshots.values()].slice(0, Math.max(0, snapshots.size + 1 - MAX_SNAPSHOTS))) {
                dropSnapshot(old, new TransformSnapshotError("The render's snapshot was replaced"));
            }
            snapshots.set(snapshot.id, snapshot);
            return {
                results,
                snapshotId: snapshot.id,
                pending: pending.map((run) => ({ id: run.target.id, text: run.text })),
            };
        } finally {
            unlink();
            release?.();
            if (!kept) {
                retire(life);
            }
        }
    };

    const resume = async (request: TransformContinueRequest, signal: AbortSignal): Promise<TransformResponse> => {
        admitCheck();
        const snapshot = snapshots.get(request.snapshotId);
        if (
            !snapshot ||
            snapshot.clientId !== request.clientId ||
            snapshot.life.epoch !== store.epoch() ||
            snapshot.life.controller.signal.aborted ||
            Date.now() >= snapshot.life.deadline
        ) {
            throw new TransformSnapshotError("The render's snapshot is gone");
        }
        // The texts must name exactly the pending targets, each once: checked before the snapshot is used.
        const ids = new Set(request.texts.map((entry) => entry.id));
        if (
            ids.size !== request.texts.length ||
            ids.size !== snapshot.runs.size ||
            [...ids].some((id) => !snapshot.runs.has(id))
        ) {
            throw new TransformRequestError("texts must name every pending target once");
        }
        // Claimed now: a second call for the same snapshot finds nothing.
        dropSnapshot(snapshot);
        const { life } = snapshot;
        const unlink = link(signal, life.controller);
        let release: (() => void) | null = null;
        try {
            try {
                release = await acquire(life);
            } catch (error) {
                // The snapshot's time ran out while it waited: it is gone, as an expired one is.
                throw Date.now() >= life.deadline ? new TransformSnapshotError("The render's snapshot expired") : error;
            }
            stillValid(life);
            const results: TransformResult[] = [];
            for (const entry of request.texts) {
                const run = snapshot.runs.get(entry.id)!;
                if ("error" in entry) {
                    results.push({ id: entry.id, ok: false, error: `A plugin handler failed: ${entry.error}` });
                    continue;
                }
                try {
                    run.text = entry.text;
                    results.push(finish(run, await tail(run, snapshot.mode), life));
                } catch (error) {
                    results.push(failure(life, error, entry.id));
                }
            }
            stillValid(life);
            return { results };
        } finally {
            unlink();
            release?.();
            retire(life);
        }
    };

    /** Ends every request, queued or running, and every snapshot. */
    const abortAll = (reason: string) => {
        for (const snapshot of [...snapshots.values()]) {
            dropSnapshot(snapshot);
        }
        for (const life of [...lives]) {
            life.controller.abort(new TransformUnavailableError(reason));
        }
    };

    return {
        transform: (request: TransformRequest, signal: AbortSignal) => track(transform(request, signal)),
        resume: (request: TransformContinueRequest, signal: AbortSignal) => track(resume(request, signal)),
        /** A maintenance began: every request and snapshot ends, the cache empties; new work waits for the returned resume. */
        pause(reason: string): () => void {
            paused++;
            pauses++;
            abortAll(reason);
            cache.clear();
            let resumed = false;
            return () => {
                if (!resumed) {
                    resumed = true;
                    paused--;
                }
            };
        },
        /** Shutdown: refuses new work, ends every request and snapshot, and waits for the runs. */
        async close(): Promise<void> {
            closed = true;
            abortAll("The server is shutting down");
            await Promise.allSettled([...running]);
        },
        /** For tests and diagnostics. */
        stats: () => ({ active, queued: queue.length, snapshots: snapshots.size, cached: cache.size }),
    };
}

export type TransformService = ReturnType<typeof createTransformService>;
