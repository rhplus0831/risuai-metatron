import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openApp, repoRoot } from "../util/playwright/stack.mjs";

// Phase 5 slice 13 golden test (`docs/plan/phases/slices/phase-5-server-side-processing/script-transform.md`;
// `server/src/tests/fixtures/baseline/README.md`): the final browser HTML of `ParseMarkdown` and the
// `editprocess` text with the client flag `risu.serverTransform` on (the display and process
// transform on the server, both asset passes, inlays, Markdown, and sanitization in the browser)
// against `markdown.json`, which the browser path captured before slice 3, with and without plugin
// hooks. The fixture files are read, never written.
//
// The baseline's nondeterminism is reproduced where the browser evaluates it: the same seeded
// `Math.random` (re-seeded before every value), viewport, timezone, and locale. Two things cannot be:
// - CBS the server evaluates uses the server's random and clock, so `{{random}}`, `{{dice}}`,
//   `{{randint}}` (`m-m3`) and `{{date}}`, `{{time}}`, `{{unixtime}}` (`m-m4`) are compared by form
//   wherever the server expands them (`direct`, `back`, `editprocess`); the browser pre-pass
//   (`prePass`) expands them in the browser and is compared exactly.
// - The browser clock cannot be frozen as the capture froze it: the server refuses an auth token
//   whose expiry is in the past. `Date` is fixed only while the browser pre-pass runs (it is
//   synchronous), so `prePass` reads the captured time.
// The flag-off path of the current client is captured in the same run and compared too, so a
// difference is attributed to the server path or to the client since the capture.
//
// The README's "Not captured" items get independent cases below, flag on against flag off on the
// current client: a v2 `display` trigger, and additional assets (the first asset pass, and a regex
// output that the second pass turns into an asset). Inlays (they need stored inlay records) and
// dynamic assets (they need an embedding model) are not covered here.

const baselineDir = path.join(repoRoot, "server/src/tests/fixtures/baseline");
const scenario = JSON.parse(readFileSync(path.join(baselineDir, "scenario.json"), "utf8"));
const baseline = JSON.parse(readFileSync(path.join(baselineDir, "markdown.json"), "utf8"));
const env = scenario.environment;

test.use({ viewport: env.viewport, timezoneId: env.timezoneId, locale: env.locale });

/** The seeded `Math.random` of the capture (mulberry32), re-seeded by `window.__risuReseed()`. */
const seedScript = `(() => {
    const make = (seed) => {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };
    let rng = make(${Number(env.randomSeed)});
    Math.random = () => rng();
    window.__risuReseed = () => { rng = make(${Number(env.randomSeed)}); };
})();`;

