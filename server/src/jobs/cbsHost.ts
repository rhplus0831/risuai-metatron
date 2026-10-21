import { readFileSync } from "node:fs";
import path from "node:path";
import type { Chat, character, groupChat, loreBook } from "../../../shared/database.ts";
import type { RisuModule } from "../../../shared/modules.ts";
import { calcString } from "../../../shared/cbs/calc.ts";
import type { CbsHost } from "../../../shared/cbs/evaluator.ts";
import { DEFAULT_CBS_MAX_WORK, type CbsLimits, type CbsUsage } from "../../../shared/cbs/limits.ts";
import type { matcherArg } from "../../../shared/cbs/types.ts";
import { pickHashRand } from "../../../shared/hashRand.ts";
import { personaLinksModule, personaModuleIdSet } from "../../../shared/personas.ts";
import type { GenerationClientEnv } from "../../../shared/jobs.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { resolveGlobalChatVar, toggleDefinitionsText } from "../../../shared/prompt/toggles.ts";
import type { JobScope } from "./jobScope.ts";

type ChatRef = matcherArg["chatRef"];

/** `parseKeyValue` of `src/ts/util.ts`: `key=value` lines. */
function parseKeyValue(template: string | undefined): [string, string][] {
    if (!template) {
        return [];
    }
    const pairs: [string, string][] = [];
    for (const line of template.split("\n")) {
        const [key, value] = line.split("=");
        if (key && value) {
            pairs.push([key, value]);
        }
    }
    return pairs;
}

let appVersion: string | null = null;

/** The app version (`version.json`, the client's `appVer`), read once; `0.0.0` when it is missing. */
export function serverAppVersion(rootDir: string): string {
    if (appVersion === null) {
        try {
            const parsed = JSON.parse(readFileSync(path.join(rootDir, "version.json"), "utf8")) as {
                version?: unknown;
            };
            appVersion = typeof parsed.version === "string" ? parsed.version : "0.0.0";
        } catch {
            appVersion = "0.0.0";
        }
    }
    return appVersion;
}

/**
 * The server's CBS limits (`shared/cbs/limits.ts`): card text is evaluated on the
 * main thread, so one template is held to a work count and a wall time, and a job's templates
 * together to an allowance of evaluation time. The numbers are policy, chosen with room for large
 * inline data in card text (a multi-megabyte data URL scans at about 80 ns per character).
 */
export const SERVER_CBS_MAX_WORK = DEFAULT_CBS_MAX_WORK;
export const SERVER_CBS_MAX_MS = 5_000;
export const SERVER_CBS_JOB_MS = 60_000;

/** The limits of one job's evaluators: `usage` is the job's, shared by every run of it. */
export function serverCbsLimits(usage: CbsUsage): CbsLimits {
    return {
        maxWork: SERVER_CBS_MAX_WORK,
        maxMs: SERVER_CBS_MAX_MS,
        total: { usage, maxMs: SERVER_CBS_JOB_MS },
    };
}

/** How a job's chat variables are written: through the job (`job.write`), the change itself or false. */
export type JobChatVarWriter = (key: string, value: string) => boolean;

export type JobCbsOptions = {
    rootDir: string;
    /** Writes a chat variable of the job's chat (the client's `setChatVarOf`). */
    setChatVar: JobChatVarWriter;
    client?: GenerationClientEnv;
    /** `{{trigger_id}}`: the manual trigger's element id, if the job runs one. */
    triggerId?: string | null;
    /** The evaluation limits (`serverCbsLimits` of the job's usage). */
    limits: CbsLimits;
};

/**
 * The server's CBS host over a job's scope: what the client host (`src/ts/parser/parser.svelte.ts`
 * `clientCbsHost`, with `risuChatParserScoped`'s preset and persona) answers for the same data. Chat
 * variables read the chat's `scriptstate` with the `defaultVariables`/`templateDefaultVariables`
 * fallback and write through the job; globals read the chat's `GLGlobalVariables` override; the
 * persona is the job's frozen effective one for its chat; modules resolve as the client's
 * `getModules`; the viewport and language are the tab's (`context.client`); `isMobile` is false and
 * the internal function empty, as the client host has them.
 *
 * The host carries `options.limits`, so its evaluator is bounded (`shared/cbs/limits.ts`). The
 * default variables are parsed once per source text, not per missing variable.
 */
