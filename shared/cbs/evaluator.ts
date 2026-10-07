import type { character, groupChat } from "../database.ts";
import {
    CbsLimitError,
    checkCbsClock,
    createCbsBudget,
    enterCbsParse,
    leaveCbsParse,
    replaceAllBound,
    spendCbsWork,
    type CbsBudget,
    type CbsLimits,
} from "./limits.ts";
import { registerCBS } from "./registry.ts";
import type { CBSRegisterArg, CbsConditions, CbsDatabase, RegisterCallback, matcherArg } from "./types.ts";

/**
 * The CBS evaluator, shared by the client and the server (PLAN.md Decision 2): the `{{...}}`
 * loop, block statements (`#if`, `#when`, `#each`, `#func`, ...), and the registry's functions.
 * The application state comes only through `CbsHost` (the registry's globals apply here too,
 * and `dateTimeFormat` uses the runtime's timezone); an evaluator registers the functions on first
 * use.
 *
 * A host with `limits` (`limits.ts`: the server) gets a bounded evaluator: a top-level
 * `risuChatParser` call that reaches a limit throws `CbsLimitError`. Without `limits` nothing is
 * counted and the results are the same.
 */
export type CbsHost = Omit<
    CBSRegisterArg,
    "registerFunction" | "risuChatParser" | "makeArray" | "parseArray" | "parseDict" | "dateTimeFormat" | "spend"
> & {
    /** A character by `chaId`; the client answers a blank "Unknown Character" when there is none. */
    findCharacterById: (id: string) => character;
    /** Limits on evaluation; none on the client. */
    limits?: CbsLimits;
};

export type CbsParseArg = {
    chatID?: number;
    db?: CbsDatabase;
    chara?: string | character | groupChat;
    rmVar?: boolean;
    var?: { [key: string]: string };
    tokenizeAccurate?: boolean;
    consistantChar?: boolean;
    visualize?: boolean;
    role?: string;
    runVar?: boolean;
    functions?: Map<string, { data: string; arg: string[] }>;
    callStack?: number;
    cbsConditions?: CbsConditions;
    /** The chat this parse runs for (default: the selected chat); see `matcherArg.chatRef`. */
    chatRef?: { chaId: string; chatId: string } | null;
};

type Evaluator = {
    host: CbsHost;
    matchers: Map<string, RegisterCallback>;
    registered: boolean;
    budget: CbsBudget | null;
};

export type CbsEvaluator = {
    risuChatParser: (da: string, arg?: CbsParseArg) => string;
};

export function createCbsEvaluator(host: CbsHost): CbsEvaluator {
    const ev: Evaluator = {
        host,
        matchers: new Map(),
        registered: false,
        budget: host.limits ? createCbsBudget(host.limits) : null,
    };
    return { risuChatParser: (da, arg = {}) => parse(ev, da, arg) };
}

function ensureRegistered(ev: Evaluator): void {
    if (ev.registered) {
        return;
    }
    registerCBS({
        ...ev.host,
        registerFunction: (arg) => {
            const callback = arg.callback;
            if (callback === "doc_only") {
                return;
            }
            for (const name of [arg.name, ...arg.alias]) {
                ev.matchers.set(name, callback);
            }
        },
        risuChatParser: (text, arg) => parse(ev, text, arg as CbsParseArg),
        makeArray,
        parseArray,
        parseDict,
        dateTimeFormat,
        spend: (units) => {
            if (ev.budget) {
                spendCbsWork(ev.budget, typeof units === "function" ? units() : units);
            }
        },
    });
    ev.registered = true;
}

const replacements = [
    "{", //0xE9B8
    "}", //0xE9B9
    "(", //0xE9BA
    ")", //0xE9BB
    "&lt;", //0xE9BC
    "&gt;", //0xE9BD
    ":", //0xE9BE
    ";", //0xE9BF
];

export function risuUnescape(text: string) {
    return text.replace(/[\uE9b8-\uE9bf]/g, (f) => {
        const index = f.charCodeAt(0) - 0xe9b8;
        return replacements[index];
    });
}

