import type { CbsConditions } from "../../../shared/cbs/types.ts";
import type { character, customscript, groupChat } from "../../../shared/database.ts";
import { greetingText } from "../../../shared/greetings.ts";
import type { CallbackResult } from "../../../shared/jobs.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import {
    createScriptCache,
    regexScriptCacheKey,
    type RegexScriptEffect,
    type RegexScriptMode,
} from "../../../shared/scripts/regex.ts";
import { jobModules } from "../jobs/cbsHost.ts";
import { GenerationRunnerError, type RunningJob } from "../jobs/generationJobs.ts";
import type { MessageGuard } from "../jobs/generationLock.ts";
import { asScript, moduleTriggers, type RunSetup, untilAborted } from "../jobs/runSetup.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import type { ScriptWorkerPool } from "../scripts/workerPool.ts";
import { HypaProcesser } from "./embeddings.ts";

/** The script modes the server runs on a send (`editoutput` on the completed reply, slice 11a). */
export type ServerScriptMode = "editinput" | "editprocess" | "editoutput";

const luaModeOf: Record<ServerScriptMode, string | null> = {
    editinput: "editInput",
    // `runLuaEditTrigger` returns `editprocess` content untouched.
    editprocess: null,
    editoutput: "editOutput",
};

/** `assetRegex` of `src/ts/parser/parser.svelte.ts`. */
const assetRegex = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)}}/gms;

/** `getModuleRegexScripts` of `src/ts/process/modules.ts` over the job's modules. */
function moduleRegexScripts(setup: RunSetup): customscript[] {
    let scripts: customscript[] = [];
    for (const module of jobModules(setup.scope)) {
        if (module?.regex) {
            scripts = scripts.concat(module.regex);
        }
    }
    return scripts;
}

export type ScriptProcessor = {
    /**
     * `processScriptFull(char, data, mode, chatID, cbsConditions, chatRef)` of the job's chat:
     * `{ data, emoChanged }`.
     */
    process(
        char: character | groupChat,
        data: string,
        mode: ServerScriptMode,
        chatID?: number,
        cbsConditions?: CbsConditions,
    ): Promise<{ data: string; emoChanged: boolean }>;
    /** `runLuaEditTrigger(char, "editRequest", formated)`: the messages every Lua trigger returned. */
    editRequest(char: character, formated: OpenAIChat[]): Promise<OpenAIChat[]>;
};

/** The regex scripts' result cache of a run (`JobRunState.scriptCache`). */
export type ScriptCache = ReturnType<typeof createScriptCache>;

/**
 * `runLuaEditTrigger(char, mode, content, meta)` on a run's setup: the Lua edit hook `mode`
 * (`editInput`, `editOutput`, `editRequest`, `editDisplay`) on every Lua trigger of the character,
 * or of the modules only for a group, without low-level access. A load failure returns the content
 * as it came in (the client's catch); a failure inside a handler is logged and the next trigger runs;
 * a spent budget or a pool failure is the run's (`GenerationRunnerError`).
 */
export async function runLuaEdit<T>(
    setup: RunSetup,
    char: character | groupChat,
    mode: string,
    content: T,
    meta?: object,
): Promise<T> {
    const triggers =
        char.type === "group"
            ? moduleTriggers(setup.scope)
            : (char.triggerscript ?? []).concat(moduleTriggers(setup.scope));
    let data = content;
    for (const trigger of triggers) {
        const effect = trigger?.effect?.[0];
        if (effect?.type !== "triggerlua") {
            continue;
        }
        const outcome = await setup.runLua(effect.code, {
            mode,
            lowLevelAccess: false,
            data,
            ...(meta !== undefined ? { meta } : {}),
        });
        if (outcome.error) {
            if (outcome.error.timedOut || outcome.error.failedAt === undefined) {
                throw new GenerationRunnerError(500, `Lua: ${outcome.error.message}`, { stage: "script" });
            }
            if (outcome.error.failedAt === "load") {
                return content;
            }
            console.error("[Lua]", outcome.error.message);
            continue;
        }
        if (outcome.res !== undefined && outcome.res !== null) {
            data = outcome.res as T;
        }
    }
    return data;
}

/**
 * The client's dynamic-asset step of `processScriptFull` (`db.dynamicAssets`: an asset name the
 * character does not have is replaced by the nearest one it has, by embedding), with the client's
 * conditions: never for `editinput` and `editprocess`, for `editdisplay` only with
 * `dynamicAssetsEditDisplay`. `assetMatches` is the run's best-match cache (the client's, per tab).
 */
