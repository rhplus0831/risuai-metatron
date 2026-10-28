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
import { isValidResourceId } from "../data/resourceStore.ts";
import { GenerationRunnerError, type RunningJob } from "../jobs/generationJobs.ts";
import { type JobScope, jobScopeKinds, scopeChat } from "../jobs/jobScope.ts";
import { createJobRunState, createRunSetup, type GenerationRunnerDeps, type RunSetup } from "../jobs/runSetup.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import type { LuaBudget } from "../scripts/workerPool.ts";
import { isDisplayKeyKind } from "./displayKinds.ts";
import { createDisplayScopeLoader, MAX_RETAINED_BYTES, retainedBytes, type DisplayScopeEntry } from "./displayScope.ts";
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
/** Request-owned retained memory of one snapshot: its projection and each target's setup, copies and texts. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Bindings, the CBS host and matcher table, trigger runtime, and run state. */
const SNAPSHOT_TARGET_BYTES = 48 * 1024;
/** The copied variable object's property storage; unchanged keys and values are paid by the scope. */
const SNAPSHOT_VARIABLE_ENTRY_BYTES = 64;
const SNAPSHOT_CHARACTER_ENTRY_BYTES = 8;
/** Parsed default-variable maps can retain many times their source text's bytes. */
const SNAPSHOT_DEFAULT_VARIABLE_FACTOR = 12;
/** Chats whose member and speaker ids the cache probe remembers (`chatCharacters`). */
const MAX_CHAT_CHARACTERS = 256;

/** What every target of one request shares: one Lua budget and CBS time. */
type Shared = {
    budget: LuaBudget;
    cbsUsage: { usedMs: number };
};

/** One target's run: a shallow scope copy pinning the loaded scope, its setup, caches and text so far. */
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
    claimed: boolean;
    release: () => void;
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

/** Per-target retained memory beyond the shared scope, including allowances for lazy setup allocations. */
function targetRetainedBytes(run: TargetRun): number {
    let bytes = SNAPSHOT_TARGET_BYTES + Buffer.byteLength(run.text);
    if (run.text !== run.target.source) {
        bytes += Buffer.byteLength(run.target.source);
    }
    const state = scopeChat(run.setup.scope)?.scriptstate ?? {};
    for (const [key, value] of Object.entries(state)) {
        bytes += SNAPSHOT_VARIABLE_ENTRY_BYTES;
        if (run.baseline?.[key] !== value) {
            bytes += Buffer.byteLength(key) + Buffer.byteLength(String(value));
        }
    }
    const db = run.setup.scope.db;
    bytes += db.characters.length * SNAPSHOT_CHARACTER_ENTRY_BYTES;
    // The host can parse any loaded character's defaults, even if it has not read a missing variable yet.
    const characterDefaults = db.characters.reduce(
        (largest, entry) => Math.max(largest, Buffer.byteLength((entry as character).defaultVariables ?? "")),
        0,
    );
    return (
        bytes +
        SNAPSHOT_DEFAULT_VARIABLE_FACTOR * (characterDefaults + Buffer.byteLength(db.templateDefaultVariables ?? ""))
    );
}

/** Partition ordinary cache hits already held by the tab out of the first call's full results. */
function partitionKnownResults(targets: TransformTarget[], results: TransformResult[]): TransformResponse {
    const knownKeys = new Map(targets.map((target) => [target.id, target.knownKey]));
    const full: TransformResult[] = [];
    const same: NonNullable<TransformResponse["same"]> = [];
    for (const result of results) {
        if (result.ok && result.cached && result.key === knownKeys.get(result.id)) {
            same.push({ id: result.id, key: result.key });
        } else {
            full.push(result);
        }
    }
    return same.length ? { results: full, same } : { results };
}

