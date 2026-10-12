import { randomUUID } from "node:crypto";
import { createCbsEvaluator } from "../../../shared/cbs/evaluator.ts";
import type { ChatBindingProblem } from "../../../shared/chatBinding.ts";
import type { Message, MessageTranslation } from "../../../shared/database.ts";
import type { GenerationContext } from "../../../shared/jobs.ts";
import type { RequestArgs } from "../../../shared/llm/request.ts";
import { isChatConflict } from "../../../shared/resources.ts";
import type { TranslatorPreset } from "../../../shared/settings.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { storedTranslation } from "../../../shared/translation/messageTranslation.ts";
import { runTranslatorPipeline } from "../../../shared/translation/pipeline.ts";
import { createTranslatorPreset, isTranslatorPreset } from "../../../shared/translatorPresets.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { ResourceBatchConflictError, ResourceEpochError, type ResourceStore } from "../data/resourceStore.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { createJobCbsHost, serverCbsLimits } from "../jobs/cbsHost.ts";
import type { JobChannel } from "../jobs/channel.ts";
import { checkChatBinding, readChatBindingState } from "../jobs/chatBinding.ts";
import { GenerationRunnerError } from "../jobs/generationJobs.ts";
import type { MessageGuard } from "../jobs/generationLock.ts";
import { ChatBindingError, type JobScope, loadJobScope, scopeChat } from "../jobs/jobScope.ts";
import { requestChatDataOuter } from "../llm/outer.ts";
import { collectSecrets, createRedactor } from "../llm/redact.ts";
import type { requestDataResponse } from "../llm/request.ts";
import type { JobRequestSpec, LlmRequests } from "../llm/requests.ts";
import { mainModelTakesImages, RequestTargetGoneError, tokenScopeFor } from "../llm/settings.ts";

/** How long one translation may run, from its start; past it the run ends (504) and writes nothing. */
export const TRANSLATION_DEADLINE_MS = 10 * 60_000;
/** Translations running at once; one more is refused (429). */
export const MAX_RUNNING_TRANSLATIONS = 16;
/** How long `drain` waits for work that is still settling after its run ended. */
const DRAIN_WAIT_MS = 5000;

/**
 * `POST /api/translate/message` (`docs/plan/translation.md` slice 1.3). The ids are the chat's
 * display ids, as the tab sends them for a transform (`chatDisplayIds`): each bound id that exists,
 * else the tab's selection.
 */
export type TranslateMessageRequest = {
    characterId: string;
    chatId: string;
    messageId: string;
    presetId: string;
    modelPresetId: string;
    personaId: string;
    /** Retranslate: run even when the message holds a fresh stored translation. */
    force: boolean;
};

export type TranslateFailureStatus = 404 | 409 | 429 | 500 | 502 | 503 | 504;

/**
 * - `applied`: the translation is stored (`translation`);
 * - `ignored`: the message's text changed while it was translated, nothing is stored;
 * - `fresh`: not forced, and the message already holds a fresh stored translation (`translation`),
 *   returned without a request.
 */
export type TranslateMessageResult =
    | { ok: true; outcome: "applied" | "ignored" | "fresh"; translation: MessageTranslation | null }
    | { ok: false; status: TranslateFailureStatus; error: string; problems?: ChatBindingProblem[] };

/** How a run ends early: the abort reason of its controller, and a failure thrown inside it. */
class TranslationEnd extends Error {
    readonly status: TranslateFailureStatus;
    constructor(status: TranslateFailureStatus, message: string) {
        super(message);
        this.name = "TranslationEnd";
        this.status = status;
    }
}

const failure = (status: TranslateFailureStatus, error: string): TranslateMessageResult => ({
    ok: false,
    status,
    error,
});

/**
 * The channel of a detached request: no tab is attached, so every callback is `unregistered` (no
 * `bodyIntercepter` runs, and a plugin provider model fails as one that is not registered).
 */
const DETACHED_CHANNEL: JobChannel = {
    notice() {},
    ask: async () => ({ outcome: "aborted", error: "A translation asks nothing" }),
    callback: async () => ({
        outcome: "refused",
        refusal: "unregistered",
        error: "A translation runs without a tab",
    }),
};

/** A run's end: its controller, and the absolute deadline every check reads from the clock. */
type RunLife = { controller: AbortController; deadlineAt: number };

type Run = {
    controller: AbortController;
    /** What every caller of the run gets: the work's result, or the end the controller was aborted with. */
    result: Promise<TranslateMessageResult>;
};

export type TranslationRunner = ReturnType<typeof createTranslationRunner>;