async function boot(page: Page, baseURL: string, errors: string[], seeded: boolean) {
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    if (seeded) {
        await page.addInitScript(seedScript);
    }
    // No public service: everything not on this machine answers 500, as in the capture.
    await page.route(
        (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
        (route) => route.fulfill({ status: 500, body: "{}" }),
    );
    await openApp(page, baseURL);
}

/** Waits until the server holds a revision of the chat (it is saved, so the server path applies). */
async function waitSaved(page: Page, chaId: string, chatId: string) {
    await expect
        .poll(
            () =>
                page.evaluate(
                    async ({ chaId, chatId }) => {
                        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
                        return chatStore.heldChatRevision({ chaId, chatId });
                    },
                    { chaId, chatId },
                ),
            { timeout: 30_000 },
        )
        .not.toBeNull();
    await page.evaluate(async () => {
        const sync = await import("/src/ts/storage/resourceSync.svelte.ts");
        await sync.flushResources();
    });
}

/** The capture's markdown unit, on the flag-off or the flag-on path (`markdown.json`'s shape). */
const captureMarkdown = (page: Page, serverPath: boolean) =>
    page.evaluate(
        async ({ md, baseSettings, fixedTime, serverPath }) => {
            const stores = await import("/src/ts/stores.svelte.ts");
            const dbm = await import("/src/ts/storage/database.svelte.ts");
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            const parser = await import("/src/ts/parser/parser.svelte.ts");
            const scripts = await import("/src/ts/process/scripts.ts");
            const transform = await import("/src/ts/parser/transformClient.ts");
            const hooks = await import("/src/ts/plugins/pluginHooks.ts");
            const DBState = stores.DBState;
            const clone = (v: unknown) => JSON.parse(JSON.stringify(v));
            const w = window as any;
            if (serverPath) localStorage.setItem("risu.serverTransform", "1");
            else localStorage.removeItem("risu.serverTransform");
            dbm.changeToPreset(DBState.db.botPresets[0].id, true);
            for (const [key, value] of Object.entries(baseSettings)) {
                (DBState.db as any)[key] = clone(value);
            }
            const index = DBState.db.characters.findIndex((c: any) => c?.chaId === md.chaId);
            stores.selectedCharID.set(index);
            chatStore.selectChat(md.chaId, md.chatId);
            const ref = { chaId: md.chaId, chatId: md.chatId };
            const char = DBState.db.characters[index] as any;
            const chat = chatStore.findChat(ref)!;
            const RealDate = Date;
            const fixed = new RealDate(fixedTime).getTime();
            class FixedDate extends RealDate {
                constructor(...args: any[]) {
                    super(...((args.length ? args : [fixed]) as []));
                }
                static now() {
                    return fixed;
                }
            }
            const prePass = (data: string, idx: number, cbsConditions: object) => {
                (globalThis as any).Date = FixedDate;
                try {
                    return parser.risuChatParser(data, {
                        chara: char.name,
                        chatID: idx,
                        rmVar: true,
                        visualize: true,
                        cbsConditions,
                    });
                } finally {
                    (globalThis as any).Date = RealDate;
                }
            };
            const editprocess = async (data: string, cbsConditions: object) => {
                if (!serverPath) return await scripts.processScript(char, data, "editprocess", cbsConditions, ref);
                const captured = transform.captureTransform(-1);
                if (!captured) throw new Error("the server path does not apply");
                return (
                    await transform.serverProcessScript(
                        char,
                        data,
                        "editprocess",
                        -1,
                        cbsConditions,
                        captured,
                        "message",
                    )
                ).data;
            };
            const capture = async () => {
                const one = async (data: string, idx: number, cbsConditions: object) => {
                    const result: any = {};
                    w.__risuReseed();
                    result.direct = await parser.ParseMarkdown(data, char, "normal", idx, cbsConditions);
                    w.__risuReseed();
                    const prePassed = prePass(data, idx, cbsConditions);
                    result.prePass = {
                        text: prePassed,
                        html: await parser.ParseMarkdown(prePassed, char, "normal", idx, cbsConditions),
                    };
                    w.__risuReseed();
                    result.back = await parser.ParseMarkdown(data, char, "back", idx, cbsConditions);
                    w.__risuReseed();
                    result.editprocess = await editprocess(data, cbsConditions);
                    return result;
                };
                const out: any = { greeting: await one(char.firstMessage, -1, { firstmsg: true, chatRole: "char" }) };
                out.messages = {};
                for (let i = 0; i < chat.message.length; i++) {
                    const message = chat.message[i];
                    out.messages[message.chatId!] = await one(message.data, i, {
                        firstmsg: false,
                        chatRole: message.role,
                    });
                }
                return out;
            };
            const result: any = { withoutHooks: await capture() };
            const display = new Function("return " + md.hooks.editdisplay)();
            const process = new Function("return " + md.hooks.editprocess)();
            hooks.pluginHooks.editdisplay.add(display);
            hooks.pluginHooks.editprocess.add(process);
            try {
                result.withHooks = await capture();
            } finally {
                hooks.pluginHooks.editdisplay.delete(display);
                hooks.pluginHooks.editprocess.delete(process);
            }
            localStorage.removeItem("risu.serverTransform");
            return result;
        },
        { md: scenario.markdown, baseSettings: scenario.baseSettings, fixedTime: env.fixedTime, serverPath },
    );

/** Masks what the server's random and clock produce (they cannot be seeded or frozen). */
const RANDOM = /Random [0-9.e-]+ pick (alpha|beta|gamma) dice \d+ int \d+\./g;
const CLOCK = /Date \d{4}-\d{1,2}-\d{1,2} time \d{1,2}:\d{1,2}:\d{1,2} unix \d{10}/g;
const SERVER_EVALUATED = ["direct", "back", "editprocess"];

function masked(capture: any): any {
    const copy = JSON.parse(JSON.stringify(capture));
    for (const variant of ["withoutHooks", "withHooks"]) {
        for (const id of ["m-m3", "m-m4"]) {
            const entry = copy[variant].messages[id];
            for (const field of SERVER_EVALUATED) {
                entry[field] = entry[field]
                    .replace(RANDOM, "Random <R> pick <P> dice <D> int <I>.")
                    .replace(CLOCK, "Date <D> time <T> unix <U>");
            }
        }
    }
    return copy;
}

/**
 * The page errors, less the one the baseline README lists as known (`DefaultChatScreen.svelte` reads
 * `alternateGreetings.length` of a character without them while the selection moves).
 */
const unexpected = (errors: string[]) =>
    errors.filter((error) => !/reading 'length'\)[\s\S]*DefaultChatScreen\.svelte/.test(error));