export function createJobCbsHost(scope: JobScope, options: JobCbsOptions): CbsHost {
    const db = scope.db;
    const isJobChat = (ref?: ChatRef) => !ref || (ref.chaId === scope.characterId && ref.chatId === scope.chatId);
    const characterOf = (ref?: ChatRef): character | groupChat | undefined =>
        ref ? db.characters.find((entry) => entry?.chaId === ref.chaId) : selectedCharacter();
    const selectedCharacter = () => db.characters.find((entry) => entry?.chaId === scope.characterId);
    const chatOf = (ref?: ChatRef): Chat | undefined => {
        const char = characterOf(ref);
        if (!char) {
            return undefined;
        }
        return (ref ? char.chats.find((chat) => chat.id === ref.chatId) : char.chats[char.chatPage]) as
            Chat | undefined;
    };
    /** `checkPersonaBinded`: the job's chat has its frozen effective persona; another chat its binding. */
    const personaFor = (ref?: ChatRef) => {
        if (isJobChat(ref)) {
            return scope.effectivePersona;
        }
        const bound = chatOf(ref)?.bindedPersona;
        return bound ? db.personas.find((persona) => persona.id === bound) : undefined;
    };
    // The defaults of the last character asked for, by their source texts: the first pair of a key
    // wins, the character's before the template's.
    let defaultsOf: { character: string | undefined; template: string | undefined; map: Map<string, string> } | null =
        null;
    const defaultVariable = (char: character | groupChat, key: string): string | undefined => {
        const characterText = (char as character).defaultVariables;
        const templateText = db.templateDefaultVariables;
        if (!defaultsOf || defaultsOf.character !== characterText || defaultsOf.template !== templateText) {
            const map = new Map<string, string>();
            for (const [name, value] of parseKeyValue(characterText).concat(parseKeyValue(templateText))) {
                if (!map.has(name)) {
                    map.set(name, value);
                }
            }
            defaultsOf = { character: characterText, template: templateText, map };
        }
        return defaultsOf.map.get(key);
    };
    const getChatVar = (key: string, ref?: ChatRef): string => {
        const char = characterOf(ref);
        if (!char) {
            return "null";
        }
        const state = chatOf(ref)?.scriptstate?.["$" + key];
        if (state === undefined || state === null) {
            return defaultVariable(char, key) ?? "null";
        }
        return state.toString();
    };
    const getGlobalChatVar = (key: string, ref?: ChatRef): string => {
        return resolveGlobalChatVar(key, chatOf(ref)?.GLGlobalVariables, db.globalChatVariables, () => {
            const char = characterOf(ref);
            // The scope forwards the job's preset roots; even a cross-chat ref has only that preset.
            // The shared resolver caches by text so live character overlays can change definitions.
            return toggleDefinitionsText(
                db.customPromptTemplateToggle,
                jobModules(scope, ref)
                    .map((module) => (typeof module.customModuleToggle === "string" ? module.customModuleToggle : ""))
                    .join("\n"),
                char?.type !== "group" ? char?.customModuleToggle : "",
            );
        });
    };
    const findCharacterById = (id: string): character => {
        for (const char of db.characters) {
            if (char.type !== "group" && char.chaId === id) {
                return char;
            }
        }
        return { name: "Unknown Character", chats: [], chatPage: 0 } as unknown as character;
    };
    return {
        getDatabase: () => db,
        getUserName: (ref) => {
            const persona = personaFor(ref);
            return persona ? persona.name : (db.username ?? "User");
        },
        getPersonaPrompt: (ref) => {
            const persona = personaFor(ref);
            return persona ? persona.personaPrompt : (db.personaPrompt ?? "");
        },
        safeStructuredClone: (value) => structuredClone(value),
        getChatVar,
        setChatVar: (key, value, ref) => {
            // Only the job's chat is writable from a job; another chat is not part of its scope.
            if (isJobChat(ref)) {
                options.setChatVar(key, value);
            }
        },
        getGlobalChatVar,
        // The client binds the calculator to the selected chat (`src/ts/process/infunctions.ts`).
        // The calculator reads and converts a variable at every reference: here one calculation reads
        // it once and hands over its number (the same text the calculator's own conversion gives).
        calcString: (text) => {
            const once = (read: (key: string) => string) => {
                const numbers = new Map<string, string>();
                return (key: string) => {
                    let number = numbers.get(key);
                    if (number === undefined) {
                        number = String(parseFloat(read(key)));
                        numbers.set(key, number);
                    }
                    return number;
                };
            };
            return calcString(text, {
                getChatVar: once((key) => getChatVar(key)),
                getGlobalChatVar: once((key) => getGlobalChatVar(key)),
            }) as number;
        },
        getModules: (ref) => jobModules(scope, ref),
        getModuleLorebooks: (ref) => jobModuleLorebooks(scope, ref),
        pickHashRand,
        getSelectedCharID: () => db.characters.findIndex((entry) => entry?.chaId === scope.characterId),
        getModelInfo: (model) =>
            resolveModelInfo(model, {
                enableCustomFlags: db.enableCustomFlags,
                customFlags: db.customFlags,
                customModels: db.customModels,
                pluginModels: scope.request.db.pluginModels,
            }),
        callInternalFunction: () => "",
        isMobile: false,
        appVer: serverAppVersion(options.rootDir),
        getTriggerId: () => options.triggerId ?? null,
        getViewport: () => options.client?.viewport ?? { width: 0, height: 0 },
        getBrowserLanguage: () => options.client?.browserLanguage ?? "en",
        findCharacterById,
        limits: options.limits,
    };
}