async function applyDynamicAssets(
    setup: RunSetup,
    assetMatches: Map<string, string>,
    char: character | groupChat,
    input: string,
    mode: string,
): Promise<string> {
    const { scope, bindings, nativeCtx } = setup;
    const { services } = bindings;
    let data = input;
    const db = scope.db;
    if (!(db.dynamicAssets && char.type === "character" && char.additionalAssets && char.additionalAssets.length > 0)) {
        return data;
    }
    if ((!db.dynamicAssetsEditDisplay && mode === "editdisplay") || mode === "editinput" || mode === "editprocess") {
        return data;
    }
    const assetNames = char.additionalAssets.map((v) => v[0]);

    for (const module of jobModules(scope)) {
        for (const asset of module?.assets ?? []) {
            assetNames.push(asset[0]);
        }
    }

    let processer: HypaProcesser | undefined;
    const matches = data.matchAll(assetRegex);

    for (const match of matches) {
        const type = match[1];
        const assetName = match[2];
        const cacheKey = char.chaId + "::" + assetName;
        if (type !== "emotion" && type !== "source") {
            if (assetMatches.has(cacheKey)) {
                data = data.replaceAll(match[0], `{{${type}::${assetMatches.get(cacheKey)}}}`);
            } else if (!assetNames.includes(assetName)) {
                if (!processer) {
                    processer = new HypaProcesser(services.embeddings(nativeCtx));
                    await processer.addText(assetNames);
                    services.fence(nativeCtx);
                }
                const searched = await processer.similaritySearch(assetName);
                services.fence(nativeCtx);
                const bestMatch = searched[0];
                if (bestMatch) {
                    data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`);
                    assetMatches.set(cacheKey, bestMatch);
                }
            }
        }
    }
    return data;
}

/**
 * The part of `processScriptFull` after the plugin hook, on the run's chat: CBS, the regex scripts
 * (`presetRegex`, the character's, the modules') in a script worker with CBS, `@@repeat_back`, and
 * the effects (`applyEffect`) answered here while the worker waits, then the dynamic-asset step;
 * the result cached in `cache` by the client's key (a hit returns at once, applying no effect; an
 * empty result is computed again). A regex worker failure is the run's; a fatal host failure inside
 * the worker's run is latched and raised after it.
 */
export async function runScriptTail(
    deps: { setup: RunSetup; scriptWorkers: ScriptWorkerPool; cache: ScriptCache; assetMatches: Map<string, string> },
    char: character | groupChat,
    input: string,
    mode: RegexScriptMode,
    chatID: number,
    cbsConditions: CbsConditions,
    applyEffect: (effect: RegexScriptEffect) => void,
): Promise<string> {
    const { setup, scriptWorkers, cache } = deps;
    const { bindings, nativeCtx, scope } = setup;
    const { services, evaluator } = bindings;
    const chatRef = { chaId: scope.characterId, chatId: scope.chatId };
    const parse = (text: string) => evaluator.risuChatParser(text, { chatID, cbsConditions, chatRef });
    let data = parse(input);
    const scripts = (scope.db.presetRegex ?? []).concat(char.customscript ?? []).concat(moduleRegexScripts(setup));
    const hash = regexScriptCacheKey(scripts, data, mode, chatID, `${chatRef.chaId}/${chatRef.chatId}`, parse);
    const cached = cache.get(hash);
    // The client's `if (cached)`: an empty result is computed again (its effects run again).
    if (cached) {
        return cached;
    }
    if (scripts.length > 0) {
        /** A host answer the engine would swallow: a fatal failure is latched (aborting the run) first. */
        const guarded =
            <A extends unknown[], R>(fn: (...args: A) => R) =>
            (...args: A): R => {
                try {
                    services.fence(nativeCtx);
                    return fn(...args);
                } catch (error) {
                    if (error instanceof LuaJobFatalError || error instanceof GenerationRunnerError) {
                        throw services.latch(error);
                    }
                    throw error;
                }
            };
        const result = await scriptWorkers.runScripts(
            { data, scripts, mode, chatID, identity: nativeCtx.identity },
            {
                signal: nativeCtx.signal,
                host: {
                    parse: guarded(parse),
                    repeatBack: guarded(() => {
                        // The chat `chatID` indexes, and its owner's greeting.
                        const chat = services.liveChat();
                        const owner = scope.db.characters.find((entry) => entry?.chaId === chatRef.chaId) as character;
                        let lastChat = greetingText(owner, chat.fmIndex);
                        let pointer = chatID - 1;
                        while (pointer >= 0) {
                            if (chat.message[pointer].role === chat.message[chatID].role) {
                                lastChat = chat.message[pointer].data;
                                break;
                            }
                            pointer--;
                        }
                        return lastChat;
                    }),
                    effect: guarded(applyEffect),
                },
            },
        );
        setup.check();
        if ("error" in result) {
            throw new GenerationRunnerError(500, `Regex scripts: ${result.error}`, { stage: "script" });
        }
        data = result.data;
    }
    data = await applyDynamicAssets(setup, deps.assetMatches, char, data, mode);
    cache.set(hash, data);
    return data;
}

/**
 * The server's `processScriptFull` (the former `src/ts/process/scripts.ts`; Phase 5 slice 9) for one run's
 * setup, in the client's order: the Lua edit hook (`runLuaEdit`; none for `editprocess`), the plugin
 * hook as a channel callback named the mode when the owner registered one, then `runScriptTail`.
 * `@@emo` becomes an `emotion` notice; `@@inject` writes the message at `chatID` (resolved to its id
 * first), and is skipped while any generation owns that message, this job's included (the client's
 * `setMessageText` without a capability is refused there). The result cache is the job's own, shared
 * by its processors (the client keeps one per tab; a server-wide one would share context-dependent
 * results between tabs), as is the dynamic-asset best-match cache.
 *
 * Failures: as `runLuaEdit` and `runScriptTail`. A plugin hook that failed ends the send, as the
 * client's unguarded `invokeHook` does; a hook no longer registered keeps the text, any other refusal
 * ends the job.
 */
export function createScriptProcessor(deps: {
    job: RunningJob;
    setup: RunSetup;
    scriptWorkers: ScriptWorkerPool;
    lock: MessageGuard;
    /** The job's cache (`JobRunState.scriptCache`), shared by every processor of the job. */
    cache: ScriptCache;
    /** The job's dynamic-asset matches (`JobRunState.assetMatches`): `<chaId>::<name>` to the asset chosen. */
    assetMatches: Map<string, string>;
    /** `@@emo`: the emotion shown (`showEmotion` of the job: its history and the notice). */
    showEmotion(chaId: string, name: string, image: string): void;
}): ScriptProcessor {
    const { job, setup, lock } = deps;
    const { bindings, nativeCtx, scope } = setup;
    const { services } = bindings;
    const chatRef = { chaId: scope.characterId, chatId: scope.chatId };

    const pluginHook = async (mode: ServerScriptMode, text: string): Promise<string> => {
        if (!job.hooks.scripts.includes(mode)) {
            return text;
        }
        services.fence(nativeCtx);
        let result: CallbackResult;
        try {
            result = await untilAborted(job.channel.callback(mode, { text }), nativeCtx.signal);
        } finally {
            services.refresh();
        }
        services.fence(nativeCtx);
        switch (result.outcome) {
            case "answered":
                return result.value === null || result.value === undefined ? text : String(result.value);
            case "refused":
                // Only a hook no longer registered keeps the text; a queue or nesting refusal would skip
                // a transformation the tab runs.
                if (result.refusal === "unregistered") {
                    return text;
                }
                throw services.latch(
                    new LuaJobFatalError(`The ${mode} callback was refused (${result.refusal ?? "unknown"})`),
                );
            case "failed":
                if (result.failure === "hook") {
                    throw new GenerationRunnerError(500, `The ${mode} plugin hook failed: ${result.error}`, {
                        stage: "script",
                    });
                }
                throw services.latch(
                    new LuaJobFatalError(`The ${mode} callback failed (${result.failure}): ${result.error}`),
                );
            default:
                throw services.latch(new LuaJobFatalError(`The ${mode} callback ended: ${result.outcome}`));
        }
    };

    return {
        editRequest: (char, formated) => runLuaEdit(setup, char, "editRequest", formated),
        // A failure anywhere in it (Lua, a plugin hook or its callback, the regex scripts and their
        // host) is a script's, unless a write or a request inside named its own stage.
        process: (char, input, mode, chatID = -1, cbsConditions = {}) =>
            asScript(() => processScripts(char, input, mode, chatID, cbsConditions)),
    };

    async function processScripts(
        char: character | groupChat,
        input: string,
        mode: ServerScriptMode,
        chatID: number,
        cbsConditions: CbsConditions,
    ): Promise<{ data: string; emoChanged: boolean }> {
        let data = input;
        let emoChanged = false;
        // `@@inject` writes the message at `chatID`: resolved to its id before the awaits.
        const injectMessageId = chatID === -1 ? undefined : services.liveChat()?.message[chatID]?.chatId;
        const luaMode = luaModeOf[mode];
        if (luaMode) {
            data = await runLuaEdit(setup, char, luaMode, data, { index: chatID });
        }
        data = await pluginHook(mode, data);

        const applyEffect = (effect: RegexScriptEffect) => {
            if (effect.kind === "emotion") {
                const image = (char as character).emotionImages?.find((emo) => emo[0] === effect.name);
                if (image) {
                    deps.showEmotion(char.chaId, image[0], image[1]);
                    emoChanged = true;
                }
                return;
            }
            if (!injectMessageId) {
                return;
            }
            if (lock.holder(chatRef.chaId, chatRef.chatId, injectMessageId) !== null) {
                console.warn("[Script] @@inject skipped a message being generated");
                return;
            }
            services.writeChat(
                (chat) =>
                    chat.message.some((message) => message.chatId === injectMessageId)
                        ? [{ op: "setText", id: injectMessageId, text: effect.text }]
                        : null,
                nativeCtx,
            );
        };
        data = await runScriptTail(deps, char, data, mode, chatID, cbsConditions, applyEffect);
        return { data, emoChanged };
    }
}
