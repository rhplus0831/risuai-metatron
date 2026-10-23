// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Message, loreBook } from "../../../shared/database.ts";
import {
    activateLore,
    type LoreActivation,
    type LoreActivationInput,
    type LoreHost,
} from "../../../shared/lore/activation.ts";
import type { RegexOpResult } from "../scripts/worker.ts";
import { createScriptWorkerPool } from "../scripts/workerPool.ts";
import { UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

/**
 * The shared lore activation (`shared/lore/activation.ts`) under plain Node, with
 * a host of plain functions: activation order and the result shape, the scan depth, plain and
 * regex keys (the fixed `/pattern/flags` grammar and its inherited traps), secondary keys, the
 * decorators, recursion, the token budget, the keep and don't-activate flags through the host, a
 * frozen input, and the scheduling: a synchronous `testRegex` never yields, an asynchronous one
 * (the server's script worker, a timeout included) answers "no match" on failure. The browser
 * baseline (`fixtures/baseline/lore-regex.json` with the reviewed `deltas/lore-regex-fix.json`)
 * and the `lore` prompt delta (`deltas/lore-regex-fix-prompts.json`) are reproduced from here.
 */
const FIXTURES = path.join(import.meta.dirname, "fixtures/baseline");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const lore = (comment: string, key: string, content: string, extra: Partial<loreBook> = {}): loreBook => ({
    key,
    secondkey: "",
    insertorder: 100,
    comment,
    content,
    mode: "normal",
    alwaysActive: false,
    selective: false,
    ...extra,
});
const regex = (comment: string, key: string, content = comment, extra: Partial<loreBook> = {}) =>
    lore(comment, key, content, { useRegex: true, ...extra });
const user = (data: string, extra: Partial<Message> = {}): Message => ({ role: "user", data, ...extra });
const char = (data: string, extra: Partial<Message> = {}): Message => ({ role: "char", data, ...extra });

function makeChat(message: Message[], extra: Partial<Chat> = {}): Chat {
    return { id: "chat", name: "Chat", note: "", localLore: [], message, fmIndex: -1, ...extra };
}

function makeInput(
    entries: loreBook[],
    messages: Message[],
    over: Partial<LoreActivationInput> & { loreSettings?: Record<string, unknown>; chat?: Chat } = {},
): LoreActivationInput {
    const { loreSettings, chat, ...rest } = over;
    return {
        character: { name: "Bot", globalLore: entries, loreSettings: loreSettings as never },
        chat: chat ?? makeChat(messages),
        moduleLorebooks: [],
        loreBookDepth: 10,
        loreBookToken: 10_000,
        userName: "User",
        ...rest,
    };
}

/** A host of plain functions: tokens are the text's length, a regex is `RegExp.test`. */
function makeHost(over: Partial<LoreHost> = {}): LoreHost & { vars: Map<string, string> } {
    const vars = new Map<string, string>();
    return {
        vars,
        clone: structuredClone,
        findCharacterName: () => undefined,
        getChatVar: (key) => vars.get(key) ?? "null",
        setChatVar: (key, value) => void vars.set(key, value),
        pickHashRand: (cid, word) => cid + word.length,
        parseCBS: (text) => text,
        tokenize: async (text) => text.length,
        testRegex: (pattern, flags, text) => new RegExp(pattern, flags).test(text),
        ...over,
    };
}

const sources = (result: LoreActivation) => result.actives.map((active) => active.source);

async function run(entries: loreBook[], messages: Message[], host = makeHost(), over = {}) {
    return activateLore(makeInput(entries, messages, over), host);
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("activation and the result", () => {
    it("activates the entries whose key the scanned messages contain, case-insensitively, ignoring spaces", async () => {
        const result = await run(
            [
                lore("dragon", "Dragon", "A dragon."),
                lore("castle", "cas tle", "A castle."),
                lore("ocean", "ocean", "No."),
            ],
            [user("Tell me about the DRAGON and the castle.")],
        );
        expect(sources(result)).toEqual(["castle", "dragon"]);
        // A plain-key match logs the lower-cased prompt (the regex branch keeps the case).
        expect(result.matchLog).toEqual([
            {
                prompt: "\x01{{user}}:tell me about the dragon and the castle.\x01",
                source: "message 0 by user",
                activated: "Dragon",
            },
            {
                prompt: "\x01{{user}}:tell me about the dragon and the castle.\x01",
                source: "message 0 by user",
                activated: "cas tle",
            },
        ]);
        expect(result.actives[1]).toEqual({
            depth: 0,
            pos: "",
            prompt: "A dragon.",
            role: "system",
            order: 100,
            tokens: "A dragon.".length,
            priority: 100,
            source: "dragon",
            inject: null,
        });
    });

    it("orders the actives by insertorder ascending, then by lore order reversed within one insertorder", async () => {
        const result = await run(
            [
                lore("a", "x", "a", { insertorder: 100 }),
                lore("b", "x", "b", { insertorder: 300 }),
                lore("c", "x", "c", { insertorder: 100 }),
                lore("d", "x", "d", { insertorder: 50 }),
            ],
            [user("x")],
        );
        expect(sources(result)).toEqual(["d", "c", "a", "b"]);
    });

    it("merges the character's lore, the chat's local lore, and the module lore, in that order, over a clone", async () => {
        const entries = [lore("global", "x", "g")];
        const chat = makeChat([user("x")], { localLore: [lore("local", "x", "l")] });
        const cloned: unknown[] = [];
        const clone = <T>(value: T): T => {
            cloned.push(value);
            return structuredClone(value);
        };
        const result = await activateLore(
            makeInput(entries, [], { chat, moduleLorebooks: [lore("module", "x", "m")] }),
            makeHost({ clone }),
        );
        expect(sources(result)).toEqual(["module", "local", "global"]);
        expect(cloned).toHaveLength(1);
        expect(cloned[0]).toHaveLength(3);
    });

    it("names an entry without a comment by its index in the merged lore, and skips entries without a key", async () => {
        const result = await run(
            [lore("", "x", "first"), lore("", "", "no key"), lore("", "", "always", { alwaysActive: true })],
            [user("x")],
        );
        expect(sources(result)).toEqual(["lorebook 2", "lorebook 0"]);
    });

    it("names the user by the input's user name and a character message by its name, the speaker, or the character", async () => {
        const host = makeHost({ findCharacterName: (id) => (id === "m1" ? "Member" : undefined) });
        const result = await activateLore(
            makeInput(
                [lore("e", "x", "e", { insertorder: 1 })],
                [
                    user("x"),
                    char("x", { name: "Named" }),
                    char("x", { saying: "m1" }),
                    char("x", { saying: "unknown" }),
                    char("x"),
                ],
                { userName: "Mina", loreSettings: { recursiveScanning: false } },
            ),
            host,
        );
        expect(result.matchLog.map((row) => row.prompt)).toEqual(["\x01{{mina}}:x\x01"]);
        // The first match ends the search; the other rows are what the other messages would log.
        const all = await activateLore(
            makeInput(
                [regex("a", "/x/"), regex("b", "/y/"), regex("c", "/z/"), regex("d", "/w/")],
                [user("x"), char("y", { name: "Named" }), char("z", { saying: "m1" }), char("w")],
                { userName: "Mina", loreSettings: { recursiveScanning: false } },
            ),
            host,
        );
        expect(all.matchLog.map((row) => [row.source, row.prompt])).toEqual([
            ["message 0 by user", "\x01{{Mina}}:x\x01"],
            ["message 1 by char", "\x01{{Named}}:y\x01"],
            ["message 2 by char", "\x01{{Member}}:z\x01"],
            ["message 3 by char", "\x01{{Bot}}:w\x01"],
        ]);
    });

    it("drops {{// }} and {{comment: }} from the scanned text for plain keys", async () => {
        const result = await run([lore("hidden", "secret", "h")], [user("{{// secret}} and {{comment: secret}} only")]);
        expect(sources(result)).toEqual([]);
    });
});

describe("the scan depth", () => {
    const entries = [lore("old", "old", "o"), lore("new", "new", "n")];
    const messages = [user("old"), char("middle"), user("new")];

    it("scans the last loreBookDepth messages", async () => {
        expect(sources(await run(entries, messages, makeHost(), { loreBookDepth: 1 }))).toEqual(["new"]);
        expect(sources(await run(entries, messages, makeHost(), { loreBookDepth: 3 }))).toEqual(["new", "old"]);
    });

    it("the character's loreSettings.scanDepth overrides the setting, and @@scan_depth the entry's", async () => {
        expect(
            sources(await run(entries, messages, makeHost(), { loreBookDepth: 10, loreSettings: { scanDepth: 1 } })),
        ).toEqual(["new"]);
        const deep = [lore("old", "old", "@@scan_depth 3\no"), lore("new", "new", "n")];
        expect(sources(await run(deep, messages, makeHost(), { loreBookDepth: 1 }))).toEqual(["new", "old"]);
    });
});

describe("regex keys", () => {
    // A probe table over the text `abc a/b aa`: the grammar after the fix (the last `/` ends
    // the pattern; empty flags are allowed; the key is never rewritten) and the inherited traps
    // (keys split on every comma; a malformed key ends its query; a non-`/` key ends the search).
    const text = "abc a/b aa";
    const cases: [key: string, activated: string | null, why: string][] = [
        ["/", null, "no closing slash"],
        ["/abc", null, "no closing slash"],
        ["//", "//", "an empty pattern matches anything"],
        ["/abc/", "/abc/", "empty flags"],
        ["/a/b/", "/a/b/", "a slash inside the pattern"],
        ["/abc/z", null, "invalid flags"],
        ["/miss/,/abc/", "/abc/", "a later valid key matches, and is the one logged"],
        ["/abc/z,/abc/", null, "an invalid first key ends the query (inherited)"],
        ["/,/abc/", null, "a malformed first key ends the query (inherited)"],
        ["/a{1,2}/", null, "the comma splits the quantifier into two keys (inherited)"],
        ["/a\\/b/", "/a\\/b/", "an escaped slash in the pattern"],
        ["/ABC/i", "/ABC/i", "the i flag"],
        ["/ABC/", null, "no flag: case-sensitive"],
        ["/abc/ii", null, "duplicate flags are invalid"],
        ["/abc/gi", "/abc/gi", "several flags"],
        ["abc", null, "a non-slash key in a regex entry ends the search (inherited)"],
        [" /abc/ ", "/abc/", "keys are trimmed"],
    ];
    it.each(cases)("%s logs %s (%s)", async (key, activated) => {
        const result = await run([regex("rx", key)], [user(text)]);
        expect(sources(result)).toEqual(activated ? ["rx"] : []);
        if (activated) {
            // The regex branch logs the prompt as written (no lower-casing) and the matching key.
            expect(result.matchLog).toEqual([
                { prompt: `\x01{{User}}:${text}\x01`, source: "message 0 by user", activated },
            ]);
        } else {
            expect(result.matchLog).toEqual([]);
        }
    });

    it("tests every scanned message with the unrewritten key (a match in the second message)", async () => {
        const result = await run([regex("rx", "/dragon/i")], [user("Hello there."), char("Take the /dragon path.")]);
        expect(sources(result)).toEqual(["rx"]);
        expect(result.matchLog).toEqual([
            { prompt: "\x01{{Bot}}:Take the /dragon path.\x01", source: "message 1 by char", activated: "/dragon/i" },
        ]);
    });

    it("does not rewrite the lore it was given", async () => {
        const entries = [regex("rx", "/dragon/i")];
        const input = makeInput(entries, [user("a"), user("a dragon")]);
        await activateLore(input, makeHost());
        expect(entries[0].key).toBe("/dragon/i");
        expect(input.character.globalLore?.[0].key).toBe("/dragon/i");
    });

    it("an invalid pattern matches nothing and does not throw", async () => {
        const result = await run([regex("bad", "/(dragon/"), lore("plain", "dragon", "p")], [user("a dragon")]);
        expect(sources(result)).toEqual(["plain"]);
    });

    it("regex secondary keys: a selective entry needs both lists to match", async () => {
        const entries = [regex("both", "/river/", "b", { selective: true, secondkey: "/boat/i" })];
        expect(sources(await run(entries, [user("the river and a BOAT")]))).toEqual(["both"]);
        expect(sources(await run(entries, [user("the river alone")]))).toEqual([]);
        expect(sources(await run(entries, [user("a boat alone")]))).toEqual([]);
    });

    it("the regex branch answers at the first match regardless of the all-keys mode (inherited)", async () => {
        // `@@exclude_keys_all` asks for every key; a regex entry is excluded by one matching key.
        const result = await run([regex("rx", "/abc/", "@@exclude_keys_all /zzz/,/abc/\nr")], [user("abc")]);
        expect(sources(result)).toEqual([]);
    });

    it("@@additional_keys with regex keys run through the same grammar", async () => {
        const entries = [regex("rx", "/abc/", "@@additional_keys /def/i\nr")];
        expect(sources(await run(entries, [user("abc DEF")]))).toEqual(["rx"]);
        expect(sources(await run(entries, [user("abc")]))).toEqual([]);
    });
});

describe("plain keys", () => {
    it("secondary keys: a selective entry needs one key of each list", async () => {
        const entries = [lore("both", "river", "b", { selective: true, secondkey: "boat, ship" })];
        expect(sources(await run(entries, [user("the river and a ship")]))).toEqual(["both"]);
        expect(sources(await run(entries, [user("the river alone")]))).toEqual([]);
        // Without `selective` the secondary keys are ignored.
        const notSelective = [lore("one", "river", "o", { secondkey: "boat" })];
        expect(sources(await run(notSelective, [user("the river alone")]))).toEqual(["one"]);
    });

    it("full-word matching (the character's setting or @@match_full_word) matches whole words only", async () => {
        const entries = [lore("cast", "cast", "c")];
        expect(sources(await run(entries, [user("the castle")]))).toEqual(["cast"]);
        expect(
            sources(await run(entries, [user("the castle")], makeHost(), { loreSettings: { fullWordMatching: true } })),
        ).toEqual([]);
        expect(
            sources(await run(entries, [user("the cast")], makeHost(), { loreSettings: { fullWordMatching: true } })),
        ).toEqual(["cast"]);
        const decorated = [
            lore("cast", "cast", "@@match_full_word\nc"),
            lore("partial", "cast", "@@match_partial_word\np"),
        ];
        expect(
            sources(
                await run(decorated, [user("the castle")], makeHost(), { loreSettings: { fullWordMatching: true } }),
            ),
        ).toEqual(["partial"]);
    });

    it("@@exclude_keys deactivates on any excluded key, @@exclude_keys_all only when every one is present", async () => {
        // Decorator arguments are comma-separated (`@risuai/ccardlib`).
        const some = [lore("some", "x", "@@exclude_keys a, b\ns")];
        const all = [lore("all", "x", "@@exclude_keys_all a, b\na")];
        expect(sources(await run([...some, ...all], [user("x a")]))).toEqual(["all"]);
        expect(sources(await run([...some, ...all], [user("x a b")]))).toEqual([]);
        expect(sources(await run([...some, ...all], [user("x")]))).toEqual(["all", "some"]);
    });
});

describe("the decorators", () => {
    it("position, depth, role, and end set the active's placement", async () => {
        const result = await run(
            [
                lore("pos", "x", "@@position pt_custom\np", { insertorder: 1 }),
                lore("depth", "x", "@@depth 2\n@@role user\nd", { insertorder: 2 }),
                lore("reverse", "x", "@@reverse_depth 1\nr", { insertorder: 3 }),
                lore("end", "x", "@@end\n@@role assistant\ne", { insertorder: 4 }),
                lore("badpos", "x", "@@position nowhere\n@@role nobody\nb", { insertorder: 5 }),
            ],
            [user("x")],
        );
        expect(result.actives.map((a) => [a.source, a.pos, a.depth, a.role, a.prompt])).toEqual([
            ["pos", "pt_custom", 0, "system", "p"],
            ["depth", "depth", 2, "user", "d"],
            ["reverse", "reverse_depth", 1, "system", "r"],
            ["end", "depth", 0, "assistant", "e"],
            // A decorator with an unknown value is ignored; the parser strips its line anyway.
            ["badpos", "", 0, "system", "b"],
        ]);
    });

    it("activate_only_after, activate_only_every, and is_greeting gate on the chat length and the greeting", async () => {
        const entries = [
            lore("after3", "x", "@@activate_only_after 3\na"),
            lore("every2", "x", "@@activate_only_every 2\ne"),
            lore("greet0", "x", "@@is_greeting 0\ng"),
            lore("greet2", "x", "@@is_greeting 2\ng2"),
        ];
        // One message: the chat length counts the first message too (2). `is_greeting n` compares
        // `n` with `fmIndex + 1` (the first message is -1, so 0; an alternate greeting k is k + 1).
        expect(sources(await run(entries, [user("x")]))).toEqual(["greet0", "every2"]);
        expect(sources(await run(entries, [user("x"), user("x")]))).toEqual(["greet0", "after3"]);
        const chat = makeChat([user("x")], { fmIndex: 1 });
        expect(sources(await activateLore(makeInput(entries, [], { chat }), makeHost()))).toEqual(["greet2", "every2"]);
    });

    it("activate and dont_activate force the state without a search; alwaysActive skips the search too", async () => {
        const result = await run(
            [
                lore("forced", "missing", "@@activate\nf"),
                lore("blocked", "x", "@@dont_activate\nb"),
                lore("always", "missing", "a", { alwaysActive: true }),
            ],
            [user("x")],
        );
        expect(sources(result)).toEqual(["always", "forced"]);
    });

    it("@@probability uses Math.random", async () => {
        const entries = [lore("maybe", "x", "@@probability 40\nm")];
        vi.spyOn(Math, "random").mockReturnValue(0.39);
        expect(sources(await run(entries, [user("x")]))).toEqual(["maybe"]);
        vi.spyOn(Math, "random").mockReturnValue(0.41);
        expect(sources(await run(entries, [user("x")]))).toEqual([]);
    });

    it("strips every decorator line from the prompt, the unknown and malformed ones included, and applies the known ones", async () => {
        const result = await run(
            [lore("e", "x", "@@unknown_thing 1\n@@depth notanumber\n@@role user\nbody")],
            [user("x")],
        );
        expect(result.actives[0]).toMatchObject({ prompt: "body", role: "user", depth: 0, pos: "" });
    });

    it("writes after-match flags only for the entries carrying each decorator", async () => {
        const host = makeHost();
        // Processing follows this array; insertorder keeps the same order in the prompt.
        const result = await run(
            [
                lore("keep", "x", "@@keep_activate_after_match\nk", { id: "keep-id", insertorder: 1 }),
                lore("plain", "x", "p", { id: "plain-id", insertorder: 2 }),
                lore("dont", "x", "@@dont_activate_after_match\nd", { id: "dont-id", insertorder: 3 }),
            ],
            [user("x")],
            host,
        );
        expect(sources(result)).toEqual(["keep", "plain", "dont"]);
        expect([...host.vars.entries()]).toEqual([
            ["__internal_ka_keep-id", "true"],
            ["__internal_da_dont-id", "true"],
        ]);
    });

    it("the keep and don't-activate-after-match flags read and write the host's chat variables", async () => {
        const host = makeHost();
        const keep = lore("keep", "x", "@@keep_activate_after_match\nk", { id: "keep-id" });
        const dont = lore("dont", "x", "@@dont_activate_after_match\nd");
        // First run: both match and both flags are written (the one without an id by pickHashRand).
        expect(sources(await run([keep, dont], [user("x")], host))).toEqual(["dont", "keep"]);
        const dontHash = host.pickHashRand(5555, dont.content).toString();
        // Each entry writes only its own flag: `dont` gets no `__internal_ka_` from the keep entry.
        expect([...host.vars.entries()]).toEqual([
            ["__internal_ka_keep-id", "true"],
            ["__internal_da_" + dontHash, "true"],
        ]);
        // Second run without the key: the kept entry still activates, the other never again.
        expect(sources(await run([keep, dont], [user("nothing")], host))).toEqual(["keep"]);
        expect(sources(await run([keep, dont], [user("x")], host))).toEqual(["keep"]);
    });

    it("ignore_on_max_context and priority order the budget, not the prompt", async () => {
        const result = await run(
            [
                lore("low", "x", "@@ignore_on_max_context\n" + "l".repeat(5)),
                lore("high", "x", "@@priority 9\n" + "h".repeat(5)),
                lore("mid", "x", "m".repeat(5)),
            ],
            [user("x")],
            makeHost(),
            { loreBookToken: 10 },
        );
        // The budget takes `mid` (100) then `high` (9) and drops `low` (-1000); the result is then
        // ordered by insertorder (equal) and reversed.
        expect(result.actives.map((a) => [a.source, a.priority, a.tokens])).toEqual([
            ["high", 9, 5],
            ["mid", 100, 5],
        ]);
    });
});

describe("the token budget", () => {
    it("counts the CBS-expanded content and keeps the raw prompt", async () => {
        const host = makeHost({ parseCBS: (text) => text.replaceAll("{{x}}", "expanded value") });
        const result = await run([lore("e", "k", "{{x}}")], [user("k")], host);
        expect(result.actives[0]).toMatchObject({ prompt: "{{x}}", tokens: "expanded value".length });
    });

    it("drops the entries the budget cannot hold, by priority descending, then restores the order", async () => {
        const result = await run(
            [
                lore("a", "x", "aaaa", { insertorder: 1 }),
                lore("b", "x", "bbbbbbbb", { insertorder: 2 }),
                lore("c", "x", "cccc", { insertorder: 3 }),
            ],
            [user("x")],
            makeHost(),
            { loreBookToken: 9 },
        );
        // Equal priorities: the budget takes them in lore order (a: 4, b: 8 > 9, c: 4).
        expect(sources(result)).toEqual(["a", "c"]);
        const budgeted = await run([lore("a", "x", "aaaa"), lore("b", "x", "bbbbbbbb")], [user("x")], makeHost(), {
            loreSettings: { tokenBudget: 8 },
        });
        expect(sources(budgeted)).toEqual(["a"]);
    });
});

describe("recursion", () => {
    const entries = [
        lore("first", "x", "the hill"),
        lore("second", "hill", "the valley"),
        lore("third", "valley", "end"),
    ];

    it("scans activated entries' content for further keys by default, logging the lorebook source", async () => {
        const result = await run(entries, [user("x")]);
        expect(sources(result)).toEqual(["third", "second", "first"]);
        expect(result.matchLog.map((row) => [row.source, row.activated])).toEqual([
            ["message 0 by user", "x"],
            ["lorebook first", "hill"],
            ["lorebook second", "valley"],
        ]);
    });

    it("the character's recursiveScanning turns it off; @@recursive and @@unrecursive override per entry", async () => {
        expect(
            sources(await run(entries, [user("x")], makeHost(), { loreSettings: { recursiveScanning: false } })),
        ).toEqual(["first"]);
        const forced = [lore("first", "x", "@@recursive\nthe hill"), ...entries.slice(1)];
        expect(
            sources(await run(forced, [user("x")], makeHost(), { loreSettings: { recursiveScanning: false } })),
        ).toEqual(["second", "first"]);
        const stopped = [lore("first", "x", "@@unrecursive\nthe hill"), ...entries.slice(1)];
        expect(sources(await run(stopped, [user("x")]))).toEqual(["first"]);
    });

    it("@@no_recursive_search keeps an entry from matching the recursive prompts", async () => {
        const guarded = [entries[0], lore("second", "hill", "@@no_recursive_search\nthe valley"), entries[2]];
        expect(sources(await run(guarded, [user("x")]))).toEqual(["first"]);
    });

    it("a child entry activates with its parent's content when the parent did not activate itself", async () => {
        const result = await run(
            [
                lore("parent", "missing", "parent text", { id: "p" }),
                // An entry needs a key (or alwaysActive) to be considered at all, a child included.
                lore("child", "missing", "", { id: "p", mode: "child" }),
            ],
            [user("x")],
        );
        expect(result.actives.map((a) => [a.source, a.prompt])).toEqual([["parent", "parent text"]]);
    });
});

describe("@@inject_lore", () => {
    it("appends, prepends, or replaces into the active named by its comment and leaves the prompt list", async () => {
        const result = await run(
            [
                lore("target", "x", "base text"),
                lore("append", "x", "@@inject_lore target\nappended"),
                lore("prepend", "x", "@@inject_lore target\n@@inject_prepend\nprepended"),
                lore("replace", "x", "@@inject_lore target\n@@inject_replace text\nreplaced"),
                lore("missing", "x", "@@inject_lore nowhere\nlost"),
            ],
            [user("x")],
        );
        expect(result.actives.map((a) => [a.source, a.prompt])).toEqual([
            ["target", "prepended base replaced appended"],
        ]);
    });

    it("@@inject_at carries the location for the prompt builder without consuming the active", async () => {
        const result = await run([lore("main", "x", "@@inject_at main\n@@inject_prepend\ninto main")], [user("x")]);
        expect(result.actives[0]).toMatchObject({
            prompt: "into main",
            inject: { operation: "prepend", location: "main", param: "", lore: false },
        });
    });
});

describe("the input", () => {
    it("is read only: a deeply frozen input activates, and the state writes go to the host", async () => {
        const freeze = <T>(value: T): T => {
            if (value && typeof value === "object") {
                Object.freeze(value);
                for (const inner of Object.values(value as object)) {
                    freeze(inner);
                }
            }
            return value;
        };
        const host = makeHost();
        const input = freeze(
            makeInput(
                [
                    lore("keep", "x", "@@keep_activate_after_match\nk", { id: "k" }),
                    lore("child", "", "", { id: "k", mode: "child" }),
                ],
                [user("x")],
            ),
        );
        const result = await activateLore(input, host);
        expect(sources(result)).toEqual(["keep"]);
        expect([...host.vars.entries()]).toEqual([["__internal_ka_k", "true"]]);
    });
});

describe("scheduling", () => {
    it("a synchronous host never yields before the first active's token count: a queued change is not seen", async () => {
        const messages = [user("nothing")];
        const input = makeInput(
            [lore("missing", "missing", "m"), regex("rx", "/nope/"), lore("dragon", "dragon", "d")],
            messages,
        );
        queueMicrotask(() => {
            messages[0].data = "dragon";
        });
        expect(sources(await activateLore(input, makeHost()))).toEqual([]);
        // The write landed after the search: a second activation sees it.
        expect(sources(await activateLore(input, makeHost()))).toEqual(["dragon"]);
    });

    it("yields only at tokenize: CBS and the chat variables of an active are read before the first await", async () => {
        const host = makeHost();
        host.vars.set("x", "one");
        const parsed: string[] = [];
        host.parseCBS = (text) => {
            const expanded = text.replaceAll("{{x}}", host.vars.get("x") ?? "null");
            parsed.push(expanded);
            return expanded;
        };
        queueMicrotask(() => host.vars.set("x", "two"));
        const result = await run(
            [lore("alpha", "alpha", "A {{x}}"), lore("beta", "beta", "B {{x}}")],
            [user("alpha beta")],
            host,
        );
        // The first active's expansion read "one" synchronously; the second ran after the first
        // tokenize yielded (where the client yielded before the move too).
        expect(parsed).toEqual(["A one", "B two"]);
        expect(result.actives.map((a) => [a.source, a.prompt, a.tokens])).toEqual([
            ["beta", "B {{x}}", "B two".length],
            ["alpha", "A {{x}}", "A one".length],
        ]);
    });

    it("an asynchronous regex test is awaited (the server's worker), so a queued change is seen after it", async () => {
        const messages = [user("nothing")];
        const input = makeInput([regex("rx", "/nope/"), lore("dragon", "dragon", "d")], messages);
        queueMicrotask(() => {
            messages[0].data = "dragon";
        });
        const host = makeHost({ testRegex: async (pattern, flags, text) => new RegExp(pattern, flags).test(text) });
        expect(sources(await activateLore(input, host))).toEqual(["dragon"]);
    });

    it("an asynchronous host answers matches and treats a rejection as no match, continuing with the next entry", async () => {
        const calls: string[] = [];
        const host = makeHost({
            testRegex: async (pattern, flags, text) => {
                calls.push(pattern);
                if (pattern === "boom") {
                    throw new Error("Regex timed out");
                }
                return new RegExp(pattern, flags).test(text);
            },
        });
        const result = await run(
            [
                regex("fails", "/boom/"),
                regex("rx", "/dragon/i"),
                lore("plain", "dragon", "p"),
                regex("second", "/miss/,/DRAGON/i"),
            ],
            [user("a dragon")],
            host,
            { loreSettings: { recursiveScanning: false } },
        );
        expect(sources(result)).toEqual(["second", "plain", "rx"]);
        expect(calls).toEqual(["boom", "dragon", "miss", "DRAGON"]);
        expect(result.matchLog.map((row) => row.activated)).toEqual(["/dragon/i", "dragon", "/DRAGON/i"]);
    });

    it("a rejection in a later message's test is no match too, after a miss in the first", async () => {
        let count = 0;
        const host = makeHost({
            testRegex: async () => {
                count++;
                if (count === 2) {
                    throw new Error("worker gone");
                }
                return false;
            },
        });
        const result = await run([regex("rx", "/x/"), lore("plain", "b", "p")], [user("a"), user("b")], host, {
            loreSettings: { recursiveScanning: false },
        });
        expect(sources(result)).toEqual(["plain"]);
        expect(count).toBe(2);
    });
});

describe("with the script worker pool as the regex host", () => {
    // Booted once; a regex gets ten minutes unless a test names its own deadline.
    const pool = createScriptWorkerPool({
        rootDir: REPO_ROOT,
        size: 1,
        maxSize: 1,
        bootMs: UNHURRIED_SCRIPT_WORKERS.bootMs,
        regexDeadlineMs: UNHURRIED_SCRIPT_WORKERS.regexDeadlineMs,
    });
    beforeAll(() => pool.warm(), 60_000);
    afterAll(() => pool.dispose());

    /** `deadlineFor`: a pattern's own deadline (none: the pool's). */
    const host = (deadlineFor: (pattern: string) => number | undefined = () => undefined) =>
        makeHost({
            testRegex: async (pattern, flags, text) => {
                const answer = await pool.regex(
                    { op: "test", pattern, flags, input: text },
                    { deadlineMs: deadlineFor(pattern) },
                );
                if ("error" in answer) {
                    throw new Error(answer.error);
                }
                return answer.value as boolean;
            },
        });

    it("matches through the worker, including flags and an escaped slash", async () => {
        const result = await run([regex("rx", "/DRAGON/i"), regex("slash", "/a\\/b/")], [user("a/b dragon")], host());
        expect(sources(result)).toEqual(["slash", "rx"]);
    });

    // A real deadline, and a replacement worker's boot: the gate covers a rejected test as no match
    // with a fake host ("an asynchronous host answers matches and treats a rejection as no match").
    it(
        "a worker timeout during activation is no match for that entry; the others still activate and the pool recovers",
        { tags: ["slow"], timeout: 60_000 },
        async () => {
            const redos = "a".repeat(40) + "b";
            const answers: RegexOpResult[] = [];
            const recording = makeHost({
                testRegex: async (pattern, flags, text) => {
                    const answer = await pool.regex(
                        { op: "test", pattern, flags, input: text },
                        { deadlineMs: pattern === "(a+)+$" ? 200 : undefined },
                    );
                    answers.push(answer);
                    if ("error" in answer) {
                        throw new Error(answer.error);
                    }
                    return answer.value as boolean;
                },
            });
            const terminated = pool.stats().terminated;
            const result = await run(
                [regex("runaway", "/(a+)+$/"), lore("plain", "b", "p"), regex("sane", "/b$/")],
                [user(redos)],
                recording,
            );
            expect(sources(result)).toEqual(["sane", "plain"]);
            // The runaway's deadline killed its worker (once per scan: the recursive scan tests it
            // again); the sane pattern ran on the replacement.
            const timeouts = answers.filter((answer) => "error" in answer);
            expect(answers[0]).toEqual({ error: "Regex timed out", timedOut: true });
            expect(
                timeouts.every((answer) => "error" in answer && answer.error === "Regex timed out" && answer.timedOut),
            ).toEqual(true);
            expect(answers.filter((answer) => "value" in answer)).toEqual([{ value: true }]);
            expect(pool.stats().terminated).toBe(terminated + timeouts.length);
            expect(await pool.regex({ op: "test", pattern: "b$", flags: "", input: "ab" })).toEqual({ value: true });
        },
    );

    it("an invalid pattern is the worker's error, so no match, without ending the activation", async () => {
        const result = await run([regex("bad", "/(dragon/"), lore("plain", "dragon", "p")], [user("a dragon")], host());
        expect(sources(result)).toEqual(["plain"]);
    });
});

describe("the browser baseline", () => {
    type Captured = {
        actives: { source: string; prompt: string; pos: string; depth: number; role: string }[];
        matchLog: { prompt: string; source: string; activated: string }[];
    };
    const scenario = readJson("scenario.json");
    const captured = readJson("lore-regex.json") as Record<string, Captured>;
    const delta = readJson("deltas/lore-regex-fix.json") as { scenarios: Record<string, Captured> };
    const promptsDelta = readJson("deltas/lore-regex-fix-prompts.json") as {
        fixtures: {
            lore: {
                insertAt: number;
                inserted: { role: string; content: string }[];
                formated: { role: string; content: string }[];
            };
        };
    };
    const prompts = readJson("prompts.json") as Record<string, { formated: { role: string; content: string }[] }>;
    const regexCharacter = scenario.characters.find((c: { chaId: string }) => c.chaId === scenario.loreRegex.chaId);

    it("reproduces every lore-regex scenario from a Node host: the delta where it has an entry, the capture elsewhere", async () => {
        expect(Object.keys(delta.scenarios)).toEqual([
            "i-flag-plain-text",
            "empty-flags-plain-text",
            "i-flag-two-messages-match-second",
        ]);
        for (const s of scenario.loreRegex.scenarios as { name: string; chatId: string; lore: loreBook[] }[]) {
            const chat = regexCharacter.chats.find((c: { id: string }) => c.id === s.chatId);
            const result = await activateLore(
                {
                    character: {
                        name: regexCharacter.name,
                        globalLore: s.lore,
                        loreSettings: regexCharacter.loreSettings,
                    },
                    chat,
                    moduleLorebooks: [],
                    loreBookDepth: scenario.baseSettings.loreBookDepth ?? 5,
                    loreBookToken: scenario.baseSettings.loreBookToken ?? 800,
                    userName: "User",
                },
                makeHost(),
            );
            const expected = delta.scenarios[s.name] ?? captured[s.name];
            expect({
                name: s.name,
                actives: result.actives.map((a) => ({
                    source: a.source,
                    prompt: a.prompt,
                    pos: a.pos,
                    depth: a.depth,
                    role: a.role,
                })),
                matchLog: result.matchLog,
            }).toEqual({ name: s.name, actives: expected.actives, matchLog: expected.matchLog });
        }
    });

    it("the lore fixture's two regex entries activate on its chat, which is the prompts delta", async () => {
        const loremaster = scenario.characters.find((c: { name: string }) => c.name === "Loremaster");
        const chat = loremaster.chats[0];
        const result = await activateLore(
            {
                character: {
                    name: loremaster.name,
                    globalLore: loremaster.globalLore,
                    loreSettings: loremaster.loreSettings,
                },
                chat,
                moduleLorebooks: [],
                loreBookDepth: scenario.baseSettings.loreBookDepth ?? 5,
                loreBookToken: scenario.baseSettings.loreBookToken ?? 800,
                userName: "User",
            },
            makeHost(),
        );
        const { insertAt, inserted, formated } = promptsDelta.fixtures.lore;
        expect(inserted).toEqual([
            { role: "system", content: "Regex entry with empty flags." },
            { role: "system", content: "Regex entry with the i flag." },
        ]);
        expect(result.matchLog.filter((row) => row.activated.startsWith("/"))).toEqual([
            { prompt: `\x01{{User}}:${chat.message[0].data}\x01`, source: "message 0 by user", activated: "/dragon/i" },
            { prompt: `\x01{{User}}:${chat.message[0].data}\x01`, source: "message 0 by user", activated: "/dragon/" },
        ]);
        // The two actives are adjacent, in the delta's order, with no placement decorator.
        const regexActives = result.actives.filter((a) => a.prompt.startsWith("Regex entry"));
        expect(regexActives.map((a) => [a.prompt, a.pos, a.depth, a.role, a.inject])).toEqual(
            inserted.map((m) => [m.content, "", 0, "system", null]),
        );
        expect(result.actives.indexOf(regexActives[1]) - result.actives.indexOf(regexActives[0])).toBe(1);
        // The delta is the capture with exactly those two messages inserted at `insertAt`.
        const before = prompts.lore.formated;
        expect(formated).toEqual([...before.slice(0, insertAt), ...inserted, ...before.slice(insertAt)]);
        expect(before.some((m) => m.content.startsWith("Regex entry"))).toBe(false);
    });
});
