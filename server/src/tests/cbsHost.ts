// A CBS host for the Node tests (not a test file itself).
import type { Chat, Database, character, groupChat } from "../../../shared/database.ts";
import { calcString } from "../../../shared/cbs/calc.ts";
import { createCbsEvaluator, type CbsHost } from "../../../shared/cbs/evaluator.ts";
import type { matcherArg } from "../../../shared/cbs/types.ts";

type ChatRef = matcherArg["chatRef"];

export type NodeCbsHostOptions = {
    /** The index the client's `selectedCharID` would hold. */
    selectedCharID: number;
    viewport?: { width: number; height: number };
    browserLanguage?: string;
    /** `{{trigger_id}}`: the client's `CurrentTriggerIdStore`. */
    triggerId?: () => string | null;
    appVer?: string;
};

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

/**
 * A `CbsHost` over a plain `Database` object that answers what the client host answers for the same
 * data: the selected character by index, a `chatRef` by ids, chat variables from `scriptstate` with
 * the `defaultVariables`/`templateDefaultVariables` fallback, globals with the chat's
 * `GLGlobalVariables` override, the bound persona's name, and the calculator bound to the selected
 * chat (as `src/ts/process/infunctions.ts` binds it). Modules are empty.
 */
export function createNodeCbsHost(db: Database, options: NodeCbsHostOptions): CbsHost {
    const characterOf = (ref?: ChatRef): character | groupChat | undefined =>
        ref ? db.characters.find((entry) => entry?.chaId === ref.chaId) : db.characters[options.selectedCharID];
    const chatOf = (ref?: ChatRef): Chat | undefined => {
        const char = characterOf(ref);
        if (!char) {
            return undefined;
        }
        return (ref ? char.chats.find((chat) => chat.id === ref.chatId) : char.chats[char.chatPage]) as
            Chat | undefined;
    };
    const boundPersona = (ref?: ChatRef) => {
        const chat = chatOf(ref);
        return chat?.bindedPersona ? db.personas.find((persona) => persona.id === chat.bindedPersona) : undefined;
    };
    const getChatVar = (key: string, ref?: ChatRef): string => {
        const char = characterOf(ref);
        if (!char) {
            return "null";
        }
        const state = chatOf(ref)?.scriptstate?.["$" + key];
        if (state === undefined || state === null) {
            const defaults = parseKeyValue((char as character).defaultVariables).concat(
                parseKeyValue(db.templateDefaultVariables),
            );
            return defaults.find((pair) => pair[0] === key)?.[1] ?? "null";
        }
        return state.toString();
    };
    const getGlobalChatVar = (key: string, ref?: ChatRef): string => {
        const local = chatOf(ref)?.GLGlobalVariables?.[key];
        if (local !== "null" && local) {
            return local;
        }
        return db.globalChatVariables[key] ?? "null";
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
        getUserName: (ref) => boundPersona(ref)?.name ?? db.username ?? "User",
        getPersonaPrompt: (ref) => boundPersona(ref)?.personaPrompt ?? db.personaPrompt ?? "",
        safeStructuredClone: (value) => structuredClone(value),
        getChatVar,
        setChatVar: (key, value, ref) => {
            const chat = chatOf(ref);
            if (chat) {
                chat.scriptstate = { ...(chat.scriptstate ?? {}), ["$" + key]: value };
            }
        },
        getGlobalChatVar,
        // The calculator answers `undefined` for an empty stack; the client passes that through as well.
        calcString: (text) =>
            calcString(text, {
                getChatVar: (key) => getChatVar(key),
                getGlobalChatVar: (key) => getGlobalChatVar(key),
            }) as number,
        getModules: () => [],
        getModuleLorebooks: () => [],
        pickHashRand: () => {
            throw new Error("pickHashRand is not part of the test host");
        },
        getSelectedCharID: () => options.selectedCharID,
        getModelInfo: (model) => ({
            id: model,
            name: model,
            provider: 0,
            flags: [],
            format: 0,
            parameters: [],
            tokenizer: 0,
        }),
        callInternalFunction: () => "",
        isMobile: false,
        appVer: options.appVer ?? "0.0.0-test",
        getTriggerId: () => options.triggerId?.() ?? null,
        getViewport: () => options.viewport ?? { width: 0, height: 0 },
        getBrowserLanguage: () => options.browserLanguage ?? "en",
        findCharacterById,
    };
}

export function createNodeCbsEvaluator(db: Database, options: NodeCbsHostOptions) {
    return createCbsEvaluator(createNodeCbsHost(db, options));
}