/**
 * The server translation runner: translates one stored message with the translator pipeline
 * (`shared/translation/pipeline.ts`) and stores the result with a `setTranslation` chat op, whose
 * commit reaches the tabs as their `chats` resource event.
 *
 * - One run per message: a request for a message in flight joins its run (after its own ids pass the
 *   chat's display binding) and gets the same result, whatever its `force`. A request that finds a
 *   fresh stored translation and is not forced returns it without a run.
 * - A run is not tied to the HTTP request: it runs to its end when the tab goes away, bounded by
 *   `TRANSLATION_DEADLINE_MS`. Maintenance (`pause`) and shutdown (`beginShutdown`) end every run at
 *   once (503) and refuse new ones. An ended run settles its callers at once and never writes: the
 *   write checks the run's signal, the maintenance gate, and the epoch in the same synchronous call.
 * - The requests run through the request layer in-process (`runInJob`) as a detached job without a
 *   tab: no plugin interceptor, plugin provider, `request` trigger, tool, or inlay. CBS (stop strings,
 *   JSON schema settings) is evaluated over the chat with a run-wide budget and cannot write.
 */
export function createTranslationRunner(deps: {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    gate: MaintenanceGate;
    lock: Pick<MessageGuard, "holder">;
    llm: Pick<LlmRequests, "runInJob">;
    rootDir: string;
    now?: () => number;
}) {
    const { store, kinds, gate, lock, llm } = deps;
    const now = deps.now ?? Date.now;
    const runs = new Map<string, Run>();
    /** The work of every run that has not settled yet, also after its run ended. */
    const working = new Set<Promise<unknown>>();
    let paused = false;
    let closed = false;

    const keyOf = (request: TranslateMessageRequest) =>
        `${request.characterId}\u0000${request.chatId}\u0000${request.messageId}`;

    const admission = (): TranslateMessageResult | null => {
        if (closed) {
            return failure(503, "The server is shutting down");
        }
        if (paused) {
            return failure(503, "The server data is being replaced");
        }
        return null;
    };

    /** The selected translator preset (the chat's own arrives in slice 2.2). */
    const selectedPreset = (scope: JobScope): TranslatorPreset => {
        const presets = Array.isArray(scope.db.translatorPresets)
            ? scope.db.translatorPresets.filter(isTranslatorPreset)
            : [];
        return (
            presets.find((preset) => preset.id === scope.db.translatorPresetId) ??
            presets[0] ??
            createTranslatorPreset("Default")
        );
    };

    /** The character's translator note, as the tab reads it: a group has none. */
    const translatorNoteOf = (scope: JobScope): string => {
        const owner = scope.db.characters.find((entry) => entry?.chaId === scope.characterId);
        return owner?.type === "character" && typeof owner.translatorNote === "string" ? owner.translatorNote : "";
    };

    /**
     * Throws the run's end: an abort, or its deadline read from the clock (work that never yields to
     * the timer, such as an immediate retry loop, still ends there).
     */
    const assertLive = (life: RunLife) => {
        const signal = life.controller.signal;
        if (!signal.aborted && Date.now() >= life.deadlineAt) {
            life.controller.abort(new TranslationEnd(504, "The translation took too long"));
        }
        if (signal.aborted) {
            throw signal.reason;
        }
    };

    /** The pipeline run, then the write. Throws only what `settle` maps. */
    async function work(
        request: TranslateMessageRequest,
        scope: JobScope,
        message: Message,
        life: RunLife,
        epoch: string,
    ): Promise<TranslateMessageResult> {
        const { controller } = life;
        const signal = controller.signal;
        const runId = `translate-${randomUUID()}`;
        const db = scope.request.db;
        const redactor = createRedactor(collectSecrets(db));
        const preset = selectedPreset(scope);
        const to = scope.db.translator || "en";
        const from = scope.db.translatorInputLanguage ?? "";
        const sourceHash = translationSourceHash(message.data);
        // One CBS budget for the whole run (every step and retry); a chat variable is never written.
        const evaluator = createCbsEvaluator(
            createJobCbsHost(scope, {
                rootDir: deps.rootDir,
                setChatVar: () => false,
                limits: serverCbsLimits({ usedMs: 0 }),
            }),
        );
        const spec = (arg: RequestArgs): JobRequestSpec => ({
            jobId: runId,
            loaded: scope.request,
            mode: "translate",
            arg,
            tokenScope: tokenScopeFor(db),
            mainModelImageInput: mainModelTakesImages(db),
            channel: DETACHED_CHANNEL,
            parseCbs: (text, chatRef) => {
                assertLive(life);
                return evaluator.risuChatParser(text, chatRef ? { chatRef } : undefined);
            },
            inlays: {
                saveSignature: async () => {
                    throw new Error("A translation stores no inlay");
                },
                writeImage: async () => {
                    throw new Error("A translation stores no inlay");
                },
                setAsset: async () => {
                    throw new Error("A translation stores no inlay");
                },
            },
            log: () => {},
            alertError: () => {},
            endJob: (text) => controller.abort(new TranslationEnd(502, redactor.text(text))),
            tools: {
                descriptors: [],
                charge: () => false,
                limit: 0,
                call: async () => {
                    throw new Error("A translation calls no tools");
                },
            },
            toolCalls: { read: () => undefined, write: () => {} },
            signal,
        });

        const text = await runTranslatorPipeline(
            {
                steps: preset.steps,
                sourceText: message.data,
                to,
                from,
                translatorNote: translatorNoteOf(scope),
            },
            async ({ messages, maxResponse }) => {
                assertLive(life);
                // Every step runs on the `translate` slot until steps name their model (slice 3.1).
                const response: requestDataResponse = await requestChatDataOuter(
                    { formated: messages, bias: {}, useStreaming: false, noMultiGen: true, maxTokens: maxResponse },
                    "translate",
                    {
                        db,
                        signal,
                        attempt: async (arg) => {
                            // A turn of the event loop before each attempt: the outer loop retries
                            // some answers at once, and timers and other requests must still run.
                            await new Promise<void>((resolve) => setImmediate(resolve));
                            assertLive(life);
                            return llm.runInJob(spec(arg));
                        },
                    },
                );
                if (response.type === "streaming") {
                    await response.result.cancel().catch(() => {});
                }
                // An ended run reports its own end, not the request layer's failure it caused.
                assertLive(life);
                if (response.type === "fail") {
                    throw new TranslationEnd(502, redactor.text(response.result));
                }
                if (response.type !== "success") {
                    throw new TranslationEnd(502, "The translation model answered in an unexpected form");
                }
                return response.result;
            },
        );

        const translation: MessageTranslation = {
            text,
            sourceHash,
            presetId: preset.id,
            targetLanguage: to,
            translatedAt: now(),
        };
        // The write fence, in the same synchronous call as the write: the run still live, the server
        // not shutting down, no maintenance, and the data the run read (its epoch).
        assertLive(life);
        if (closed) {
            throw new TranslationEnd(503, "The server is shutting down");
        }
        gate.assertOpen();
        const applied = store.applyChanges(
            {
                chats: [
                    {
                        characterId: request.characterId,
                        chatId: request.chatId,
                        baseRevision: scope.chatRevision,
                        ops: [{ op: "setTranslation", id: request.messageId, translation }],
                    },
                ],
            },
            { epoch },
        );
        const outcome = applied.chats[0]?.translations?.[0] ?? "ignored";
        return { ok: true, outcome, translation: outcome === "applied" ? translation : null };
    }

    /** What a run that threw ends with. */
    function settle(request: TranslateMessageRequest, error: unknown): TranslateMessageResult {
        if (error instanceof TranslationEnd) {
            return failure(error.status, error.message);
        }
        if (error instanceof MaintenanceError || error instanceof ResourceEpochError) {
            return failure(503, "The server data is being replaced");
        }
        if (error instanceof ResourceBatchConflictError) {
            const chatConflicts = error.conflicts.filter(isChatConflict);
            if (chatConflicts.some((conflict) => conflict.reason === "generating")) {
                return failure(409, "generating");
            }
            // A by-id op conflicts when its message or chat is gone, or the chat was replaced by
            // another of the same id: tell them apart by reading again.
            if (store.chatRevision(request.characterId, request.chatId) === null) {
                return failure(404, "The chat no longer exists");
            }
            const read = store.readRefs([], { chats: [{ characterId: request.characterId, id: request.chatId }] });
            const chat = read.chats[0]?.data;
            if (!chat?.message.some((entry) => entry.chatId === request.messageId)) {
                return failure(404, "The message no longer exists");
            }
            return failure(409, "The chat changed while it was translated; translate again");
        }
        console.error("[translate] unexpected failure:", error instanceof Error ? error.name : typeof error);
        return failure(500, "The translation failed");
    }

    return {
        /**
         * Translates the message: joins its run in flight, returns a fresh stored translation when not
         * forced, or starts a run. Settles when the run ends; the caller's own abort does not end it.
         */
        translate(request: TranslateMessageRequest): Promise<TranslateMessageResult> {
            const refused = admission();
            if (refused) {
                return Promise.resolve(refused);
            }
            const key = keyOf(request);
            const sent = {
                presetId: request.presetId,
                modelPresetId: request.modelPresetId,
                personaId: request.personaId,
            };
            const inFlight = runs.get(key);
            if (inFlight) {
                // A joining caller's ids pass the chat's display binding too.
                const state = readChatBindingState(store, kinds, request);
                if (!state.chat) {
                    return Promise.resolve(failure(404, "The chat no longer exists"));
                }
                const refusal = checkChatBinding(state.chat, state.lookup, sent, "display");
                if (refusal) {
                    return Promise.resolve({ ok: false, status: 409, error: refusal.error });
                }
                // The ids a start would load must exist for a joiner too (an unbound field takes the sent one).
                if (
                    !state.lookup.promptPreset(request.presetId) ||
                    !state.lookup.modelPreset(request.modelPresetId) ||
                    !state.lookup.persona(request.personaId)
                ) {
                    return Promise.resolve(
                        failure(404, "The request's preset, model preset, or persona no longer exists"),
                    );
                }
                return inFlight.result;
            }

            // Capacity counts the work still running, also of a run that ended and has not stopped yet,
            // and is checked before the scope load (a fresh stored translation is not served at capacity).
            if (working.size >= MAX_RUNNING_TRANSLATIONS) {
                return Promise.resolve(failure(429, "Too many translations are running"));
            }
            // Everything up to the run's start is synchronous: one committed state, no other caller between.
            const epoch = store.epoch();
            const context: GenerationContext = {
                characterId: request.characterId,
                chatId: request.chatId,
                ...sent,
                mode: "translate",
                input: "",
                chatRevision: "",
            };
            let scope: JobScope;
            try {
                scope = loadJobScope(store, kinds, context, { binding: "display" });
            } catch (error) {
                if (error instanceof ChatBindingError) {
                    return Promise.resolve({
                        ok: false,
                        status: 409,
                        error: error.refusal.error,
                        ...(error.refusal.error === "chatBindingIncomplete"
                            ? { problems: error.refusal.problems }
                            : {}),
                    });
                }
                if (error instanceof GenerationRunnerError && error.status === 404) {
                    return Promise.resolve(failure(404, error.message));
                }
                if (error instanceof RequestTargetGoneError) {
                    return Promise.resolve(failure(404, error.message));
                }
                throw error;
            }
            const message = scopeChat(scope)?.message.find((entry) => entry.chatId === request.messageId);
            if (!message) {
                return Promise.resolve(failure(404, "The message no longer exists"));
            }
            if (lock.holder(request.characterId, request.chatId, request.messageId) !== null) {
                return Promise.resolve(failure(409, "generating"));
            }
            if (!request.force && storedTranslation(message) !== null) {
                return Promise.resolve({
                    ok: true,
                    outcome: "fresh",
                    translation: structuredClone(message.translation!),
                });
            }
            const controller = new AbortController();
            const life: RunLife = { controller, deadlineAt: Date.now() + TRANSLATION_DEADLINE_MS };
            const deadline = setTimeout(
                () => controller.abort(new TranslationEnd(504, "The translation took too long")),
                TRANSLATION_DEADLINE_MS,
            );
            deadline.unref?.();
            const done = work(request, scope, message, life, epoch).then(
                (result) => result,
                (error) => settle(request, controller.signal.aborted ? controller.signal.reason : error),
            );
            working.add(done);
            void done.finally(() => working.delete(done));
            // An end settles every caller at once, whether or not the work has stopped (it writes nothing after).
            const ended = new Promise<TranslateMessageResult>((resolve) => {
                controller.signal.addEventListener("abort", () => resolve(settle(request, controller.signal.reason)), {
                    once: true,
                });
            });
            const run: Run = { controller, result: Promise.race([done, ended]) };
            runs.set(key, run);
            void run.result.finally(() => {
                clearTimeout(deadline);
                if (runs.get(key) === run) {
                    runs.delete(key);
                }
            });
            return run.result;
        },

        /** Maintenance began: every run ends (503) and new ones are refused until `resume`. */
        pause(reason: string) {
            paused = true;
            for (const run of runs.values()) {
                run.controller.abort(new TranslationEnd(503, reason));
            }
        },

        /** Maintenance ended (a runner that is shutting down stays closed). */
        resume() {
            paused = false;
        },

        /** Refuses new runs and ends every running one (503). */
        beginShutdown() {
            closed = true;
            for (const run of runs.values()) {
                run.controller.abort(new TranslationEnd(503, "The server is shutting down"));
            }
        },

        /** Resolves once the work of every run has settled, or after `DRAIN_WAIT_MS`. */
        async drain() {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                Promise.all([...working]),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, DRAIN_WAIT_MS);
                }),
            ]);
            clearTimeout(timer);
        },

        /** For tests: how many runs are in flight, and how much work has not settled (the capacity count). */
        runningCount: () => runs.size,
        workingCount: () => working.size,
    };
}
