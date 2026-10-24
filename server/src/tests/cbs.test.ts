// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCbsEvaluator } from "../../../shared/cbs/evaluator.ts";
import type { CbsParseArg } from "../../../shared/cbs/evaluator.ts";
import type { Chat, Database, character, groupChat, loreBook } from "../../../shared/database.ts";
import { runRegexScripts } from "../../../shared/scripts/regex.ts";
import { createNodeCbsEvaluator, createNodeCbsHost } from "./cbsHost.ts";

/**
 * The shared CBS evaluator under plain Node: the browser-path baseline
 * (`fixtures/baseline/markdown.json`, captured from the client before the extraction) and the
 * host-parity cases (`fixtures/cbs-parity.json`, which the client wrapper also answers in
 * `src/ts/parser/tests/cbs/hostParity.test.ts`) must come out the same from a Node host.
 */
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
const scenario = readJson("baseline/scenario.json");
const markdown = readJson("baseline/markdown.json");
const parity = readJson("cbs-parity.json");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const previousTz = process.env.TZ;

beforeAll(() => {
    // The baseline was captured with `timezoneId: "UTC"`; the date functions use the runtime's zone.
    process.env.TZ = "UTC";
    expect(new Date(scenario.environment.fixedTime).getHours()).toBe(12);
});

afterAll(() => {
    if (previousTz === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = previousTz;
    }
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the browser-path baseline (markdown.json) from a Node host", () => {
    const md = scenario.markdown as { chaId: string; chatId: string };
    let db: Database;
    let mark: character;
    let parse: (text: string, arg?: CbsParseArg) => string;
    const chatRef = { chaId: md.chaId, chatId: md.chatId };

    beforeEach(() => {
        vi.useFakeTimers({ now: new Date(scenario.environment.fixedTime), toFake: ["Date"] });
        vi.spyOn(console, "log").mockImplementation(() => {});
        db = {
            ...clone(scenario.baseSettings),
            personas: clone(scenario.personas),
            characters: clone(scenario.characters),
            globalChatVariables: {},
            templateDefaultVariables: "",
            enabledModules: [],
            modules: [],
        } as unknown as Database;
        const selectedCharID = db.characters.findIndex((entry) => entry.chaId === md.chaId);
        mark = db.characters[selectedCharID] as character;
        parse = createNodeCbsEvaluator(db, {
            selectedCharID,
            viewport: scenario.environment.viewport,
            browserLanguage: scenario.environment.locale,
        }).risuChatParser;
    });

    /** `processScript(char, data, "editprocess", cbsConditions, ref)` without its Lua and plugin hooks. */
    const editprocess = (data: string, cbsConditions: { firstmsg: boolean; chatRole: string }) => {
        const run = (text: string) => parse(text, { chatID: -1, cbsConditions, chatRef });
        const scripts = (db.presetRegex ?? []).concat(mark.customscript);
        return runRegexScripts(run(data), scripts, {
            mode: "editprocess",
            chatID: -1,
            parse: run,
            repeatBackSource: () => "",
        }).data;
    };

    /** The `Chat.svelte` pre-pass parse the capture recorded as `prePass.text`. */
    const prePass = (data: string, chatID: number, cbsConditions: { firstmsg: boolean; chatRole: string }) =>
        parse(data, { chara: mark.name, chatID, rmVar: true, visualize: true, cbsConditions });

    const fixture = markdown.withoutHooks as {
        greeting: { prePass: { text: string }; editprocess: string };
        messages: Record<string, { prePass: { text: string }; editprocess: string }>;
    };
    const chat = () => mark.chats[0];
    /** `m-m3` is `{{random}}`/`{{dice}}`/`{{randint}}` under the capture's seeded PRNG: its shape only. */
    const RANDOM_MESSAGE = "m-m3";

    it("answers the greeting as the client did", () => {
        const conditions = { firstmsg: true, chatRole: "char" };
        expect(editprocess(mark.firstMessage, conditions)).toBe(fixture.greeting.editprocess);
        expect(prePass(mark.firstMessage, -1, conditions)).toBe(fixture.greeting.prePass.text);
    });

    it("answers every deterministic message of the Mark chat as the client did", () => {
        const messages = chat().message;
        expect(messages.map((message) => message.chatId)).toEqual(Object.keys(fixture.messages));
        for (const [index, message] of messages.entries()) {
            if (message.chatId === RANDOM_MESSAGE) {
                continue;
            }
            const conditions = { firstmsg: false, chatRole: message.role };
            const expected = fixture.messages[message.chatId!];
            expect(editprocess(message.data, conditions), `${message.chatId} editprocess`).toBe(expected.editprocess);
            expect(prePass(message.data, index, conditions), `${message.chatId} prePass`).toBe(expected.prePass.text);
        }
    });

    it("answers the random message with the client's shape", () => {
        const index = chat().message.findIndex((message) => message.chatId === RANDOM_MESSAGE);
        const message = chat().message[index];
        const shape = /^Random 0\.\d+ pick (alpha|beta|gamma) dice \d+ int \d+\.$/;
        expect(fixture.messages[RANDOM_MESSAGE].editprocess).toMatch(shape);
        expect(editprocess(message.data, { firstmsg: false, chatRole: message.role })).toMatch(shape);
        expect(prePass(message.data, index, { firstmsg: false, chatRole: message.role })).toMatch(shape);
    });

    it("reads the viewport, the browser language, and the fixed clock through the host", () => {
        // The one message that depends on every new host callback and on the clock.
        const message = chat().message.find((entry) => entry.chatId === "m-m4")!;
        expect(editprocess(message.data, { firstmsg: false, chatRole: "char" })).toBe(
            "Date 2026-10-1 time 12:0:0 unix 1790856000 screen 1280x720 lang en-US ui en.",
        );
    });
});