export function risuEscape(text: string) {
    return text.replace(/[{}()]/g, (f) => {
        switch (f) {
            case "{":
                return "\uE9B8";
            case "}":
                return "\uE9B9";
            case "(":
                return "\uE9BA";
            case ")":
                return "\uE9BB";
            default:
                return f;
        }
    });
}

function matcher(
    ev: Evaluator,
    p1: string,
    matcherArg: matcherArg,
    vars: { [key: string]: string } | null = null,
):
    | {
          text: string;
          var: { [key: string]: string };
      }
    | string
    | null {
    ensureRegistered(ev);

    try {
        if (p1.startsWith("? ")) {
            const substring = p1.substring(2);
            return ev.host.calcString(substring).toString();
        }
        const colonIndex = p1.indexOf(":");
        let splited: string[];
        if (colonIndex !== -1 && p1[colonIndex + 1] === ":") {
            splited = p1.split("::");
        } else {
            splited = p1.split(":");
        }
        const name = splited[0].toLocaleLowerCase().replace(/[\s_-]/g, "");
        const args = splited.slice(1);
        const callback = ev.matchers.get(name);
        if (callback) {
            return callback(p1, matcherArg, args, vars);
        }
    } catch (error) {
        // A function's failure leaves its literal text; a reached limit ends the evaluation.
        if (error instanceof CbsLimitError) {
            throw error;
        }
    }

    return null;
}

export const dateTimeFormat = (main: string, time = 0) => {
    const date = time === 0 ? new Date() : new Date(time);
    if (!main) {
        return "";
    }
    if (main.startsWith(":")) {
        main = main.substring(1);
    }
    if (main.length > 300) {
        return "";
    }
    return main
        .replace(/YYYY/g, date.getFullYear().toString())
        .replace(/YY/g, date.getFullYear().toString().substring(2))
        .replace(/MMMM/g, Intl.DateTimeFormat("en", { month: "long" }).format(date))
        .replace(/MMM/g, Intl.DateTimeFormat("en", { month: "short" }).format(date))
        .replace(/MM/g, (date.getMonth() + 1).toString().padStart(2, "0"))
        .replace(
            /DDDD/g,
            Math.floor(
                (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24),
            ).toString(),
        )
        .replace(/DD/g, date.getDate().toString().padStart(2, "0"))
        .replace(/dddd/g, Intl.DateTimeFormat("en", { weekday: "long" }).format(date))
        .replace(/ddd/g, Intl.DateTimeFormat("en", { weekday: "short" }).format(date))
        .replace(/HH/g, date.getHours().toString().padStart(2, "0"))
        .replace(/hh/g, (date.getHours() % 12 || 12).toString().padStart(2, "0"))
        .replace(/mm/g, date.getMinutes().toString().padStart(2, "0"))
        .replace(/ss/g, date.getSeconds().toString().padStart(2, "0"))
        .replace(/X/g, Math.floor(date.getTime() / 1000).toString())
        .replace(/x/g, date.getTime().toString())
        .replace(/A/g, date.getHours() >= 12 ? "PM" : "AM");
};

const legacyBlockMatcher = (p1: string, matcherArg: matcherArg) => {
    const bn = p1.indexOf("\n");

    if (bn === -1) {
        return null;
    }

    const logic = p1.substring(0, bn);
    const content = p1.substring(bn + 1);
    const statement = logic.split(" ", 2);

    switch (statement[0]) {
        case "if": {
            if (["", "0", "-1"].includes(statement[1])) {
                return "";
            }

            return content.trim();
        }
    }

    return null;
};

type blockMatch =
    | "ignore"
    | "parse"
    | "nothing"
    | "ifpure"
    | "pure"
    | "each"
    | "function"
    | "pure-display"
    | "normalize"
    | "escape"
    | "newif"
    | "newif-falsy";

export function parseArray(p1: string): unknown[] {
    try {
        const arr = JSON.parse(p1);
        if (Array.isArray(arr)) {
            return arr;
        }
        return p1.split("§");
    } catch (error) {
        return p1.split("§");
    }
}