/** Every leaf that differs, as `path: expected → actual`. */
function differences(expected: any, actual: any, at = ""): string[] {
    if (typeof expected !== "object" || expected === null) {
        return expected === actual ? [] : [`${at}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`];
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual ?? {})]);
    return [...keys].flatMap((key) => differences(expected[key], actual?.[key], at ? `${at}.${key}` : key));
}

test("the server transform reproduces markdown.json (final HTML and editprocess text, with and without plugin hooks)", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    await boot(page, baseURL!, errors, true);
    // The capture's seed step, from scenario.json.
    await page.evaluate(
        async (s) => {
            const { DBState } = await import("/src/ts/stores.svelte.ts");
            const presets = await import("/shared/presets.ts");
            const characterStore = await import("/src/ts/storage/characterStore.svelte.ts");
            const clone = (v: unknown) => JSON.parse(JSON.stringify(v));
            const db = DBState.db as any;
            db.didFirstSetup = true;
            db.useLegacyGUI = true;
            for (const preset of s.presets) db.botPresets.push(presets.normalizePreset(clone(preset)));
            db.personas = clone(s.personas);
            for (const [key, value] of Object.entries(s.baseSettings)) db[key] = clone(value);
            for (const character of s.characters) {
                if (!db.characters.some((c: any) => c?.chaId === character.chaId)) {
                    characterStore.addCharacter(clone(character));
                }
            }
        },
        {
            presets: scenario.presets,
            personas: scenario.personas,
            baseSettings: scenario.baseSettings,
            characters: scenario.characters,
        },
    );
    await waitSaved(page, scenario.markdown.chaId, scenario.markdown.chatId);

    const transformPosts: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/transform")) {
            transformPosts.push(new URL(request.url()).pathname);
        }
    });

    const browserPath = await captureMarkdown(page, false);
    expect(transformPosts, "the flag-off path makes no transform request").toEqual([]);
    const serverPath = await captureMarkdown(page, true);
    expect(transformPosts).toContain("/api/transform");
    expect(transformPosts, "the hooks made the second call").toContain("/api/transform/continue");

    // The flag-off path of today's client still equals the capture (m-m4's clock masked: the
    // browser clock flows here), so the baseline is a valid oracle for this client.
    const clockOnly = (capture: any) => {
        const copy = JSON.parse(JSON.stringify(capture));
        for (const variant of ["withoutHooks", "withHooks"]) {
            const entry = copy[variant].messages["m-m4"];
            for (const field of SERVER_EVALUATED) {
                entry[field] = entry[field].replace(CLOCK, "Date <D> time <T> unix <U>");
            }
        }
        return copy;
    };
    expect(differences(clockOnly(baseline), clockOnly(browserPath))).toEqual([]);

    // The server path: equal to the capture, the server-evaluated random and clock by form.
    for (const variant of ["withoutHooks", "withHooks"]) {
        for (const id of ["m-m3", "m-m4"]) {
            for (const field of SERVER_EVALUATED) {
                const value: string = serverPath[variant].messages[id][field];
                expect(
                    value.match(id === "m-m3" ? RANDOM : CLOCK),
                    `${variant}.${id}.${field}: ${value}`,
                ).not.toBeNull();
            }
        }
    }
    expect(differences(masked(baseline), masked(serverPath))).toEqual([]);
    expect(unexpected(errors)).toEqual([]);
});