/**
 * The script transform: `processScriptFull`'s `editdisplay` and `editprocess` stages for targets
 * the tab sends, read-only. A fresh display projection per request the result cache does not answer
 * whole, using raw configuration and transcript entries cached by epoch and revisions (the ids
 * the tab captured; a missing record fails the request, 404), then per target an isolated run on
 * that projection: its own chat object (`scriptstate` copied: a Lua or CBS variable write
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
 * A kept snapshot is charged its request-owned projection plus each target's setup, copied
 * containers, texts, changed variables and default-variable map allowance, up to 8 MiB. Shared raw
 * entries are charged once while pinned, alongside snapshots and in-progress reservations against
 * a 64 MiB global limit. Oldest waiting snapshots give way first (this client's, then all clients').
 * Continuations keep their pins through queueing and execution; every end path releases them.
 * Targets that still do not fit fail alone.
 *
 * Results are cached (`transformCache.ts`) under `targetKey`: a digest of the epoch, the stored
 * chat revision the load read, the mode, the full request context, browser language (empty when
 * absent), viewport width and height (null without a client), and handler-set identity (null
 * without handlers). It includes the loaded non-character record revisions kept by
 * `displayKinds.ts` (all admission kinds and `globalChatVariables` stay; unclassified kinds stay),
 * plus the display identities of the owner, valid group members and every valid stored message
 * speaker besides the owner. An identity is the digest of stored JSON before runtime chats are
 * attached, without top-level `lastInteraction`, preserving property order; absence is `missing`.
 * A separate canonical metadata digest includes `scriptstate`, `GLGlobalVariables`, `note`,
 * `localLore`, `loreOverrides`, `name`, `modules`, `bindedPersona`, `promptPresetId`, `modelPresetId`
 * and `fmIndex`, with the defaults in `baseKey`. Each target adds its kind, message id for a
 * message (null otherwise), chat index, source id and that source's display identity (`missing`
 * when absent), `cbsConditions` (empty when absent), and the source text's digest. Sources named
 * only by other targets stay out of its key, so batching does not change it; the correlation id,
 * `knownKey` and `noCache` are not key inputs. A result stays under the loaded chat revision even
 * if the chat changes while it runs. `noCache` invalidates that entry and prevents an older fill
 * from replacing it. A cached result keeps its emotions; the tab applies a key's emotions once.
 *
 * `cachedResults` can answer every target before building a display projection: it reads the
 * current job-scope kind revisions and chat metadata (including its revision), then the
 * `chatCharacters` memo under owner id, chat id and chat revision. That memo remembers member and
 * speaker ids, including missing ones, and is validated against the owner's current display
 * identity; a missing memo or changed owner identity requires a load. Character records are read
 * only on identity-memo misses; no configuration data or message rows are parsed by the probe.
 * On the first call, `partitionKnownResults` answers an ordinary cache hit matching the target's
 * `knownKey` in `same` with only its id and key, present only when non-empty. A different key,
 * a miss, `noCache`, a failure and every continuation answer in full (or await plugin handlers).
 * The key identifies inputs, not output, so random, clock, or plugin output refilled under the
 * same key after eviction or Re-render can differ while `same` still confirms that key.
 *
 * Lifecycle: a request is registered (its controller, its deadline, the epoch, the maintenance
 * count) when it is admitted, before it waits for one of `MAX_ACTIVE` slots (`MAX_QUEUED` may wait;
 * more are refused). `pause` (maintenance) aborts every request, queued or running, and every
 * snapshot, and empties the result and scope caches; a request admitted before maintenance never
 * runs after it.
 * `close` (shutdown) refuses new work, aborts, and waits for the runs. One deadline,
 * `TRANSFORM_SNAPSHOT_TTL_MS` from the first call's admission, covers both calls of a snapshot.
 */