export function parseDict(p1: string): { [key: string]: unknown } {
    try {
        return JSON.parse(p1);
    } catch (error) {
        return {};
    }
}

export function makeArray(p1: unknown[]): string {
    return JSON.stringify(
        p1.map((f) => {
            if (typeof f === "string") {
                return f.replace(/::/g, "\\u003A\\u003A");
            }
            return f;
        }),
    );
}

function blockStartMatcher(
    ev: Evaluator,
    p1: string,
    matcherArg: matcherArg,
): { type: blockMatch; type2?: string; funcArg?: string[]; mode?: string } {
    const readVar = (key: string) => ev.host.getChatVar(key, matcherArg.chatRef);
    const readGlobalVar = (key: string) => ev.host.getGlobalChatVar(key, matcherArg.chatRef);
    if (p1.startsWith("#if") || p1.startsWith("#if_pure ")) {
        const statement = p1.split(" ", 2);
        const state = statement[1];
        if (state === "true" || state === "1") {
            return {
                type: p1.startsWith("#if_pure") ? "ifpure" : "parse",
            };
        }
        return { type: "ignore" };
    }

    if (p1.startsWith("#when")) {
        if (p1.startsWith("#when ")) {
            const statement = p1.split(" ", 2);
            const state = statement[1];
            return { type: state === "true" || state === "1" ? "newif" : "newif-falsy" };
        } else if (p1.startsWith("#when::")) {
            const statement = p1.split("::").slice(1);
            if (statement.length === 1) {
                const state = statement[0];
                return { type: state === "true" || state === "1" ? "newif" : "newif-falsy" };
            }
            let mode: "normal" | "keep" | "legacy" = "normal";

            const isTruthy = (s: string) => {
                return s === "true" || s === "1";
            };
            while (statement.length > 1) {
                const condition = statement.pop()!;
                const operator = statement.pop()!;
                switch (operator) {
                    case "not": {
                        if (isTruthy(condition)) {
                            statement.push("0");
                        } else {
                            statement.push("1");
                        }
                        break;
                    }
                    case "keep": {
                        mode = "keep";
                        statement.push(condition);
                        break;
                    }
                    case "legacy": {
                        mode = "legacy";
                        statement.push(condition);
                        break;
                    }
                    case "and": {
                        const condition2 = statement.pop()!;
                        if (isTruthy(condition) && isTruthy(condition2)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "or": {
                        const condition2 = statement.pop()!;
                        if (isTruthy(condition) || isTruthy(condition2)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "is": {
                        const condition2 = statement.pop()!;
                        if (condition === condition2) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "isnot": {
                        const condition2 = statement.pop()!;
                        if (condition !== condition2) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "var": {
                        const variable = readVar(condition);
                        if (isTruthy(variable)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "toggle": {
                        const variable = readGlobalVar("toggle_" + condition);
                        if (isTruthy(variable)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "vis": {
                        //vis = variable is
                        const variable = readVar(statement.pop()!);
                        if (variable === condition) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "visnot": {
                        //visnot = variable is not
                        const variable = readVar(statement.pop()!);
                        if (variable !== condition) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "tis": {
                        //tis = toggle is
                        const variable = readGlobalVar("toggle_" + statement.pop()!);
                        if (variable === condition) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "tisnot": {
                        //tisnot = toggle is not
                        const variable = readGlobalVar("toggle_" + statement.pop()!);
                        if (variable !== condition) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case ">": {
                        const condition2 = statement.pop()!;
                        if (parseFloat(condition2) > parseFloat(condition)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "<": {
                        const condition2 = statement.pop()!;
                        if (parseFloat(condition2) < parseFloat(condition)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case ">=": {
                        const condition2 = statement.pop()!;
                        if (parseFloat(condition2) >= parseFloat(condition)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    case "<=": {
                        const condition2 = statement.pop()!;
                        if (parseFloat(condition2) <= parseFloat(condition)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                    default: {
                        if (isTruthy(condition)) {
                            statement.push("1");
                        } else {
                            statement.push("0");
                        }
                        break;
                    }
                }
            }

            const finalCondition = statement[0];
            if (isTruthy(finalCondition)) {
                switch (mode) {
                    case "keep": {
                        return { type: "newif", type2: "keep" };
                    }
                    case "legacy": {
                        return { type: "parse" };
                    }
                    default: {
                        return { type: "newif" };
                    }
                }
            } else {
                switch (mode) {
                    case "keep": {
                        return { type: "newif-falsy", type2: "keep" };
                    }
                    case "legacy": {
                        return { type: "ignore" };
                    }
                    default: {
                        return { type: "newif-falsy" };
                    }
                }
            }
        } else {
            return { type: "newif-falsy" };
        }
    }
    if (p1 === "#pure") {
        return { type: "pure" };
    }
    if (p1 === "#pure_display" || p1 === "#puredisplay") {
        return { type: "pure-display" };
    }
    if (p1 === "#code") {
        return { type: "normalize" };
    }
    if (p1.startsWith("#escape")) {
        const t2 = p1.substring(7).trim();
        const mode = t2 === "::keep" ? "keep" : undefined;
        return { type: "escape", mode };
    }
    if (p1.startsWith("#each")) {
        let t2 = p1.substring(5).trim();
        let mode: string | undefined;
        if (t2.startsWith("::keep ")) {
            mode = "keep";
            t2 = t2.substring(7).trim();
        }
        if (t2.startsWith("as ")) {
            t2 = t2.substring(3).trim();
        }
        return { type: "each", type2: t2, mode };
    }
    if (p1.startsWith("#func")) {
        const statement = p1.split(" ");
        if (statement.length > 1) {
            return { type: "function", funcArg: statement.slice(1) };
        }
    }

    return { type: "nothing" };
}

function trimLines(p1: string) {
    return p1
        .split("\n")
        .map((v) => {
            return v.trimStart();
        })
        .join("\n")
        .trim();
}

function blockEndMatcher(
    p1: string,
    type: { type: blockMatch; type2?: string; mode?: string },
    matcherArg: matcherArg,
): string {
    const p1Trimmed = p1.trim();
    switch (type.type) {
        case "pure":
        case "pure-display":
        case "function": {
            return p1Trimmed;
        }
        case "parse": {
            return trimLines(p1Trimmed);
        }
        case "each": {
            if (type.mode === "keep") {
                return p1;
            }
            return trimLines(p1Trimmed);
        }
        case "ifpure": {
            return p1;
        }
        case "newif":
        case "newif-falsy": {
            const lines = p1.split("\n");

            if (lines.length === 1) {
                const elseIndex = p1.indexOf("{{:else}}");
                if (elseIndex !== -1) {
                    if (type.type === "newif") {
                        return p1.substring(0, elseIndex);
                    }
                    if (type.type === "newif-falsy") {
                        return p1.substring(elseIndex + 9);
                    }
                } else {
                    if (type.type === "newif") {
                        return p1;
                    }
                    if (type.type === "newif-falsy") {
                        return "";
                    }
                }
            }

            const elseLine = lines.findIndex((v) => {
                return v.trim() === "{{:else}}";
            });

            if (elseLine !== -1 && type.type === "newif") {
                lines.splice(elseLine); //else line and everything after it is removed
            }
            if (elseLine !== -1 && type.type === "newif-falsy") {
                lines.splice(0, elseLine + 1); //everything before else line is removed
            }
            if (elseLine === -1 && type.type === "newif-falsy") {
                return "";
            }

            if (type.type2 !== "keep") {
                // The blank lines at both ends go (by index: `shift` in a loop is quadratic).
                let start = 0;
                while (start < lines.length && lines[start].trim() === "") {
                    start++;
                }
                let end = lines.length;
                while (end > start && lines[end - 1].trim() === "") {
                    end--;
                }
                return lines.slice(start, end).join("\n");
            }
            return lines.join("\n");
        }

        case "normalize": {
            return p1Trimmed
                .trim()
                .replaceAll("\n", "")
                .replaceAll("\t", "")
                .replaceAll(/\\u([0-9A-Fa-f]{4})/g, (match, p1) => {
                    return String.fromCharCode(parseInt(p1, 16));
                })
                .replaceAll(/\\(.)/g, (match, p1) => {
                    switch (p1) {
                        case "n":
                            return "\n";
                        case "r":
                            return "\r";
                        case "t":
                            return "\t";
                        case "b":
                            return "\b";
                        case "f":
                            return "\f";
                        case "v":
                            return "\v";
                        case "a":
                            return "\a";
                        case "x":
                            return "\x00";
                        default:
                            return p1;
                    }
                });
        }
        case "escape": {
            return risuEscape(type.mode === "keep" ? p1 : p1Trimmed);
        }
        default: {
            return "";
        }
    }
}

/** A parse under the evaluator's budget, if it has one: nested parses share the outermost one's. */
function parse(ev: Evaluator, da: string, arg: CbsParseArg = {}): string {
    const budget = ev.budget;
    if (!budget) {
        return parseText(ev, da, arg, null);
    }
    enterCbsParse(budget);
    try {
        // Every character costs a unit, so a text longer than what is left cannot finish.
        if (da.length > budget.limits.maxWork - budget.work) {
            throw new CbsLimitError("work", budget.limits);
        }
        const result = parseText(ev, da, arg, budget);
        checkCbsClock(budget);
        // Whatever built it: a result is never longer than the work one parse may spend.
        if (result.length > budget.limits.maxWork) {
            throw new CbsLimitError("work", budget.limits);
        }
        return result;
    } finally {
        leaveCbsParse(budget);
    }
}

function parseText(ev: Evaluator, da: string, arg: CbsParseArg, budget: CbsBudget | null): string {
    const chatID = arg.chatID ?? -1;
    const db = arg.db ?? ev.host.getDatabase();
    const aChara = arg.chara;
    // The client starts it as `null`; `matcherArg.chara` is typed for the values it ends with.
    let chara = null as unknown as character | string;

    if (aChara) {
        if (typeof aChara !== "string" && aChara.type === "group") {
            const chatRef = arg.chatRef;
            const groupChat = chatRef
                ? aChara.chats.find((chat) => chat.id === chatRef.chatId)
                : aChara.chats[aChara.chatPage];
            if ((groupChat?.message.length ?? 0) > 0) {
                const gc = ev.host.findCharacterById(groupChat!.message.at(-1)!.saying ?? "");
                if (gc.name !== "Unknown Character") {
                    chara = gc;
                }
            } else {
                chara = "bot";
            }
        } else {
            chara = aChara;
        }
    }
    if (arg.tokenizeAccurate) {
        const db = arg.db ?? ev.host.getDatabase();
        const selchar = chara ?? db.characters[ev.host.getSelectedCharID()];
        if (!selchar) {
            chara = "bot";
        }
    }

    let pointer = 0;
    let nested: string[] = [""];
    let stackType = new Uint8Array(512);
    let pureModeNest: Map<number, boolean> = new Map();
    let pureModeNestType: Map<number, string> = new Map();
    let blockNestType: Map<
        number,
        {
            type: blockMatch;
            type2?: string;
            funcArg?: string[];
            mode?: string;
        }
    > = new Map();
    let commentMode = false;
    let commentLatest: string[] = [""];
    let commentV = new Uint8Array(512);
    let thinkingMode = false;
    let tempVar: { [key: string]: string } = {};
    let functions: Map<
        string,
        {
            data: string;
            arg: string[];
        }
    > = arg.functions ?? new Map();

    arg.callStack = (arg.callStack ?? 0) + 1;

    if (arg.callStack > 20) {
        return "ERROR: Call stack limit reached";
    }

    const matcherObj = {
        chatID: chatID,
        chara: chara,
        rmVar: arg.rmVar ?? false,
        db: db,
        var: arg.var ?? null,
        tokenizeAccurate: arg.tokenizeAccurate ?? false,
        displaying: arg.visualize ?? false,
        role: arg.role,
        runVar: arg.runVar ?? false,
        consistantChar: arg.consistantChar ?? false,
        cbsConditions: arg.cbsConditions ?? {},
        chatRef: arg.chatRef ?? null,
        callStack: arg.callStack,
        getNested: () => {
            return nested;
        },
        setNestedRoot: (val: string) => {
            nested[0] = val;
        },
    };

    da = da.replace(/\<(user|char|bot)\>/gi, "{{$1}}");

    const isPureMode = () => {
        return pureModeNest.size > 0;
    };

    while (pointer < da.length) {
        if (budget) {
            spendCbsWork(budget, 1);
        }
        switch (da[pointer]) {
            case "{": {
                if (da[pointer + 1] !== "{" && da[pointer + 1] !== "#") {
                    nested[0] += da[pointer];
                    break;
                }
                pointer++;
                nested.unshift("");
                stackType[nested.length] = 1;
                if (budget) {
                    // `unshift` moves the whole stack.
                    spendCbsWork(budget, nested.length >> 8);
                    checkCbsClock(budget);
                }
                break;
            }
            case "#": {
                //legacy if statement, deprecated
                if (da[pointer + 1] !== "}" || nested.length === 1 || stackType[nested.length] !== 1) {
                    nested[0] += da[pointer];
                    break;
                }
                pointer++;
                const dat = nested.shift()!;
                const mc = legacyBlockMatcher(dat, matcherObj);
                nested[0] += mc ?? `{#${dat}#}`;
                break;
            }
            case "}": {
                if (da[pointer + 1] !== "}" || nested.length === 1 || stackType[nested.length] !== 1) {
                    nested[0] += da[pointer];
                    break;
                }
                pointer++;
                const dat = nested.shift()!;
                if (budget) {
                    checkCbsClock(budget);
                }
                if (dat.startsWith("#") || dat.startsWith(":")) {
                    if (isPureMode()) {
                        nested[0] += `{{${dat}}}`;
                        if (dat !== ":else") {
                            nested.unshift("");
                            stackType[nested.length] = 6;
                        }
                        break;
                    }
                    const matchResult = blockStartMatcher(ev, dat, matcherObj);
                    if (matchResult.type === "nothing") {
                        nested[0] += `{{${dat}}}`;
                        break;
                    } else {
                        nested.unshift("");
                        stackType[nested.length] = 5;
                        blockNestType.set(nested.length, matchResult);
                        if (
                            matchResult.type === "ignore" ||
                            matchResult.type === "pure" ||
                            matchResult.type === "each" ||
                            matchResult.type === "function" ||
                            matchResult.type === "pure-display" ||
                            matchResult.type === "escape"
                        ) {
                            pureModeNest.set(nested.length, true);
                            pureModeNestType.set(nested.length, "block");
                        }
                        break;
                    }
                }
                if (dat.startsWith("/") && !dat.startsWith("//")) {
                    if (stackType[nested.length] === 5) {
                        const blockType = blockNestType.get(nested.length)!;
                        if (
                            blockType.type === "ignore" ||
                            blockType.type === "pure" ||
                            blockType.type === "each" ||
                            blockType.type === "function" ||
                            blockType.type === "pure-display" ||
                            blockType.type === "escape"
                        ) {
                            pureModeNest.delete(nested.length);
                            pureModeNestType.delete(nested.length);
                        }
                        blockNestType.delete(nested.length);
                        const dat2 = nested.shift()!;
                        const matchResult = blockEndMatcher(dat2, blockType, matcherObj);
                        if (blockType.type === "each") {
                            const asIndex = blockType.type2!.lastIndexOf(" as ");
                            let sub = blockType.type2!.substring(asIndex + 4).trim();
                            let array = parseArray(blockType.type2!.substring(0, asIndex));
                            if (asIndex === -1) {
                                //compability mode
                                const subind = blockType.type2!.lastIndexOf(" ");
                                if (subind === -1) {
                                    break;
                                }
                                sub = blockType.type2!.substring(subind + 1);
                                array = parseArray(blockType.type2!.substring(0, subind));
                            }
                            let added = "";
                            const slot = `{{slot::${sub}}}`;
                            for (let i = 0; i < array.length; i++) {
                                const value =
                                    typeof array[i] === "string" ? (array[i] as string) : JSON.stringify(array[i]);
                                if (budget) {
                                    // An element that is not a string or JSON makes the replacement "undefined".
                                    spendCbsWork(budget, 1 + replaceAllBound(matchResult, slot, String(value)));
                                }
                                added += matchResult.replaceAll(slot, value);
                            }
                            da =
                                da.substring(0, pointer + 1) +
                                (blockType.mode === "keep" ? added : added.trim()) +
                                da.substring(pointer + 1);
                            if (budget) {
                                // The splice makes the next read copy the whole text.
                                spendCbsWork(budget, da.length >> 7);
                                checkCbsClock(budget);
                            }
                            break;
                        }
                        if (blockType.type === "function") {
                            console.log(matchResult);
                            functions.set(blockType.funcArg![0], {
                                data: matchResult,
                                arg: blockType.funcArg!.slice(1),
                            });
                            break;
                        }
                        if (blockType.type === "pure-display") {
                            if (budget) {
                                // The escapes double the braces at most.
                                spendCbsWork(budget, matchResult.length);
                            }
                            nested[0] += matchResult.replaceAll("{{", "\\{\\{").replaceAll("}}", "\\}\\}");
                            break;
                        }
                        if (matchResult === "") {
                            break;
                        }
                        nested[0] += matchResult;
                        break;
                    }
                    if (stackType[nested.length] === 6) {
                        const sft = nested.shift()!;
                        nested[0] += sft + `{{${dat}}}`;
                        break;
                    }
                }
                if (dat.startsWith("call::")) {
                    if (arg.callStack && arg.callStack > 20) {
                        nested[0] += `ERROR: Call stack limit reached`;
                        break;
                    }
                    const argData = dat.split("::").slice(1);
                    const funcName = argData[0];
                    const func = functions.get(funcName);
                    console.log(func);
                    if (func) {
                        let data = func.data;
                        for (let i = 0; i < argData.length; i++) {
                            if (budget) {
                                spendCbsWork(budget, replaceAllBound(data, `{{arg::${i}}}`, argData[i]));
                            }
                            data = data.replaceAll(`{{arg::${i}}}`, argData[i]);
                        }
                        arg.functions = functions;
                        nested[0] += parse(ev, data, arg);
                        break;
                    }
                }
                const mc = isPureMode() ? null : matcher(ev, dat, matcherObj, tempVar);
                if (budget && mc) {
                    spendCbsWork(budget, typeof mc === "string" ? mc.length : (mc.text?.length ?? 0));
                    checkCbsClock(budget);
                }
                if (!mc && mc !== "") {
                    nested[0] += `{{${dat}}}`;
                } else if (typeof mc === "string") {
                    nested[0] += mc;
                } else {
                    nested[0] += mc.text;
                    tempVar = mc.var;
                    if (tempVar["__force_return__"]) {
                        return tempVar["__return__"] ?? "null";
                    }
                }
                break;
            }
            default: {
                nested[0] += da[pointer];
                break;
            }
        }
        pointer++;
    }
    if (commentMode) {
        nested = commentLatest;
        stackType = commentV;
        if (thinkingMode) {
            nested[0] += `<div>Thinking...</div>`;
        }
        commentMode = false;
    }
    if (nested.length === 1) {
        return nested[0];
    }
    let result = "";
    while (nested.length > 1) {
        if (budget) {
            // `shift` moves the whole stack.
            spendCbsWork(budget, 1 + (nested.length >> 8));
        }
        let dat = stackType[nested.length] === 1 ? "{{" : "<";
        dat += nested.shift();
        result = dat + result;
    }
    return nested[0] + result;
}
