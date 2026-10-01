import type { Database, character, loreBook } from "../database.ts";
import type { LLMModel } from "../llm.ts";
import type { RisuModule } from "../modules.ts";

/**
 * The CBS types both runtimes share. The registry (`registry.ts`) and the evaluator
 * (`evaluator.ts`) reach their host only through `CBSRegisterArg` and `CbsHost`.
 */
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
    db: Database;
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
    getDatabase: () => Database;
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
};