/**
 * `getModuleByIds` of `src/ts/process/modules.ts`: stored order, by id or namespace, or linked by
 * the persona (`personaLinksModule`), first of an id.
 */
function modulesByIds(modules: RisuModule[], ids: string[], personaIds: ReadonlySet<string>): RisuModule[] {
    const idSet = new Set(ids);
    const matched = modules.filter(
        (module) =>
            idSet.has(module.id) ||
            (module.namespace && idSet.has(module.namespace)) ||
            personaLinksModule(personaIds, module),
    );
    const seen = new Set<string>();
    const out: RisuModule[] = [];
    for (const module of matched) {
        if (seen.has(module.id)) {
            continue;
        }
        seen.add(module.id);
        out.push(module);
    }
    return out;
}

/**
 * `getModules` of `src/ts/process/modules.ts` over the scope: the global enabled list, the chat's and
 * the character's modules, the bound persona's embedded module id, and `moduleIntergration` (by id
 * or namespace), plus the bound persona's linked modules, matched apart (by id only, MCP modules
 * excepted: `personaLinksModule`); each id resolves only to a stored module (so an embedded module
 * resolves only when one with its id is in `modules`, as on the client).
 */
export function jobModules(scope: JobScope, ref?: ChatRef): RisuModule[] {
    const db = scope.db;
    const target = ref ?? { chaId: scope.characterId, chatId: scope.chatId };
    const character = db.characters.find((entry) => entry?.chaId === target.chaId);
    const chat = character?.chats?.find((entry) => entry.id === target.chatId);
    const bound = chat?.bindedPersona ? db.personas.find((persona) => persona.id === chat.bindedPersona) : null;
    let ids: string[] = db.enabledModules ?? [];
    if (chat) {
        ids = ids.concat(chat.modules ?? []);
    }
    if (character && character.modules) {
        ids = ids.concat(character.modules);
    }
    if (bound && bound.embeddedModule) {
        ids = ids.concat([bound.embeddedModule?.id]);
    }
    if (db.moduleIntergration) {
        ids = ids.concat(db.moduleIntergration.split(",").map((s) => s.trim()));
    }
    return modulesByIds(db.modules ?? [], ids, personaModuleIdSet(bound));
}

/** `getModuleLorebooks`: the lore of `jobModules`, in module order. */
export function jobModuleLorebooks(scope: JobScope, ref?: ChatRef): loreBook[] {
    let lorebooks: loreBook[] = [];
    for (const module of jobModules(scope, ref)) {
        if (module?.lorebook) {
            lorebooks = lorebooks.concat(module.lorebook);
        }
    }
    return lorebooks;
}
