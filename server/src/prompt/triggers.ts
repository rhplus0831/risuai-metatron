import type { Chat, character } from "../../../shared/database.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { RequestArgs, StreamResponseChunk } from "../../../shared/llm/request.ts";
import type { triggerEffect, triggerEffectV2, triggerscript } from "../../../shared/triggers.ts";
import {
    type CharacterPatchListener,
    type LuaBindingServices,
    LuaJobFatalError,
    type LuaWorkingCopy,
} from "../lua/bindings.ts";
import type { HostContext } from "../scripts/workerPool.ts";
import type { RegexMatch, RegexOp } from "../scripts/worker.ts";

/**
 * The server trigger runtime (Phase 5 slice 8b): `runTrigger` of `src/ts/process/triggers.ts`,
 * ported with the same effect switch. The client reaches its chat, records, alerts, and services
 * through globals; here they come from the job (`TriggerHost`): CBS over the job's scope, chat
 * variables and the author's note written to the job's chat as the run goes (never in display or
 * request runs), character effects on the executing character, alerts and questions through the job
 * channel, the request layer, the image callback, the worker's regex tasks, and the job's token
 * counter. The caller applies the returned working copy (`applyTriggerChat`).
 *
 * Recorded differences: the character is always a deep copy (display and request runs no longer
 * edit the live lore in place); every effect checks the job's abort and counts against the job's
 * 100,000-effect limit; a question that is not answered stops the run with an error; a nested
 * `v2RunTrigger` keeps the display mode, display data, and temporary variables; `v2Command` always
 * targets the job's chat; Lua character setters reach the native getters of the running triggers;
 * `v2CheckSimilarity` answers "null" until the embeddings service; `v2ConsoleLog` goes to the
 * server log.
 */

export type TriggerMode = "start" | "manual" | "output" | "input" | "display" | "request";

export type AdditionalSysPrompt = { start: string; historyend: string; promptend: string };

export type TriggerArg = {
    /** The chat the run starts from: copied (shallowly in display mode), never edited. */
    chat: Chat;
    recursiveCount?: number;
    additonalSysPrompt?: AdditionalSysPrompt;
    stopSending?: boolean;
    manualName?: string;
    displayMode?: boolean;
    displayData?: string;
    tempVars?: Record<string, string>;
};

export type TriggerResult = {
    additonalSysPrompt: AdditionalSysPrompt;
    chat: Chat;
    tokens: number;
    stopSending: boolean;
    sendAIprompt: boolean;
    displayData: string | undefined;
    tempVars: Record<string, string> | undefined;
};

/** The job a trigger runs in. */
export type TriggerHost = {
    services: LuaBindingServices;
    /** The job's chat (the client's `contextRef`). */
    chatRef: { chaId: string; chatId: string };
    /** The context of native calls: the job's run signal (abort and the fatal latch) and the worker's regex. */
    ctx: HostContext;
    observeCharacterPatches(listener: CharacterPatchListener): () => void;
    /**
     * A `triggerlua` effect on the run's working copy: a load failure, a spent budget, or a worker
     * failure throws (the client's `doString` throws out of `runScripted`); a failure inside the
     * handler is logged and the run goes on.
     */
    runLua(
        code: string,
        options: { mode: string; lowLevelAccess: boolean; working: LuaWorkingCopy },
    ): Promise<{
        stopSending: boolean;
    }>;
    /** The job's module triggers, each with its module's `lowLevelAccess` (`getModuleTriggers`). */
    moduleTriggers(): triggerscript[];
    templateDefaultVariables: string | undefined;
    /** `v2GetPersonaDesc`: the selected persona's prompt (the forwarded field), frozen with the job. */
    selectedPersonaPrompt: string;
    /** `v2SetPersonaDesc`: the job's effective persona (a bound persona wins). */
    effectivePersonaId: string | null;
    /** `v2Command`: a command line on the job's chat. */
    runCommand(line: string): Promise<unknown>;
    /** Every effect the job ran, across nested runs and `/trigger`. */
    effects: { count: number };
};

/** A run stops with an error past this many effects in one job (the client loops forever). */
export const MAX_TRIGGER_EFFECTS = 100_000;

/** The job's native effect limit was reached: never a script's own failure (`requestChatData`'s request-trigger fallback does not take it). */
export class TriggerEffectLimitError extends Error {
    constructor() {
        super(`more than ${MAX_TRIGGER_EFFECTS} trigger effects in one job`);
        this.name = "TriggerEffectLimitError";
    }
}

const safeSubset = [
    "v2SetVar",
    "v2If",
    "v2IfAdvanced",
    "v2Else",
    "v2EndIndent",
    "v2LoopNTimes",
    "v2BreakLoop",
    "v2ConsoleLog",
    "v2StopTrigger",
    "v2Random",
    "v2ExtractRegex",
    "v2RegexTest",
    "v2GetCharAt",
    "v2GetCharCount",
    "v2ToLowerCase",
    "v2ToUpperCase",
    "v2SetCharAt",
    "v2SplitString",
    "v2JoinArrayVar",
    "v2ConcatString",
    "v2MakeArrayVar",
    "v2GetArrayVarLength",
    "v2GetArrayVar",
    "v2SetArrayVar",
    "v2PushArrayVar",
    "v2PopArrayVar",
    "v2ShiftArrayVar",
    "v2UnshiftArrayVar",
    "v2SpliceArrayVar",
    "v2SliceArrayVar",
    "v2GetIndexOfValueInArrayVar",
    "v2RemoveIndexFromArrayVar",
    "v2Calculate",
    "v2Comment",
    "v2DeclareLocalVar",
];

export const displayAllowList = ["v2GetDisplayState", "v2SetDisplayState", ...safeSubset];

export const requestAllowList = [
    "v2GetRequestState",
    "v2SetRequestState",
    "v2GetRequestStateRole",
    "v2SetRequestStateRole",
    "v2GetRequestStateLength",
    ...safeSubset,
];

/** `parseKeyValue` of `src/ts/util.ts`: `key=value` lines. */
export function parseKeyValue(template: string | undefined): [string, string][] {
    try {
        if (!template) {
            return [];
        }
        const keyValue: [string, string][] = [];
        for (const line of template.split("\n")) {
            const [key, value] = line.split("=");
            if (key && value) {
                keyValue.push([key, value]);
            }
        }
        return keyValue;
    } catch {
        return [];
    }
}

/** `parseChatML` of `src/ts/parser/chatML.ts`, with the job's CBS. */
export function parseChatML(data: string, parse: (text: string) => string): OpenAIChat[] | null {
    const starter = "<|im_start|>";
    const seperator = "<|im_sep|>";
    const ender = "<|im_end|>";

    const trimedData = data.trim();
    if (!trimedData.startsWith(starter)) {
        return null;
    }

    return trimedData
        .split(starter)
        .filter((f) => f !== "")
        .map((v) => {
            let role: "system" | "user" | "assistant" = "user";
            if (v.startsWith("user" + seperator)) {
                role = "user";
                v = v.substring(4 + seperator.length);
            } else if (v.startsWith("system" + seperator)) {
                role = "system";
                v = v.substring(6 + seperator.length);
            } else if (v.startsWith("assistant" + seperator)) {
                role = "assistant";
                v = v.substring(9 + seperator.length);
            } else if (v.startsWith("user ") || v.startsWith("user\n")) {
                role = "user";
                v = v.substring(5);
            } else if (v.startsWith("system ") || v.startsWith("system\n")) {
                role = "system";
                v = v.substring(7);
            } else if (v.startsWith("assistant ") || v.startsWith("assistant\n")) {
                role = "assistant";
                v = v.substring(10);
            }

            v = v.trim();

            if (v.endsWith(ender)) {
                v = v.substring(0, v.length - ender.length);
            }

            const thoughts: string[] = [];
            v = v.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_, p1: string) => {
                thoughts.push(p1);
                return "";
            });

            return {
                role: role,
                content: parse(v),
                thoughts: thoughts,
            } as OpenAIChat;
        });
}