export function createTransformService(runnerDeps: GenerationRunnerDeps) {
    // No MCP: a render calls no tools.
    const deps: GenerationRunnerDeps = { ...runnerDeps, mcp: undefined };
    const { store, kinds } = deps;
    const cache = createTransformCache();
    const displayScopes = createDisplayScopeLoader(store, kinds);
    const pins = new Map<DisplayScopeEntry, number>();
    let retained = 0;
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
        if (!snapshot.claimed) {
            snapshot.release();
        }
        if (reason) {
            snapshot.life.controller.abort(reason);
            retire(snapshot.life);
        }
    };

    /** Reservations are synchronous: another head can await without making this charge available again. */
    const reservationFor = (entries: readonly DisplayScopeEntry[]) => {
        let ownBytes = 0;
        let pinned = false;
        let released = false;
        const sharedBytes = () =>
            pinned ? 0 : entries.reduce((sum, entry) => sum + (pins.has(entry) ? 0 : entry.bytes), 0);
        return {
            reserve(bytes: number, clientId: string): boolean {
                while (retained + sharedBytes() + bytes > MAX_RETAINED_BYTES) {
                    // Claimed continuations and other requests' reservations are never in this map.
                    const oldest =
                        [...snapshots.values()].find((entry) => entry.clientId === clientId) ??
                        snapshots.values().next().value;
                    if (!oldest) {
                        return false;
                    }
                    dropSnapshot(oldest, new TransformSnapshotError("The render's snapshot was replaced"));
                }
                retained += sharedBytes() + bytes;
                ownBytes += bytes;
                if (!pinned) {
                    for (const entry of entries) {
                        pins.set(entry, (pins.get(entry) ?? 0) + 1);
                    }
                    pinned = true;
                }
                return true;
            },
            release() {
                if (released) {
                    return;
                }
                released = true;
                retained -= ownBytes;
                if (pinned) {
                    for (const entry of entries) {
                        const count = pins.get(entry)!;
                        if (count === 1) {
                            pins.delete(entry);
                            retained -= entry.bytes;
                        } else {
                            pins.set(entry, count - 1);
                        }
                    }
                }
            },
        };
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
     * A chat's member and speaker ids besides its owner, including missing ones, by chat revision.
     * The owner's display identity validates the member list across stamps without reading messages.
     */
    const chatCharacters = new Map<string, { ownerIdentity: string; characterIds: readonly string[] }>();
    const charactersKey = (characterId: string, chatId: string, chatRevision: string) =>
        `${characterId}\0${chatId}\0${chatRevision}`;

    /** The loaded chat's characters, including missing ones, without sources named only by targets. */
    const scopeCharacters = (scope: JobScope, identities: ReadonlyMap<string, string>): readonly string[] => {
        const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId);
        const ids = new Set<string>(owner?.type === "group" ? (owner.characters ?? []) : []);
        for (const message of scopeChat(scope)?.message ?? []) {
            if (message.saying) {
                ids.add(message.saying);
            }
        }
        const characters = [...ids].filter((id) => id !== scope.characterId && isValidResourceId(id));
        const ownerIdentity = identities.get(scope.characterId);
        if (ownerIdentity !== undefined) {
            const key = charactersKey(scope.characterId, scope.chatId, scope.chatRevision);
            chatCharacters.delete(key);
            chatCharacters.set(key, { ownerIdentity, characterIds: characters });
            if (chatCharacters.size > MAX_CHAT_CHARACTERS) {
                chatCharacters.delete(chatCharacters.keys().next().value!);
            }
        }
        return characters;
    };

    /**
     * The key parts every target of a request shares: what decides the render besides the target,
     * and what decides the load's checks (the chat's binding, the records it names), so an entry
     * answers only a request whose load would have passed. Non-character revisions follow
     * `displayKinds.ts`; characters use stored display identities (or `missing`), not revisions.
     * Sources named only by targets stay out so batching does not change another target's key.
     */
    const baseKey = (
        request: TransformRequest,
        revisions: ReadonlyMap<string, string> | undefined,
        identities: ReadonlyMap<string, string>,
        characterId: string,
        characters: readonly string[],
        epoch: string,
        chat: Chat,
        chatRevision: string,
    ): unknown[] => {
        const included: [string, string][] = [];
        for (const [name, revision] of revisions ?? []) {
            const slash = name.indexOf("/");
            if (isDisplayKeyKind(name.slice(0, slash))) {
                included.push([name, revision]);
            }
        }
        for (const id of new Set([characterId, ...characters])) {
            const name = `characters/${id}`;
            included.push([name, identities.get(id)!]);
        }
        included.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return [
            epoch,
            chatRevision,
            request.mode,
            request.context,
            request.client?.browserLanguage ?? "",
            request.client ? [request.client.viewport.width, request.client.viewport.height] : null,
            request.handlers ?? null,
            included,
            // The chat metadata read by the render and its binding (the load's check).
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

    /** Each row adds only its own source's display identity to the shared key. */
    const targetKey = (base: unknown[], identities: ReadonlyMap<string, string>, target: TransformTarget): string =>
        sha256(
            canonical([
                ...base,
                target.kind,
                target.kind === "message" ? (target.messageId ?? null) : null,
                target.chatIndex,
                target.sourceId,
                identities.get(target.sourceId) ?? "missing",
                target.cbsConditions ?? {},
                sha256(target.source),
            ]),
        );

    /**
     * The request's results when every target has an entry: revisions and chat metadata plus
     * character reads only for unknown identities. A cold chat memo misses before resolving any
     * identity, so its load reads the owner just once. A changed owner identity also misses (group
     * membership may have changed). The load reports any missing record or binding refusal.
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
        const memo = chatCharacters.get(charactersKey(characterId, chatId, chatRecord.revision));
        if (!memo) {
            return null;
        }
        const ownerIdentity = displayScopes.resolveIdentities([characterId], revisions).get(characterId)!;
        if (ownerIdentity !== memo.ownerIdentity) {
            return null;
        }
        const identities = new Map(
            displayScopes.resolveIdentities(
                [...memo.characterIds, ...request.targets.map((target) => target.sourceId)],
                revisions,
            ),
        );
        identities.set(characterId, ownerIdentity);
        const base = baseKey(
            request,
            revisions,
            identities,
            characterId,
            memo.characterIds,
            epoch,
            chatRecord.data,
            chatRecord.revision,
        );
        const results: TransformResult[] = [];
        for (const target of request.targets) {
            const key = targetKey(base, identities, target);
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
        let reservation: ReturnType<typeof reservationFor> | null = null;
        let release: (() => void) | null = null;
        try {
            release = await acquire(life);
            stillValid(life);
            // Answered from the cache without a load when it can be.
            const answered = cachedResults(request, life.epoch);
            stillValid(life);
            if (answered) {
                return partitionKnownResults(request.targets, answered);
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
            const { scope, entries, identities } = displayScopes.load(context, {
                // Besides the chat's characters, each target's source.
                characters: () => request.targets.map((target) => target.sourceId),
            });
            reservation = reservationFor(entries);
            const chat = scopeChat(scope)!;
            const shared: Shared = { budget: deps.scriptWorkers.createBudget(), cbsUsage: { usedMs: 0 } };
            const base = baseKey(
                request,
                scope.revisions,
                identities,
                scope.characterId,
                scopeCharacters(scope, identities),
                life.epoch,
                chat,
                scope.chatRevision,
            );
            const results: TransformResult[] = [];
            const pending: TargetRun[] = [];
            let ownBytes = 0;
            let scopeBytes: number | undefined;
            for (const target of request.targets) {
                const key = targetKey(base, identities, target);
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
                    if (request.handlers !== undefined) {
                        scopeBytes ??= retainedBytes(scope, MAX_SNAPSHOT_BYTES, { exclude: entries });
                        if (
                            (pending.length ? ownBytes : scopeBytes) + SNAPSHOT_TARGET_BYTES > MAX_SNAPSHOT_BYTES ||
                            entries.some((entry) => entry.bytes > MAX_RETAINED_BYTES)
                        ) {
                            throw new Error("The render's texts are over the limit of one request");
                        }
                    }
                    const run = prepare(scope, context, target, shared, life, key, cache.generation(key));
                    await head(run, request.mode);
                    if (request.handlers === undefined) {
                        results.push(finish(run, await tail(run, request.mode), life));
                        continue;
                    }
                    // The texts sent back together stay within the second call's limit, and the snapshot within its budget.
                    const bytes = targetRetainedBytes(run) + (pending.length === 0 ? scopeBytes! : 0);
                    const pendingText = pending.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
                    if (
                        ownBytes + bytes > MAX_SNAPSHOT_BYTES ||
                        pendingText + Buffer.byteLength(run.text) > MAX_TRANSFORM_REQUEST_TEXT_BYTES
                    ) {
                        throw new Error("The render's texts are over the limit of one request");
                    }
                    stillValid(life);
                    if (!reservation.reserve(bytes, request.clientId)) {
                        throw new Error("The render's texts are over the limit of one request");
                    }
                    ownBytes += bytes;
                    pending.push(run);
                } catch (error) {
                    results.push(failure(life, error, target.id));
                }
            }
            stillValid(life);
            if (pending.length === 0) {
                return partitionKnownResults(request.targets, results);
            }
            const snapshot: Snapshot = {
                id: randomUUID(),
                clientId: request.clientId,
                mode: request.mode,
                life,
                shared,
                runs: new Map(pending.map((run) => [run.target.id, run])),
                claimed: false,
                release: reservation.release,
            };
            // The deadline (or a maintenance) ends the snapshot too: it is no longer claimable once its runs' time is over.
            life.controller.signal.addEventListener(
                "abort",
                () => {
                    if (!snapshot.claimed) {
                        dropSnapshot(snapshot);
                        retire(life);
                    }
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
            kept = snapshot;
            return {
                ...partitionKnownResults(request.targets, results),
                snapshotId: snapshot.id,
                pending: pending.map((run) => ({ id: run.target.id, text: run.text })),
            };
        } finally {
            unlink();
            release?.();
            if (!kept) {
                reservation?.release();
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
        // Claimed now: a second call finds nothing, but its data stays charged until this call ends.
        snapshot.claimed = true;
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
            snapshot.release();
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
            displayScopes.clear();
            chatCharacters.clear();
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
            displayScopes.clear();
            chatCharacters.clear();
            await Promise.allSettled([...running]);
        },
        /** For tests and diagnostics. */
        stats: () => ({
            active,
            queued: queue.length,
            snapshots: snapshots.size,
            cached: cache.size,
            retainedBytes: retained,
            pinnedEntries: pins.size,
            displayScope: displayScopes.stats(),
        }),
    };
}

export type TransformService = ReturnType<typeof createTransformService>;
