import type { Database, character, loreBook } from "../database.ts";
import type { LLMModel } from "../llm.ts";
import type { RisuModule } from "../modules.ts";

/**
 * The CBS types both runtimes share. The registry (`registry.ts`) and the evaluator
 * (`evaluator.ts`) reach their host only through `CBSRegisterArg` and `CbsHost`.
 */
/**
 * The settings and the character list shared CBS reads from its host's database: the server's job
 * projection is a whole `Database`; the client serves these fields from its records
 * (`parser.svelte.ts`). The characters are in the legacy shape: shared CBS reads a character's
 * `chats` and `chatPage`.
 */
export type CbsDatabase = Pick<
    Database,
    | "aiModel"
    | "subModel"
    | "maxContext"
    | "promptTemplate"
    | "mainPrompt"
    | "jailbreak"
    | "jailbreakToggle"
    | "globalNote"
    | "language"
    | "characters"
>;

export type CbsConditions = {
    firstmsg?: boolean;
    chatRole?: string;
};

export type matcherArg = {
    chatID: number;
    /**
     * The chat this parse runs for (a send, a trigger, a Lua hook), by id; without it the selected
     * character's selected chat. Chat variables and chat/history macros read this chat.
     */
    chatRef?: { chaId: string; chatId: string } | null;
    db: CbsDatabase;
    chara: character | string;
    rmVar: boolean;
    var?: { [key: string]: string } | null;
    tokenizeAccurate?: boolean;
    consistantChar?: boolean;
    displaying?: boolean;
    role?: string;
    runVar?: boolean;
    funcName?: string;
    text?: string;
    recursiveCount?: number;
    lowLevelAccess?: boolean;
    cbsConditions: CbsConditions;
    triggerId?: string;
    getNested?: () => string[];
    setNestedRoot?: (val: string) => void;
};

export type RegisterCallback = (
    str: string,
    matcherArg: matcherArg,
    args: string[],
    vars: { [key: string]: string } | null,
) =>
    | {
          text: string;
          var: { [key: string]: string };
      }
    | string
    | null;

export type CBSRegisterArg = {
    registerFunction: (arg: {
        name: string;
        callback: RegisterCallback | "doc_only";
        alias: string[];
        description: string;
        deprecated?: {
            message: string;
            since?: string;
            replacement?: string;
        };
        internalOnly?: boolean;
    }) => void | Promise<void>;
    getDatabase: () => CbsDatabase;
    getUserName: (chatRef?: matcherArg["chatRef"]) => string;
    getPersonaPrompt: (chatRef?: matcherArg["chatRef"]) => string;
    risuChatParser: (text: string, arg: matcherArg) => string;
    makeArray: (arr: unknown[]) => string;
    safeStructuredClone: <T>(obj: T) => T;
    parseArray: (str: string) => unknown[];
    parseDict: (str: string) => { [key: string]: unknown };
    getChatVar: (key: string, chatRef?: matcherArg["chatRef"]) => string;
    setChatVar: (key: string, value: string, chatRef?: matcherArg["chatRef"]) => void;
    getGlobalChatVar: (key: string, chatRef?: matcherArg["chatRef"]) => string;
    calcString: (str: string) => number;
    dateTimeFormat: (format: string, timestamp?: number) => string;
    getModules: (chatRef?: matcherArg["chatRef"]) => RisuModule[];
    getModuleLorebooks: (chatRef?: matcherArg["chatRef"]) => loreBook[];
    pickHashRand: (seed: number, hash: string) => number;
    getSelectedCharID: () => number;
    getModelInfo: (model: string) => LLMModel;
    callInternalFunction: (args: string[]) => string;
    isMobile: boolean;
    appVer: string;
    /** The `risu-id` of the element that fired the manual trigger in progress, if any. */
    getTriggerId: () => string | null | undefined;
    /** The viewport the text is rendered for, in CSS pixels. */
    getViewport: () => { width: number; height: number };
    /** The browser's language (`navigator.language` on the client). */
    getBrowserLanguage: () => string;
    /**
     * Charges work to the evaluation in progress (`limits.ts`), before a loop or an allocation whose
     * size an argument sets: the units, or a function that counts them (called only by an evaluator
     * with limits). It throws when a limit is reached and does nothing in an evaluator without limits.
     */
    spend: (units: number | (() => number)) => void;
};