/** `collectStreamingText` of the client: the last snapshot's first key. */
async function collectStreamingText(stream: ReadableStream<StreamResponseChunk>): Promise<string> {
    const reader = stream.getReader();
    let lastChunk = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (value) {
                const firstKey = Object.keys(value)[0];
                if (firstKey) {
                    lastChunk = (value as Record<string, string>)[firstKey] ?? lastChunk;
                }
            }
            if (done) {
                break;
            }
        }
    } finally {
        reader.releaseLock();
    }
    return lastChunk;
}

/** The deprecated lore effects index an entry as an array (`[key, content, active]`), as the client does. */
type LegacyLore = Record<number, unknown>;

/** A pause that ends early with the run's abort. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason ?? new Error("request aborted"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("request aborted"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** One turn of the event loop, so a long run or a deep recursion lets other work in. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createTriggerRuntime(host: TriggerHost) {
    const { services, ctx } = host;

    /** A fatal failure or the run's abort is never turned into an effect's fallback value. */
    const rethrowFatal = (error: unknown) => {
        if (error instanceof LuaJobFatalError || ctx.signal.aborted) {
            throw error;
        }
    };

    /** A worker regex task: an ordinary failure comes back as `{ error }`; an abort rejects. */
    const regex = async (op: RegexOp) => {
        const result = await ctx.regex(op);
        services.fence(ctx);
        return result;
    };
    /** The job's counter, fenced on both sides: an abort during a count starts no other one. */
    const tokenize = async (text: string) => {
        services.fence(ctx);
        const tokens = await services.tokenize(text);
        services.fence(ctx);
        return tokens;
    };
    const regexValue = async <T>(op: RegexOp): Promise<T> => {
        const result = await regex(op);
        if ("error" in result) {
            throw new Error(result.error);
        }
        return result.value as T;
    };

    async function runTrigger(
        sourceChar: character,
        mode: TriggerMode,
        arg: TriggerArg,
    ): Promise<TriggerResult | null | undefined> {
        arg.recursiveCount ??= 0;
        // Every run (a nested `v2RunTrigger`, a `/trigger` inside `v2Command`) starts on a turn of
        // its own: a privileged recursion has no depth limit, so the effect limit ends it, not the stack.
        await yieldTurn();
        services.fence(ctx);
        // Always a copy: display and request runs edit their lore effects on it, not on a stored record.
        const char = structuredClone(sourceChar);
        // A Lua setter of this run (or a nested one) writes the record; the run's copy follows it.
        const unobserve = host.observeCharacterPatches((characterId, patch) => {
            if (characterId === char.chaId) {
                Object.assign(char, patch);
            }
        });
        try {
            return await run(char, mode, arg as TriggerArg & { recursiveCount: number });
        } finally {
            unobserve();
        }
    }

    async function run(
        char: character,
        mode: TriggerMode,
        arg: TriggerArg & { recursiveCount: number },
    ): Promise<TriggerResult | null | undefined> {
        let varChanged = false;
        let stopSending = arg.stopSending ?? false;
        const CharacterlowLevelAccess = char.lowLevelAccess ?? false;
        let sendAIprompt = false;
        const parse = (text: string) => services.parse(text, char);
        // Chat variables and the author's note are written to the job's chat as the run goes (so CBS
        // reads them), except in display and request runs; the caller applies the rest of the result.
        const writeChatMeta = (patch: Partial<Chat>) => {
            if (arg.displayMode) {
                return;
            }
            if (!services.chatExists()) {
                console.warn("[Trigger] The chat is gone; a variable change was not saved");
                return;
            }
            services.writeChat(() => [{ op: "meta", set: patch as Record<string, unknown> }], ctx);
        };
        // The character effects write the trigger's character (the copy's `chaId`), one field at a
        // time, and never in display and request runs.
        const writeCharacter = (patch: Partial<character>) => {
            if (arg.displayMode) {
                return;
            }
            if (!services.patchCharacter(patch as Record<string, unknown>, ctx)) {
                console.warn("[Trigger] The character is gone; a character change was not saved");
            }
        };
        let additonalSysPrompt: AdditionalSysPrompt = arg.additonalSysPrompt ?? {
            start: "",
            historyend: "",
            promptend: "",
        };
        const triggers: triggerscript[] = (char.triggerscript ?? [])
            .map((v) => {
                v.lowLevelAccess = CharacterlowLevelAccess;
                return v;
            })
            .concat(host.moduleTriggers());
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(
            parseKeyValue(host.templateDefaultVariables),
        );
        // The trigger's working copy. A display run copies only the chat and its message list (it runs
        // for every rendered message); its effects replace messages instead of editing them in place.
        let chat = (
            arg.displayMode ? { ...arg.chat, message: [...arg.chat.message] } : structuredClone(arg.chat)
        ) as Chat;

        if (!triggers || triggers.length === 0) {
            return null;
        }

        // The run owns the map (a nested run shares it) and returns it.
        arg.tempVars ??= {};
        const tempVars: Record<string, string> = arg.tempVars;

        let localVarScopes: Record<number, Record<string, string>>[] = [{}];
        let currentIndent = 0;

        function getLocalVar(key: string): string | null {
            if (!localVarScopes || localVarScopes.length === 0) {
                return null;
            }
            const currentScope = localVarScopes[localVarScopes.length - 1];
            if (!currentScope) {
                return null;
            }
            for (let indent = currentIndent; indent >= 0; indent--) {
                if (currentScope[indent] && currentScope[indent][key] !== undefined) {
                    return currentScope[indent][key];
                }
            }
            return null;
        }

        function setLocalVar(key: string, value: string, indent: number): boolean {
            if (!localVarScopes || localVarScopes.length === 0) {
                localVarScopes = [{}];
            }
            const currentScope = localVarScopes[localVarScopes.length - 1];
            if (!currentScope) {
                return false;
            }

            const finalValue = value === null || value === undefined ? "null" : value;

            let foundIndent = -1;
            for (let i = indent; i >= 0; i--) {
                if (currentScope[i] && currentScope[i][key] !== undefined) {
                    foundIndent = i;
                    break;
                }
            }

            const targetIndent = foundIndent !== -1 ? foundIndent : indent;

            if (!currentScope[targetIndent]) {
                currentScope[targetIndent] = {};
            }

            if (currentScope[targetIndent][key] === finalValue) {
                return false;
            }

            currentScope[targetIndent][key] = finalValue;
            return true;
        }

        function declareLocalVar(key: string, value: string, indent: number) {
            setLocalVar(key, value, indent);
        }

        function clearLocalVarsAtIndent(indent: number) {
            if (!localVarScopes || localVarScopes.length === 0) {
                return;
            }
            const currentScope = localVarScopes[localVarScopes.length - 1];
            if (!currentScope) {
                return;
            }
            const indentsToDelete: string[] = [];
            for (const scopeIndent in currentScope) {
                if (Number(scopeIndent) >= indent) {
                    indentsToDelete.push(scopeIndent);
                }
            }
            indentsToDelete.forEach((indentKey) => {
                delete currentScope[indentKey as unknown as number];
            });
        }

        function getVar(key: string): string {
            const localVar = getLocalVar(key);
            if (localVar !== null) {
                return localVar;
            }

            const state = chat.scriptstate?.["$" + key];
            if (state === undefined || state === null) {
                const findResult = defaultVariables.find((f) => {
                    return f[0] === key;
                });
                if (findResult) {
                    return findResult[1];
                }
                if (arg.displayMode) {
                    return tempVars[key] ?? "null";
                }
                return "null";
            }
            return state.toString();
        }

        function setVar(key: string, value: string): boolean {
            services.fence(ctx);
            if (arg.displayMode) {
                if (tempVars[key] === value) {
                    return false;
                }
                tempVars[key] = value;
                return true;
            }

            const localVar = getLocalVar(key);
            if (localVar !== null) {
                return setLocalVar(key, value, currentIndent);
            }

            chat.scriptstate ??= {};
            const stateKey = "$" + key;
            if (chat.scriptstate[stateKey] === value) {
                return false;
            }

            varChanged = true;
            chat.scriptstate[stateKey] = value;
            writeChatMeta({ scriptstate: structuredClone(chat.scriptstate) });
            return true;
        }

        /** An effect operand: its CBS text, or the variable it names. */
        const operand = (type: string | undefined, text: string) =>
            type === "value" ? parse(text) : getVar(parse(text));

        for (const trigger of triggers) {
            const loopCounters: Record<string, number> = {};

            if (trigger.effect[0]?.type === "triggercode" || trigger.effect[0]?.type === "triggerlua") {
                //
            } else if (arg.manualName) {
                if (trigger.comment !== arg.manualName) {
                    continue;
                }
            } else if (mode !== trigger.type) {
                continue;
            }

            // Legacy conditional triggers are no longer supported; skip rather than run unconditionally.
            if ((trigger.conditions?.length ?? 0) > 0) {
                continue;
            }

            for (let index = 0; index < trigger.effect.length; index++) {
                const effect: triggerEffect = trigger.effect[index];
                if (mode === "display" && !displayAllowList.includes(effect.type)) {
                    continue;
                }
                if (mode === "request" && !requestAllowList.includes(effect.type)) {
                    continue;
                }

                services.fence(ctx);
                host.effects.count++;
                if (host.effects.count > MAX_TRIGGER_EFFECTS) {
                    throw new TriggerEffectLimitError();
                }

                if (effect && "indent" in effect && typeof effect.indent === "number" && effect.indent >= 0) {
                    currentIndent = effect.indent;
                } else if (!effect || !("indent" in effect)) {
                    currentIndent = 0;
                }

                switch (effect.type) {
                    case "v2StopPromptSending": {
                        stopSending = true;
                        break;
                    }

                    case "triggerlua": {
                        const working: LuaWorkingCopy = { chat, getVar, setVar };
                        const triggerCodeResult = await host.runLua(effect.code, {
                            mode: (mode === "manual" ? arg.manualName : mode) ?? "manual",
                            lowLevelAccess: trigger.lowLevelAccess ?? false,
                            working,
                        });
                        services.fence(ctx);
                        if (triggerCodeResult.stopSending) {
                            stopSending = true;
                        }
                        // The script edited this working copy.
                        chat = working.chat;
                        break;
                    }

                    case "v2Header": {
                        break;
                    }
                    case "v2SetVar": {
                        const effectValue = operand(effect.valueType, effect.value);
                        const varKey = parse(effect.var);
                        let originalVar = Number(getVar(varKey));
                        if (Number.isNaN(originalVar)) {
                            originalVar = 0;
                        }
                        let resultValue = "";
                        switch (effect.operator) {
                            case "=": {
                                resultValue = effectValue;
                                break;
                            }
                            case "+=": {
                                resultValue = (originalVar + Number(effectValue)).toString();
                                break;
                            }
                            case "-=": {
                                resultValue = (originalVar - Number(effectValue)).toString();
                                break;
                            }
                            case "*=": {
                                resultValue = (originalVar * Number(effectValue)).toString();
                                break;
                            }
                            case "/=": {
                                resultValue = (originalVar / Number(effectValue)).toString();
                                break;
                            }
                            case "%=": {
                                resultValue = (originalVar % Number(effectValue)).toString();
                                break;
                            }
                        }
                        setVar(varKey, resultValue);
                        break;
                    }
                    case "v2DeclareLocalVar": {
                        const effectValue = operand(effect.valueType, effect.value);
                        const varKey = parse(effect.var);
                        const finalValue = effectValue === null || effectValue === undefined ? "null" : effectValue;
                        declareLocalVar(varKey, finalValue, effect.indent);
                        break;
                    }
                    case "v2If":
                    case "v2IfAdvanced": {
                        const sourceValue =
                            effect.type === "v2If" || effect.sourceType === "var"
                                ? getVar(parse(effect.source))
                                : parse(effect.source);
                        const targetValue = operand(effect.targetType, effect.target);
                        let pass = false;
                        switch (effect.condition) {
                            case "=": {
                                if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                                    pass = Number(sourceValue) === Number(targetValue);
                                } else {
                                    pass = sourceValue === targetValue;
                                }
                                break;
                            }
                            case "!=": {
                                if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                                    pass = Number(sourceValue) !== Number(targetValue);
                                } else {
                                    pass = sourceValue !== targetValue;
                                }
                                break;
                            }
                            case ">": {
                                pass = Number(sourceValue) > Number(targetValue);
                                break;
                            }
                            case "<": {
                                pass = Number(sourceValue) < Number(targetValue);
                                break;
                            }
                            case ">=": {
                                pass = Number(sourceValue) >= Number(targetValue);
                                break;
                            }
                            case "<=": {
                                pass = Number(sourceValue) <= Number(targetValue);
                                break;
                            }
                            case "∈": {
                                try {
                                    pass = JSON.parse(targetValue).includes(sourceValue);
                                } catch {
                                    pass = false;
                                }
                                break;
                            }
                            case "∋": {
                                try {
                                    pass = JSON.parse(sourceValue).includes(targetValue);
                                } catch {
                                    pass = false;
                                }
                                break;
                            }
                            case "∉": {
                                try {
                                    pass = !JSON.parse(targetValue).includes(sourceValue);
                                } catch {
                                    pass = true;
                                }
                                break;
                            }
                            case "∌": {
                                try {
                                    pass = !JSON.parse(sourceValue).includes(targetValue);
                                } catch {
                                    pass = true;
                                }
                                break;
                            }
                            case "≒": {
                                const num1 = Number(sourceValue);
                                const num2 = Number(targetValue);
                                if (Number.isNaN(num1) || Number.isNaN(num2)) {
                                    pass =
                                        sourceValue.toLocaleLowerCase().replace(/ /g, "") ===
                                        targetValue.toLocaleLowerCase().replace(/ /g, "");
                                } else {
                                    pass = Math.abs(num1 - num2) < 0.0001;
                                }
                                break;
                            }
                            case "≡": {
                                if (targetValue === "true") {
                                    pass = sourceValue === "true" || sourceValue === "1";
                                } else if (targetValue === "false") {
                                    pass = !(sourceValue === "true" || sourceValue === "1");
                                } else {
                                    pass = sourceValue === targetValue;
                                }
                            }
                        }

                        if (!pass) {
                            let indent = effect.indent + 1;
                            for (; index < trigger.effect.length; index++) {
                                const ef = trigger.effect[index] as triggerEffectV2;
                                if (ef.type === "v2EndIndent" && indent === ef.indent) {
                                    const nextEf = trigger.effect[index + 1] as triggerEffectV2 | undefined;
                                    indent--;
                                    if (nextEf?.type === "v2Else" && nextEf?.indent === indent) {
                                        index++;
                                    }

                                    break;
                                }
                            }
                        }
                        break;
                    }
                    case "v2Else": {
                        // An `if` that passed skips its `else`.
                        const indent = effect.indent + 1;
                        for (; index < trigger.effect.length; index++) {
                            const ef = trigger.effect[index] as triggerEffectV2;
                            if (ef.type === "v2EndIndent" && indent === ef.indent) {
                                break;
                            }
                        }
                        break;
                    }
                    case "v2EndIndent": {
                        if (effect.endOfLoop) {
                            const indent = effect.indent - 1;
                            const originalIndex = index;
                            for (; index >= 0; index--) {
                                const ef = trigger.effect[index] as triggerEffectV2;
                                if ((ef.type === "v2Loop" || ef.type === "v2LoopNTimes") && indent === ef.indent) {
                                    if (ef.type === "v2LoopNTimes") {
                                        const value = operand(ef.valueType, ef.value);
                                        let valueNum = Number(value);
                                        if (Number.isNaN(valueNum)) {
                                            valueNum = 0;
                                        }
                                        loopCounters[index + "LoopNTimes"] =
                                            (loopCounters[index + "LoopNTimes"] ?? 0) + 1;
                                        if (loopCounters[index + "LoopNTimes"] >= valueNum) {
                                            index = originalIndex;
                                        } else {
                                            break;
                                        }
                                    }

                                    break;
                                }
                            }

                            // The client sleeps 1 ms every 100 iterations; a turn of the event loop here.
                            loopCounters["loopTimes"] = (loopCounters["loopTimes"] ?? 0) + 1;
                            if (loopCounters["loopTimes"] > 100) {
                                await yieldTurn();
                                services.fence(ctx);
                                loopCounters["loopTimes"] = 0;
                            }
                        }

                        clearLocalVarsAtIndent(effect.indent);

                        break;
                    }
                    case "v2Loop":
                    case "v2LoopNTimes": {
                        // Looping is handled by the v2EndIndent.
                        break;
                    }
                    case "v2BreakLoop": {
                        for (; index < trigger.effect.length; index++) {
                            const ef = trigger.effect[index] as triggerEffectV2;
                            if (ef.type === "v2EndIndent" && ef.endOfLoop) {
                                break;
                            }
                        }
                        break;
                    }
                    case "v2RunTrigger": {
                        if (arg.recursiveCount < 10 || trigger.lowLevelAccess) {
                            arg.recursiveCount++;
                            const r = await runTrigger(char, "manual", {
                                chat,
                                recursiveCount: arg.recursiveCount,
                                additonalSysPrompt,
                                stopSending,
                                manualName: effect.target,
                                displayMode: arg.displayMode,
                                displayData: arg.displayData,
                                tempVars,
                            });
                            services.fence(ctx);
                            if (r) {
                                additonalSysPrompt = r.additonalSysPrompt;
                                chat = r.chat;
                                stopSending = r.stopSending;
                                arg.displayData = r.displayData;
                            }
                        }
                        break;
                    }
                    case "v2ConsoleLog": {
                        const sourceValue = operand(effect.sourceType, effect.source);
                        console.log("[Trigger]", sourceValue);
                        break;
                    }
                    case "v2StopTrigger": {
                        index = trigger.effect.length;
                        break;
                    }
                    case "v2CutChat": {
                        let start =
                            effect.startType === "value"
                                ? Number(parse(effect.start))
                                : Number(getVar(parse(effect.start)));
                        let end =
                            effect.endType === "value" ? Number(parse(effect.end)) : Number(getVar(parse(effect.end)));
                        if (isNaN(start)) {
                            start = 0;
                        }
                        if (isNaN(end)) {
                            end = chat.message.length;
                        }

                        chat.message = chat.message.slice(start, end);
                        break;
                    }
                    case "v2ModifyChat": {
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const value = operand(effect.valueType, effect.value);
                        if (chat.message[at]) {
                            chat.message[at] = { ...chat.message[at], data: value };
                        }
                        break;
                    }
                    case "v2SystemPrompt": {
                        const value = operand(effect.valueType, effect.value);
                        additonalSysPrompt[effect.location] += value + "\n\n";
                        break;
                    }
                    case "v2Impersonate": {
                        const value = operand(effect.valueType, effect.value);
                        if (effect.role === "user") {
                            chat.message.push({ role: "user", data: value });
                        } else if (effect.role === "char") {
                            chat.message.push({ role: "char", data: value });
                        }
                        break;
                    }
                    case "v2Command": {
                        const value = operand(effect.valueType, effect.value);
                        // Its writes go to the job's chat (the client's display runs fall back to the
                        // selected chat).
                        await host.runCommand(value);
                        services.fence(ctx);
                        break;
                    }
                    case "v2SendAIprompt": {
                        if (!trigger.lowLevelAccess) {
                            break;
                        }
                        sendAIprompt = true;
                        break;
                    }
                    case "v2ImgGen": {
                        if (!trigger.lowLevelAccess) {
                            break;
                        }
                        const value = operand(effect.valueType, effect.value);
                        const negValue = operand(effect.negValueType, effect.negValue);
                        // The tab generates and stores the inlay (`generateImage` callback).
                        const inlay = await services.generateImageInlay(value, negValue, char.chaId, ctx);
                        services.fence(ctx);
                        if (!inlay) {
                            setVar(parse(effect.outputVar), "null");
                            break;
                        }
                        setVar(parse(effect.outputVar), `{{inlay::${inlay}}}`);
                        break;
                    }
                    case "v2CheckSimilarity": {
                        if (!trigger.lowLevelAccess) {
                            break;
                        }
                        operand(effect.sourceType, effect.source);
                        operand(effect.valueType, effect.value);
                        // Until the embeddings service (slice 10): the failure value.
                        console.warn("[Trigger] Similarity search is not available on the server yet");
                        setVar(parse(effect.outputVar), "null");
                        break;
                    }
                    case "v2RunLLM": {
                        if (!trigger.lowLevelAccess) {
                            break;
                        }
                        const value = operand(effect.valueType, effect.value);
                        let promptbody = parseChatML(value, (text) => services.parse(text, undefined));
                        if (!promptbody) {
                            promptbody = [{ role: "user", content: value }];
                        }
                        const result = await services.request(
                            {
                                formated: promptbody,
                                bias: {},
                                useStreaming: effect.streaming ?? false,
                                noMultiGen: true,
                                chatRef: host.chatRef,
                            } as RequestArgs,
                            effect.model,
                            ctx,
                        );
                        services.fence(ctx);

                        if (result.type === "fail" || result.type === "multiline") {
                            setVar(parse(effect.outputVar), "null");
                        } else if (result.type === "streaming") {
                            const text = await collectStreamingText(result.result);
                            services.fence(ctx);
                            setVar(parse(effect.outputVar), text);
                        } else {
                            setVar(parse(effect.outputVar), result.result);
                        }
                        break;
                    }
                    case "v2ShowAlert": {
                        if (arg.displayMode) {
                            return undefined;
                        }
                        const value = operand(effect.valueType, effect.value);
                        services.notice({ kind: "alertNormal", payload: { message: value } });
                        break;
                    }
                    case "v2ExtractRegex": {
                        const value = operand(effect.valueType, effect.value);
                        const regexValue_ = operand(effect.regexType, effect.regex);
                        const flagsValue = operand(effect.flagsType, effect.flags);
                        // An invalid pattern throws out of the run, as `new RegExp` does on the client.
                        const found = await regexValue<RegexMatch | null>({
                            op: "exec",
                            pattern: regexValue_,
                            flags: flagsValue,
                            input: value,
                        });
                        const regexResult = found ? [found.match, ...found.groups] : null;
                        const resultValue = operand(effect.resultType, effect.result);

                        let result = "";
                        if (regexResult !== null) {
                            result = resultValue
                                .replace(/\$[0-9]+/g, (match) => {
                                    const at = Number(match.slice(1));
                                    return regexResult[at] || "";
                                })
                                .replace(/\$&/g, regexResult[0] || "")
                                .replace(/\$\$/g, "$");
                        } else {
                            result = resultValue
                                .replace(/\$[0-9]+/g, "")
                                .replace(/\$&/g, "")
                                .replace(/\$\$/g, "$");
                        }

                        setVar(parse(effect.outputVar), result);
                        break;
                    }
                    case "v2GetLastMessage": {
                        setVar(parse(effect.outputVar), chat.message[chat.message.length - 1]?.data ?? "null");
                        break;
                    }
                    case "v2GetMessageAtIndex": {
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        setVar(parse(effect.outputVar), chat.message[at]?.data ?? "null");
                        break;
                    }
                    case "v2GetMessageCount": {
                        setVar(parse(effect.outputVar), chat.message.length.toString());
                        break;
                    }
                    case "v2ModifyLorebook": {
                        char.globalLore = char.globalLore ?? [];
                        const target = operand(effect.targetType, effect.target);
                        const value = operand(effect.valueType, effect.value);

                        const at = char.globalLore.findIndex((v) => (v as unknown as LegacyLore)[0] === target);
                        if (at !== -1) {
                            (char.globalLore[at] as unknown as LegacyLore)[1] = value;
                        }

                        writeCharacter({ globalLore: char.globalLore });
                        break;
                    }
                    case "v2GetLorebook": {
                        char.globalLore = char.globalLore ?? [];
                        const target = operand(effect.targetType, effect.target);
                        const at = char.globalLore.findIndex((v) => (v as unknown as LegacyLore)[0] === target);
                        setVar(
                            parse(effect.outputVar),
                            (at === -1 ? "null" : (char.globalLore[at] as unknown as LegacyLore)[1]) as string,
                        );
                        break;
                    }
                    case "v2GetLorebookCount": {
                        char.globalLore = char.globalLore ?? [];
                        setVar(parse(effect.outputVar), char.globalLore.length.toString());
                        break;
                    }
                    case "v2GetLorebookEntry": {
                        char.globalLore = char.globalLore ?? [];
                        let at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        if (Number.isNaN(at)) {
                            at = 0;
                        }
                        setVar(
                            parse(effect.outputVar),
                            ((char.globalLore[at] as unknown as LegacyLore | undefined)?.[1] ?? "null") as string,
                        );
                        break;
                    }
                    case "v2SetLorebookActivation": {
                        char.globalLore = char.globalLore ?? [];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const value = effect.value;
                        if (!Number.isInteger(at) || at < 0 || !char.globalLore[at]) {
                            console.warn("[Trigger] No lorebook entry at this index; the activation was not changed");
                            break;
                        }
                        (char.globalLore[at] as unknown as LegacyLore)[2] = value;

                        writeCharacter({ globalLore: char.globalLore });

                        break;
                    }
                    case "v2GetLorebookIndexViaName": {
                        char.globalLore = char.globalLore ?? [];
                        const name = operand(effect.nameType, effect.name);
                        const at = char.globalLore.findIndex((v) => (v as unknown as LegacyLore)[0] === name);
                        setVar(parse(effect.outputVar), at.toString());
                        break;
                    }
                    case "v2Random": {
                        const min =
                            effect.minType === "value" ? Number(parse(effect.min)) : Number(getVar(parse(effect.min)));
                        const max =
                            effect.maxType === "value" ? Number(parse(effect.max)) : Number(getVar(parse(effect.max)));

                        const random = Math.floor(Math.random() * (max - min + 1) + min);
                        setVar(parse(effect.outputVar), random.toString());
                        break;
                    }
                    case "v2GetCharAt": {
                        const source = operand(effect.sourceType, effect.source);
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        setVar(parse(effect.outputVar), source[at] ?? "null");
                        break;
                    }
                    case "v2GetCharCount": {
                        const source = operand(effect.sourceType, effect.source);
                        setVar(parse(effect.outputVar), source.length.toString());
                        break;
                    }
                    case "v2ToLowerCase": {
                        const source = operand(effect.sourceType, effect.source);
                        setVar(parse(effect.outputVar), source.toLowerCase());
                        break;
                    }
                    case "v2ToUpperCase": {
                        const source = operand(effect.sourceType, effect.source);
                        setVar(parse(effect.outputVar), source.toUpperCase());
                        break;
                    }
                    case "v2SetCharAt": {
                        const source = operand(effect.sourceType, effect.source);
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const value = operand(effect.valueType, effect.value);
                        const source2 = [...source];
                        source2[at] = value;
                        setVar(parse(effect.outputVar), source2.join(""));
                        break;
                    }
                    case "v2SplitString": {
                        const source = operand(effect.sourceType, effect.source);
                        let delimiter: string;

                        if (effect.delimiterType === "value") {
                            delimiter = parse(effect.delimiter);
                        } else if (effect.delimiterType === "var") {
                            delimiter = getVar(parse(effect.delimiter));
                        } else {
                            delimiter = parse(effect.delimiter);
                        }

                        let result: (string | undefined)[];
                        if (effect.delimiterType === "regex") {
                            try {
                                const regexMatch = delimiter.match(/^\/(.+)\/([gimuy]*)$/);
                                const [pattern, flags] = regexMatch ? [regexMatch[1], regexMatch[2]] : [delimiter, ""];
                                result = await regexValue<(string | undefined)[]>({
                                    op: "split",
                                    pattern,
                                    flags,
                                    input: source,
                                });
                            } catch (error) {
                                rethrowFatal(error);
                                result = [source];
                            }
                        } else {
                            result = source.split(delimiter);
                        }

                        setVar(parse(effect.outputVar), JSON.stringify(result));
                        break;
                    }
                    case "v2JoinArrayVar": {
                        try {
                            const varValue = operand(effect.varType, effect.var);
                            const arr = JSON.parse(varValue);
                            const delimiter = operand(effect.delimiterType, effect.delimiter);
                            setVar(parse(effect.outputVar), arr.join(delimiter));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "");
                        }
                        break;
                    }
                    case "v2GetCharacterDesc": {
                        setVar(parse(effect.outputVar), char.desc);
                        break;
                    }
                    case "v2SetCharacterDesc": {
                        const value = operand(effect.valueType, effect.value);
                        char.desc = value;
                        writeCharacter({ desc: value });
                        break;
                    }
                    case "v2GetPersonaDesc": {
                        // The selected persona's prompt (the forwarded field), as the job froze it.
                        setVar(parse(effect.outputVar), host.selectedPersonaPrompt);
                        break;
                    }
                    case "v2SetPersonaDesc": {
                        const value = operand(effect.valueType, effect.value);
                        // The job's effective persona (a bound persona wins). Never in display runs.
                        if (arg.displayMode) {
                            break;
                        }
                        const personaId = host.effectivePersonaId;
                        if (!personaId) {
                            console.warn("[Trigger] No persona is selected; the persona description was not saved");
                            break;
                        }
                        if (!services.patchPersonaPrompt(personaId, value, ctx)) {
                            console.warn("[Trigger] The persona is gone; the persona description was not saved");
                        }
                        break;
                    }
                    case "v2GetReplaceGlobalNote": {
                        setVar(parse(effect.outputVar), char.replaceGlobalNote ?? "");
                        break;
                    }
                    case "v2SetReplaceGlobalNote": {
                        const value = operand(effect.valueType, effect.value);
                        char.replaceGlobalNote = value;
                        writeCharacter({ replaceGlobalNote: value });
                        break;
                    }
                    case "v2MakeArrayVar": {
                        const varName = parse(effect.var);
                        if (varName.startsWith("[") && varName.endsWith("]")) {
                            return undefined;
                        }

                        setVar(varName, "[]");
                        break;
                    }
                    case "v2GetArrayVarLength": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            setVar(parse(effect.outputVar), arr.length.toString());
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "0");
                        }
                        break;
                    }
                    case "v2GetArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const at =
                                effect.indexType === "value"
                                    ? Number(parse(effect.index))
                                    : Number(getVar(parse(effect.index)));
                            setVar(parse(effect.outputVar), arr[at] ?? "null");
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "null");
                        }
                        break;
                    }
                    case "v2PushArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const value = operand(effect.valueType, effect.value);
                            arr.push(value);
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.var), "[]");
                        }
                        break;
                    }
                    case "v2PopArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            setVar(parse(effect.outputVar), arr.pop() ?? "null");
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.var), "[]");
                            setVar(parse(effect.outputVar), "null");
                        }
                        break;
                    }
                    case "v2ShiftArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            setVar(parse(effect.outputVar), arr.shift() ?? "null");
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.var), "[]");
                            setVar(parse(effect.outputVar), "null");
                        }
                        break;
                    }
                    case "v2UnshiftArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const value = operand(effect.valueType, effect.value);
                            arr.unshift(value);
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.var), "[]");
                        }
                        break;
                    }
                    case "v2SpliceArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const start =
                                effect.startType === "value"
                                    ? Number(parse(effect.start))
                                    : Number(getVar(parse(effect.start)));
                            const value = operand(effect.itemType, effect.item);
                            arr.splice(start, 0, value);
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.var), "[]");
                        }
                        break;
                    }
                    case "v2SliceArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const start =
                                effect.startType === "value"
                                    ? Number(parse(effect.start))
                                    : Number(getVar(parse(effect.start)));
                            const end =
                                effect.endType === "value"
                                    ? Number(parse(effect.end))
                                    : Number(getVar(parse(effect.end)));

                            setVar(parse(effect.outputVar), JSON.stringify(arr.slice(start, end)));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "[]");
                        }
                        break;
                    }
                    case "v2GetIndexOfValueInArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const value = operand(effect.valueType, effect.value);
                            setVar(parse(effect.outputVar), arr.indexOf(value).toString());
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "-1");
                        }
                        break;
                    }
                    case "v2RemoveIndexFromArrayVar": {
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            const at =
                                effect.indexType === "value"
                                    ? Number(parse(effect.index))
                                    : Number(getVar(parse(effect.index)));
                            arr.splice(at, 1);
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.var), "[]");
                        }
                        break;
                    }
                    case "v2ConcatString": {
                        const source1 = operand(effect.source1Type, effect.source1);
                        const source2 = operand(effect.source2Type, effect.source2);
                        setVar(parse(effect.outputVar), source1 + source2);
                        break;
                    }
                    case "v2GetLastUserMessage": {
                        const lastUserMessage = chat.message
                            .slice()
                            .reverse()
                            .find((v) => v.role === "user");
                        setVar(parse(effect.outputVar), lastUserMessage?.data ?? "null");
                        break;
                    }
                    case "v2GetLastCharMessage": {
                        const lastCharMessage = chat.message
                            .slice()
                            .reverse()
                            .find((v) => v.role === "char");
                        setVar(parse(effect.outputVar), lastCharMessage?.data ?? "null");
                        break;
                    }
                    case "v2GetFirstMessage": {
                        setVar(
                            parse(effect.outputVar),
                            chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings[chat.fmIndex as number],
                        );
                        break;
                    }
                    case "v2GetAlertInput": {
                        if (arg.displayMode) {
                            return undefined;
                        }
                        const answer = await services.ask(
                            {
                                kind: "alertInput",
                                payload: { message: operand(effect.displayType, effect.display) },
                            },
                            ctx,
                        );
                        services.fence(ctx);
                        setVar(parse(effect.outputVar), typeof answer === "string" ? answer : String(answer ?? ""));
                        break;
                    }
                    case "v2GetAlertSelect": {
                        if (arg.displayMode) {
                            return undefined;
                        }
                        const display = operand(effect.displayType, effect.display);
                        const value = operand(effect.valueType, effect.value);
                        const options = value.split("|");
                        const answer = await services.ask({ kind: "alertSelect", payload: { options, display } }, ctx);
                        services.fence(ctx);
                        setVar(parse(effect.outputVar), typeof answer === "string" ? answer : String(answer ?? ""));
                        break;
                    }
                    case "v2SetArrayVar": {
                        const value = operand(effect.valueType, effect.value);
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        if (Number.isNaN(at)) {
                            break;
                        }
                        try {
                            const varName = parse(effect.var);
                            const arr = JSON.parse(getVar(varName));
                            arr[at] = value;
                            setVar(varName, JSON.stringify(arr));
                        } catch (error) {
                            rethrowFatal(error);
                        }
                        break;
                    }
                    case "v2GetDisplayState": {
                        if (!arg.displayMode) {
                            return undefined;
                        }

                        setVar(parse(effect.outputVar), arg.displayData ?? "null");
                        break;
                    }
                    case "v2SetDisplayState": {
                        if (!arg.displayMode) {
                            return undefined;
                        }
                        arg.displayData = operand(effect.valueType, effect.value);
                        break;
                    }
                    case "v2UpdateGUI": {
                        services.notice({ kind: "updateGUI", payload: {} });
                        break;
                    }
                    case "v2UpdateChatAt": {
                        // The client bumps its display pointer at that position of the shown chat.
                        const at = Number(effect.index);
                        const message = Number.isInteger(at) && at >= 0 ? services.liveChat().message[at] : undefined;
                        if (message?.chatId) {
                            services.notice({
                                kind: "reloadChat",
                                payload: { ...host.chatRef, messageId: message.chatId },
                            });
                        }
                        break;
                    }
                    case "v2Wait": {
                        const value =
                            effect.valueType === "value"
                                ? Number(parse(effect.value))
                                : Number(getVar(parse(effect.value)));
                        await abortableSleep(Math.max(0, value * 1000) || 0, ctx.signal);
                        services.fence(ctx);
                        break;
                    }
                    case "v2GetRequestState": {
                        if (!arg.displayMode) {
                            return undefined;
                        }
                        const json = JSON.parse(arg.displayData as string) as OpenAIChat[];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const content = json?.[at]?.content ?? "null";
                        setVar(parse(effect.outputVar), content);
                        break;
                    }
                    case "v2SetRequestState": {
                        if (!arg.displayMode) {
                            return undefined;
                        }
                        const json = JSON.parse(arg.displayData as string) as OpenAIChat[];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const value = operand(effect.valueType, effect.value);
                        json[at].content = value;
                        arg.displayData = JSON.stringify(json);
                        break;
                    }
                    case "v2GetRequestStateRole": {
                        if (!arg.displayMode) {
                            return undefined;
                        }
                        const json = JSON.parse(arg.displayData as string) as OpenAIChat[];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const content = json?.[at]?.role ?? "null";
                        setVar(parse(effect.outputVar), content);
                        break;
                    }
                    case "v2SetRequestStateRole": {
                        if (!arg.displayMode) {
                            return undefined;
                        }
                        const json = JSON.parse(arg.displayData as string) as OpenAIChat[];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        const value = operand(effect.valueType, effect.value);
                        if (value === "user" || value === "assistant" || value === "system") {
                            json[at].role = value;
                        }
                        arg.displayData = JSON.stringify(json);
                        break;
                    }

                    case "v2GetRequestStateLength": {
                        if (!arg.displayMode) {
                            return undefined;
                        }
                        const json = JSON.parse(arg.displayData as string) as OpenAIChat[];
                        setVar(parse(effect.outputVar), json.length.toString());
                        break;
                    }
                    case "v2QuickSearchChat": {
                        const value = operand(effect.valueType, effect.value);
                        const depth =
                            effect.depthType === "value"
                                ? Number(parse(effect.depth))
                                : Number(getVar(parse(effect.depth)));
                        const condition = effect.condition;

                        if (isNaN(depth)) {
                            setVar(parse(effect.outputVar), "0");
                            break;
                        }
                        let pass = false;
                        const da = chat.message
                            .slice(0 - depth)
                            .map((v) => v.data)
                            .join(" ");
                        if (condition === "strict") {
                            pass = da.split(" ").includes(value);
                        } else if (condition === "loose") {
                            pass = da.toLowerCase().includes(value.toLowerCase());
                        } else if (condition === "regex") {
                            // An invalid pattern throws out of the run, as on the client.
                            pass = await regexValue<boolean>({ op: "test", pattern: value, flags: "", input: da });
                        }
                        setVar(parse(effect.outputVar), pass ? "1" : "0");
                        break;
                    }
                    case "v2Tokenize": {
                        const value = operand(effect.valueType, effect.value);
                        // The client resolves the output name before it awaits the count.
                        const outputKey = parse(effect.outputVar);
                        const tokens = await tokenize(value);
                        setVar(outputKey, tokens.toString());
                        break;
                    }
                    case "v2GetAllLorebooks": {
                        char.globalLore = char.globalLore ?? [];
                        const allPrompts: string[] = [];
                        for (const lore of char.globalLore) {
                            if (lore && lore.content !== undefined) {
                                allPrompts.push(lore.content);
                            }
                        }
                        setVar(parse(effect.outputVar), JSON.stringify(allPrompts));
                        break;
                    }
                    case "v2GetLorebookByName": {
                        char.globalLore = char.globalLore ?? [];
                        const name = operand(effect.nameType, effect.name);
                        // The client compiles the pattern first, even with no entry to test.
                        await regexValue<boolean>({ op: "test", pattern: name, flags: "i", input: "" });
                        const matchingIndices: number[] = [];
                        for (let i = 0; i < char.globalLore.length; i++) {
                            const lore = char.globalLore[i];
                            if (
                                lore &&
                                lore.comment !== undefined &&
                                (await regexValue<boolean>({
                                    op: "test",
                                    pattern: name,
                                    flags: "i",
                                    input: lore.comment,
                                }))
                            ) {
                                matchingIndices.push(i);
                            }
                        }
                        setVar(parse(effect.outputVar), JSON.stringify(matchingIndices));
                        break;
                    }
                    case "v2GetLorebookByIndex": {
                        char.globalLore = char.globalLore ?? [];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));
                        if (Number.isNaN(at) || at < 0 || at >= char.globalLore.length) {
                            setVar(parse(effect.outputVar), "null");
                        } else {
                            const loreEntry = char.globalLore[at];
                            if (loreEntry && loreEntry.content !== undefined) {
                                setVar(parse(effect.outputVar), loreEntry.content);
                            } else {
                                setVar(parse(effect.outputVar), "null");
                            }
                        }
                        break;
                    }
                    case "v2CreateLorebook": {
                        char.globalLore = char.globalLore ?? [];
                        const name = operand(effect.nameType, effect.name);
                        const key = operand(effect.keyType, effect.key);
                        const content = operand(effect.contentType, effect.content);
                        const insertOrder =
                            effect.insertOrderType === "value"
                                ? Number(parse(effect.insertOrder))
                                : Number(getVar(parse(effect.insertOrder)));

                        char.globalLore.push({
                            key: key,
                            comment: name,
                            content: content,
                            mode: "normal",
                            insertorder: Number.isNaN(insertOrder) ? 100 : insertOrder,
                            alwaysActive: false,
                            secondkey: "",
                            selective: false,
                        });

                        writeCharacter({ globalLore: char.globalLore });
                        break;
                    }
                    case "v2ModifyLorebookByIndex": {
                        char.globalLore = char.globalLore ?? [];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));

                        if (Number.isNaN(at) || at < 0 || at >= char.globalLore.length || !char.globalLore[at]) {
                            break;
                        }

                        const currentLore = char.globalLore[at];

                        let name = operand(effect.nameType, effect.name);
                        name = name.replace(/{{slot}}/g, currentLore.comment || "");
                        char.globalLore[at].comment = name;

                        let key = operand(effect.keyType, effect.key);
                        key = key.replace(/{{slot}}/g, currentLore.key || "");
                        char.globalLore[at].key = key;

                        let content = operand(effect.contentType, effect.content);
                        content = content.replace(/{{slot}}/g, currentLore.content || "");
                        char.globalLore[at].content = content;

                        let insertOrder = operand(effect.insertOrderType, effect.insertOrder);
                        insertOrder = insertOrder.replace(/{{slot}}/g, (currentLore.insertorder || 100).toString());
                        const insertOrderNum = Number(insertOrder);
                        if (!Number.isNaN(insertOrderNum)) {
                            char.globalLore[at].insertorder = insertOrderNum;
                        }

                        writeCharacter({ globalLore: char.globalLore });
                        break;
                    }
                    case "v2DeleteLorebookByIndex": {
                        char.globalLore = char.globalLore ?? [];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));

                        if (Number.isNaN(at) || at < 0 || at >= char.globalLore.length || !char.globalLore[at]) {
                            break;
                        }

                        char.globalLore.splice(at, 1);

                        writeCharacter({ globalLore: char.globalLore });
                        break;
                    }
                    case "v2GetLorebookCountNew": {
                        char.globalLore = char.globalLore ?? [];
                        setVar(parse(effect.outputVar), char.globalLore.length.toString());
                        break;
                    }
                    case "v2SetLorebookAlwaysActive": {
                        char.globalLore = char.globalLore ?? [];
                        const at =
                            effect.indexType === "value"
                                ? Number(parse(effect.index))
                                : Number(getVar(parse(effect.index)));

                        if (Number.isNaN(at) || at < 0 || at >= char.globalLore.length || !char.globalLore[at]) {
                            break;
                        }

                        char.globalLore[at].alwaysActive = effect.value;

                        writeCharacter({ globalLore: char.globalLore });
                        break;
                    }
                    case "v2RegexTest": {
                        try {
                            const value = operand(effect.valueType, effect.value);
                            const regexPattern = operand(effect.regexType, effect.regex);
                            const flags = operand(effect.flagsType, effect.flags);
                            const result = await regexValue<boolean>({
                                op: "test",
                                pattern: regexPattern,
                                flags,
                                input: value,
                            });
                            setVar(parse(effect.outputVar), result ? "1" : "0");
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "0");
                        }
                        break;
                    }
                    case "v2GetAuthorNote": {
                        setVar(parse(effect.outputVar), chat.note ?? "");
                        break;
                    }
                    case "v2SetAuthorNote": {
                        const value = operand(effect.valueType, effect.value);
                        chat.note = value;
                        writeChatMeta({ note: value });
                        break;
                    }
                    case "v2MakeDictVar": {
                        if (effect.var.startsWith("{") && effect.var.endsWith("}")) {
                            return undefined;
                        }

                        setVar(parse(effect.var), "{}");
                        break;
                    }
                    case "v2GetDictVar": {
                        try {
                            const varValue = operand(effect.varType, effect.var);
                            const dict = JSON.parse(varValue);
                            const key = operand(effect.keyType, effect.key);
                            setVar(parse(effect.outputVar), dict[key] ?? "null");
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "null");
                        }
                        break;
                    }
                    case "v2SetDictVar": {
                        try {
                            const value = operand(effect.valueType, effect.value);
                            const key = operand(effect.keyType, effect.key);

                            if (effect.varType === "value") {
                                break;
                            }

                            const dict = JSON.parse(getVar(parse(effect.var)));
                            dict[key] = value;
                            setVar(parse(effect.var), JSON.stringify(dict));
                        } catch (error) {
                            rethrowFatal(error);
                            if (effect.varType === "var") {
                                const value = operand(effect.valueType, effect.value);
                                const key = operand(effect.keyType, effect.key);
                                const dict: Record<string, string> = {};
                                dict[key] = value;
                                setVar(parse(effect.var), JSON.stringify(dict));
                            }
                        }
                        break;
                    }
                    case "v2DeleteDictKey": {
                        try {
                            if (effect.varType === "value") {
                                break;
                            }

                            const dict = JSON.parse(getVar(parse(effect.var)));
                            const key = operand(effect.keyType, effect.key);
                            delete dict[key];
                            setVar(parse(effect.var), JSON.stringify(dict));
                        } catch (error) {
                            rethrowFatal(error);
                            if (effect.varType === "var") {
                                setVar(parse(effect.var), "{}");
                            }
                        }
                        break;
                    }
                    case "v2HasDictKey": {
                        try {
                            const varValue = operand(effect.varType, effect.var);
                            const dict = JSON.parse(varValue);
                            const key = operand(effect.keyType, effect.key);
                            setVar(parse(effect.outputVar), Object.hasOwn(dict, key) ? "1" : "0");
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "0");
                        }
                        break;
                    }
                    case "v2ClearDict": {
                        if (effect.var.startsWith("{") && effect.var.endsWith("}")) {
                            return undefined;
                        }
                        setVar(parse(effect.var), "{}");
                        break;
                    }
                    case "v2GetDictSize": {
                        try {
                            const varValue = operand(effect.varType, effect.var);
                            const dict = JSON.parse(varValue);
                            setVar(parse(effect.outputVar), Object.keys(dict).length.toString());
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "0");
                        }
                        break;
                    }
                    case "v2GetDictKeys": {
                        try {
                            const varValue = operand(effect.varType, effect.var);
                            const dict = JSON.parse(varValue);
                            setVar(parse(effect.outputVar), JSON.stringify(Object.keys(dict)));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "[]");
                        }
                        break;
                    }
                    case "v2GetDictValues": {
                        try {
                            const varValue = operand(effect.varType, effect.var);
                            const dict = JSON.parse(varValue);
                            setVar(parse(effect.outputVar), JSON.stringify(Object.values(dict)));
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "[]");
                        }
                        break;
                    }
                    case "v2Calculate": {
                        try {
                            let expression = operand(effect.expressionType, effect.expression);
                            expression = expression.replace(/\$([a-zA-Z0-9_]+)/g, (_, varName: string) => {
                                const varValue = getVar(varName);
                                const parsed = parseFloat(varValue);
                                return isNaN(parsed) ? "0" : parsed.toString();
                            });

                            const result = services.calc(expression);
                            setVar(parse(effect.outputVar), result.toString());
                        } catch (error) {
                            rethrowFatal(error);
                            setVar(parse(effect.outputVar), "0");
                        }
                        break;
                    }
                    case "v2ReplaceString": {
                        try {
                            const source = operand(effect.sourceType, effect.source);
                            const regexPattern = operand(effect.regexType, effect.regex);
                            const resultFormat = operand(effect.resultType, effect.result);
                            const replacement = operand(effect.replacementType, effect.replacement);
                            const flags = operand(effect.flagsType, effect.flags);

                            // `source.replace(regex, replacer)`: the matches from the worker, the
                            // replacer on this thread (the client's, including its `args.slice(1, -2)`,
                            // which holds the match offset as a last "group" when the regex has named groups).
                            const matches = await regexValue<RegexMatch[]>({
                                op: "matches",
                                pattern: regexPattern,
                                flags,
                                input: source,
                            });
                            let result = "";
                            let last = 0;
                            for (const found of matches) {
                                const match = found.match;
                                const groups: (string | number | undefined)[] =
                                    found.named !== null ? [...found.groups, found.index] : [...found.groups];
                                const replaced = (() => {
                                    const targetGroupMatch = resultFormat.match(/^\$(\d+)$/);
                                    if (targetGroupMatch) {
                                        const targetIndex = Number(targetGroupMatch[1]);
                                        if (targetIndex === 0) {
                                            return replacement;
                                        } else {
                                            const targetGroup = groups[targetIndex - 1];
                                            if (targetGroup) {
                                                return match.replace(targetGroup as string, replacement);
                                            }
                                        }
                                    }

                                    return resultFormat
                                        .replace(/\$[0-9]+/g, (placeholder) => {
                                            const at = Number(placeholder.slice(1));
                                            return at === 0 ? match : String(groups[at - 1] || "");
                                        })
                                        .replace(/\$&/g, match)
                                        .replace(/\$\$/g, "$");
                                })();
                                result += source.slice(last, found.index) + replaced;
                                last = found.index + match.length;
                            }
                            result += source.slice(last);
                            setVar(parse(effect.outputVar), result);
                        } catch (error) {
                            rethrowFatal(error);
                            const source = operand(effect.sourceType, effect.source);
                            setVar(parse(effect.outputVar), source);
                        }
                        break;
                    }
                    case "v2Comment": {
                        break;
                    }
                }
            }
        }

        let caculatedTokens = 0;
        if (additonalSysPrompt.start) {
            caculatedTokens += await tokenize(additonalSysPrompt.start);
        }
        if (additonalSysPrompt.historyend) {
            caculatedTokens += await tokenize(additonalSysPrompt.historyend);
        }
        if (additonalSysPrompt.promptend) {
            caculatedTokens += await tokenize(additonalSysPrompt.promptend);
        }
        if (varChanged) {
            services.notice({ kind: "updateGUI", payload: {} });
        }

        return {
            additonalSysPrompt,
            chat,
            tokens: caculatedTokens,
            stopSending,
            sendAIprompt,
            displayData: arg.displayData,
            tempVars: arg.tempVars,
        };
    }

    return { runTrigger };
}