describe("host parity (cbs-parity.json) from a Node host", () => {
    type ParityCase = {
        name: string;
        input: string;
        expected: string;
        triggerId?: string;
        arg?: {
            chatID?: number;
            chatRef?: { chaId: string; chatId: string };
            charaId?: string;
            chara?: string;
            rmVar?: boolean;
            consistantChar?: boolean;
        };
    };
    let db: Database;
    let triggerId: string | null = null;
    let parse: (text: string, arg?: CbsParseArg) => string;

    beforeEach(() => {
        vi.useFakeTimers({ now: new Date(parity.fixedTime), toFake: ["Date"] });
        vi.spyOn(console, "log").mockImplementation(() => {});
        db = clone(parity.database) as Database;
        triggerId = null;
        parse = createNodeCbsEvaluator(db, {
            selectedCharID: parity.selectedCharID,
            viewport: parity.viewport,
            browserLanguage: parity.browserLanguage,
            triggerId: () => triggerId,
        }).risuChatParser;
    });

    const resolveArg = (entry: ParityCase): CbsParseArg => {
        const { charaId, ...rest } = entry.arg ?? {};
        const arg: CbsParseArg = { ...rest };
        if (charaId) {
            arg.chara = db.characters.find((candidate) => candidate.chaId === charaId) as character | groupChat;
        }
        return arg;
    };

    for (const entry of parity.cases as ParityCase[]) {
        it(entry.name, () => {
            triggerId = entry.triggerId ?? null;
            expect(parse(entry.input, resolveArg(entry))).toBe(entry.expected);
        });
    }
});

describe("evaluators", () => {
    it("lorebook and worldinfo merge the chat's owner overrides before local and module lore", () => {
        const entry = (id: string, content: string): loreBook => ({
            id,
            key: id,
            secondkey: "",
            comment: id,
            content,
            insertorder: 100,
            mode: "normal",
            alwaysActive: false,
            selective: false,
        });
        const original = entry("replaced", "owner content");
        const disabled = entry("disabled", "hidden owner content");
        const untouched = entry("untouched", "unchanged owner content");
        const replacement = { ...original, comment: "chat comment", content: "chat content", key: "chat key" };
        const local = entry("local", "local content");
        const module = entry("module", "module content");
        const db = clone(parity.database) as Database;
        const owner = db.characters[0] as character;
        owner.globalLore = [original, disabled, untouched];
        const chat = owner.chats[0] as Chat;
        chat.localLore = [local];
        chat.loreOverrides = [
            { entry: entry("orphan", "orphan content"), off: false },
            { entry: { ...disabled, content: "hidden chat content" }, off: true },
            { entry: replacement, off: false },
        ];
        const { risuChatParser } = createCbsEvaluator({
            ...createNodeCbsHost(db, { selectedCharID: 0 }),
            getModuleLorebooks: () => [module],
        });
        const chatRef = { chaId: owner.chaId, chatId: chat.id! };

        for (const name of ["lorebook", "worldinfo"]) {
            expect(JSON.parse(risuChatParser(`{{${name}}}`, { chara: owner, chatRef }))).toEqual(
                [replacement, untouched, local, module].map((book) => JSON.stringify(book)),
            );
        }
    });

    it("are independent: each evaluator answers its own host", () => {
        const db = clone(parity.database) as Database;
        const wide = createCbsEvaluator(
            createNodeCbsHost(db, { selectedCharID: 0, viewport: { width: 1920, height: 1080 } }),
        );
        const narrow = createCbsEvaluator(
            createNodeCbsHost(db, { selectedCharID: 1, viewport: { width: 390, height: 844 }, triggerId: () => "t" }),
        );
        expect(narrow.risuChatParser("{{screenwidth}} {{char}} {{trigger_id}}")).toBe("390 Other t");
        expect(wide.risuChatParser("{{screenwidth}} {{char}} {{trigger_id}}")).toBe("1920 Sel null");
        expect(narrow.risuChatParser("{{screenheight}}")).toBe("844");
    });

    it("turn a throwing host callback into the literal text", () => {
        const db = clone(parity.database) as Database;
        const evaluator = createCbsEvaluator({
            ...createNodeCbsHost(db, { selectedCharID: 0 }),
            getViewport: () => {
                throw new Error("no viewport here");
            },
        });
        expect(evaluator.risuChatParser("a {{screenwidth}} b {{char}}")).toBe("a {{screenwidth}} b Sel");
    });
});