test("a display trigger and additional assets render the same on the server path as on the browser path", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    // No seeded random here: nothing below depends on it.
    await boot(page, baseURL!, errors, false);
    const chaId = "char-golden-extra";
    const chatId = "chat-golden-extra";
    await page.evaluate(
        async ({ chaId, chatId }) => {
            const { DBState } = await import("/src/ts/stores.svelte.ts");
            const characterStore = await import("/src/ts/storage/characterStore.svelte.ts");
            const { saveAsset } = await import("/src/ts/globalApi.svelte.ts");
            const db = DBState.db as any;
            db.didFirstSetup = true;
            if (db.characters.some((c: any) => c?.chaId === chaId)) return;
            // Two stored 1x1 PNGs.
            const png = Uint8Array.from(
                atob(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                ),
                (c) => c.charCodeAt(0),
            );
            const pic1 = await saveAsset(png, "golden-pic-1", "golden-pic-1.png");
            const pic2 = await saveAsset(png, "golden-pic-2", "golden-pic-2.png");
            characterStore.addCharacter({
                type: "character",
                chaId,
                name: "Extra",
                desc: "",
                personality: "",
                scenario: "",
                firstMessage: "Greeting TRIG",
                alternateGreetings: [],
                exampleMessage: "",
                systemPrompt: "",
                replaceGlobalNote: "",
                notes: "",
                globalLore: [],
                additionalAssets: [
                    ["pic1", pic1, "png"],
                    ["pic2", pic2, "png"],
                ],
                emotionImages: [],
                bias: [],
                viewScreen: "none",
                utilityBot: false,
                chatPage: 0,
                chatFolders: [],
                customscript: [
                    { comment: "pic", in: "SHOWPIC", out: "{{img::pic2}}", type: "editdisplay", flag: "g" },
                    { comment: "em", in: "\\*(.+?)\\*", out: "<em>$1</em>", type: "editdisplay", flag: "g" },
                ],
                triggerscript: [
                    {
                        comment: "display",
                        type: "display",
                        conditions: [],
                        effect: [
                            { type: "v2GetDisplayState", indent: 0, outputVar: "d" },
                            {
                                type: "v2ConcatString",
                                indent: 0,
                                source1Type: "var",
                                source1: "d",
                                source2Type: "value",
                                source2: " [trigger *appended*]",
                                outputVar: "d",
                            },
                            { type: "v2SetDisplayState", indent: 0, valueType: "var", value: "d" },
                        ],
                    },
                ],
                chats: [
                    {
                        id: chatId,
                        name: "Chat 1",
                        note: "",
                        localLore: [],
                        message: [
                            { role: "user", data: "First {{img::pic1}} then SHOWPIC.", chatId: "x-1", time: 1 },
                            { role: "char", data: "The TRIG fires, and *this* is emphasized.", chatId: "x-2", time: 2 },
                        ],
                    },
                ],
            });
        },
        { chaId, chatId },
    );
    await waitSaved(page, chaId, chatId);

    // `getFileSrc` answers a path once per page in this stack and waits forever on a second read of
    // it (its service-worker check fails and the path stays "loading": a browser-path defect outside
    // this slice), so each path renders in a fresh page and reads each asset once.
    const render = async (serverPath: boolean) => {
        await page.reload();
        await openApp(page, baseURL!);
        return await page.evaluate(
            async ({ chaId, chatId, serverPath }) => {
                const stores = await import("/src/ts/stores.svelte.ts");
                const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
                const parser = await import("/src/ts/parser/parser.svelte.ts");
                if (serverPath) localStorage.setItem("risu.serverTransform", "1");
                else localStorage.removeItem("risu.serverTransform");
                const index = stores.DBState.db.characters.findIndex((c: any) => c?.chaId === chaId);
                stores.selectedCharID.set(index);
                chatStore.selectChat(chaId, chatId);
                const char = stores.DBState.db.characters[index] as any;
                const chat = chatStore.findChat({ chaId, chatId })!;
                const out: Record<string, string> = {};
                const texts: [string, string, number, object][] = [
                    ["greeting", char.firstMessage, -1, { firstmsg: true, chatRole: "char" }],
                    ...chat.message.map(
                        (m: any, i: number) => [m.chatId, m.data, i, { firstmsg: false, chatRole: m.role }] as any,
                    ),
                ];
                for (const [id, data, idx, cbs] of texts) {
                    parser.resetAssetsCache(char.additionalAssets, char.emotionImages, []);
                    out[id] = await parser.ParseMarkdown(data, char, "normal", idx, cbs);
                    if (!data.includes("img::") && !data.includes("SHOWPIC")) {
                        out[`${id}:back`] = await parser.ParseMarkdown(data, char, "back", idx, cbs);
                    }
                }
                localStorage.removeItem("risu.serverTransform");
                return out;
            },
            { chaId, chatId, serverPath },
        );
    };

    const transformPosts: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/transform") {
            transformPosts.push(request.postData() ?? "");
        }
    });
    const browserPath = await render(false);
    expect(transformPosts).toEqual([]);
    const serverPath = await render(true);
    expect(transformPosts.length).toBeGreaterThan(0);

    // The trigger appended its text before the regex scripts (the `em` script ran on it), on every
    // message and the greeting.
    expect(browserPath["x-2"]).toContain("[trigger <em>appended</em>");
    expect(browserPath["x-2:back"]).toContain("[trigger <em>appended</em>");
    expect(browserPath["greeting"]).toContain("[trigger <em>appended</em>");
    // Both asset passes ran: the message's own asset (first pass) and the regex output (second pass).
    expect(browserPath["x-1"].match(/<img /g)).toHaveLength(2);
    expect(browserPath["x-1"]).not.toContain("{{img::");
    expect(differences(browserPath, serverPath)).toEqual([]);
    expect(unexpected(errors)).toEqual([]);
});
