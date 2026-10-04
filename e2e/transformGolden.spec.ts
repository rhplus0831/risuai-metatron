import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openApp, repoRoot } from "../util/playwright/stack.mjs";

// Phase 5 slice 13 golden test (`docs/plan/phases/slices/phase-5-server-side-processing/script-transform.md`;
// `server/src/tests/fixtures/baseline/README.md`): the final browser HTML of `ParseMarkdown` and the
// `editprocess` text (the display and process transform on the server, the only script path since the
// Phase 5 cutover; both asset passes, inlays, Markdown, and sanitization in the browser) against
// `markdown.json`, which the browser path captured before slice 3, with and without plugin hooks.
// The fixture files are read, never written.
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
// Until the cutover the browser path of the current client was captured in the same run and held to
// `markdown.json` too; it is gone, so the capture is the only oracle.
//
// The README's "Not captured" items get independent cases below: a v2 `display` trigger, and
// additional assets (the first asset pass, and a regex output that the second pass turns into an
// asset), against `fixtures/transform/display-trigger-assets.json`, which the browser path recorded
// at 219dfb51 (before the cutover; its `capturedFrom` gives the provenance). Inlays (they need stored
// inlay records) and dynamic assets (they need an embedding model) are not covered here.

const baselineDir = path.join(repoRoot, "server/src/tests/fixtures/baseline");
const scenario = JSON.parse(readFileSync(path.join(baselineDir, "scenario.json"), "utf8"));
const baseline = JSON.parse(readFileSync(path.join(baselineDir, "markdown.json"), "utf8"));
const extra = JSON.parse(
    readFileSync(path.join(repoRoot, "server/src/tests/fixtures/transform/display-trigger-assets.json"), "utf8"),
);
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

/** The capture's markdown unit on the server path (`markdown.json`'s shape). */
const captureMarkdown = (page: Page) =>
    page.evaluate(
        async ({ md, baseSettings, fixedTime }) => {
            const stores = await import("/src/ts/stores.svelte.ts");
            const dbm = await import("/src/ts/storage/database.svelte.ts");
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            const parser = await import("/src/ts/parser/parser.svelte.ts");
            const transform = await import("/src/ts/parser/transformClient.ts");
            const hooks = await import("/src/ts/plugins/pluginHooks.ts");
            const DBState = stores.DBState;
            const clone = (v: unknown) => JSON.parse(JSON.stringify(v));
            const w = window as any;
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
            return result;
        },
        { md: scenario.markdown, baseSettings: scenario.baseSettings, fixedTime: env.fixedTime },
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

    const serverPath = await captureMarkdown(page);
    expect(transformPosts).toContain("/api/transform");
    expect(transformPosts, "the hooks made the second call").toContain("/api/transform/continue");

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

/**
 * The extra scenario's character (a display trigger, the editdisplay scripts `pic` and `em`, the
 * additional assets pic1 and pic2 stored under `assets/<id>.png`), saved. `pic1Size` (a square's
 * side) stores a noise PNG of about that side squared times four bytes as pic1, else a 1x1 PNG.
 */
async function seedExtra(
    page: Page,
    { chaId, chatId, pics, pic1Size }: { chaId: string; chatId: string; pics: [string, string]; pic1Size?: number },
) {
    const stored = await page.evaluate(
        async ({ chaId, chatId, pics, pic1Size }) => {
            const { DBState } = await import("/src/ts/stores.svelte.ts");
            const characterStore = await import("/src/ts/storage/characterStore.svelte.ts");
            const { saveAsset } = await import("/src/ts/globalApi.svelte.ts");
            const db = DBState.db as any;
            db.didFirstSetup = true;
            // Stored 1x1 PNGs, or for pic1 a noise PNG that does not compress.
            const png = Uint8Array.from(
                atob(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                ),
                (c) => c.charCodeAt(0),
            );
            let first = png;
            if (pic1Size) {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = pic1Size;
                const context = canvas.getContext("2d")!;
                const pixels = context.createImageData(pic1Size, pic1Size);
                // Random bytes in the most `getRandomValues` fills at once; opaque.
                for (let i = 0; i < pixels.data.length; i += 65536) {
                    crypto.getRandomValues(pixels.data.subarray(i, Math.min(pixels.data.length, i + 65536)));
                }
                for (let i = 3; i < pixels.data.length; i += 4) {
                    pixels.data[i] = 255;
                }
                context.putImageData(pixels, 0, 0);
                const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
                first = new Uint8Array(await blob.arrayBuffer());
            }
            const pic1 = await saveAsset(first, pics[0], `${pics[0]}.png`);
            const pic2 = await saveAsset(png, pics[1], `${pics[1]}.png`);
            if (db.characters.some((c: any) => c?.chaId === chaId)) return { pic1, pic2, pic1Bytes: first.length };
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
            return { pic1, pic2, pic1Bytes: first.length };
        },
        { chaId, chatId, pics, pic1Size },
    );
    await waitSaved(page, chaId, chatId);
    return stored;
}

/** The extra scenario's render in the current page (`extra.cases`'s shape). */
const renderExtra = (page: Page, chaId: string, chatId: string) =>
    page.evaluate(
        async ({ chaId, chatId }) => {
            const stores = await import("/src/ts/stores.svelte.ts");
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            const parser = await import("/src/ts/parser/parser.svelte.ts");
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
            return out;
        },
        { chaId, chatId },
    );

/** The `/sw/img/` URL the recording holds for a stored path. */
const swUrl = (path: string) => `/sw/img/${Buffer.from(path, "utf-8").toString("hex")}`;

test("a display trigger and additional assets render on the server path as the browser path recorded them", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    // No seeded random here: nothing below depends on it.
    await boot(page, baseURL!, errors, false);
    const chaId = "char-golden-extra";
    const chatId = "chat-golden-extra";
    await seedExtra(page, { chaId, chatId, pics: ["golden-pic-1", "golden-pic-2"] });

    // The recording holds the service worker's URLs, so the render runs in a page the worker
    // controls: reloaded (the worker does not control the page that registered it, its first load;
    // that render is the next test's).
    await page.reload();
    await openApp(page, baseURL!);
    const transformPosts: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/transform") {
            transformPosts.push(request.postData() ?? "");
        }
    });
    const serverPath = await renderExtra(page, chaId, chatId);
    expect(transformPosts.length).toBeGreaterThan(0);

    // The recorded browser path: the trigger appended its text before the regex scripts (the `em`
    // script ran on it), on every message and the greeting, and both asset passes ran (the message's
    // own asset, first pass, and the regex output, second pass).
    const recorded = extra.cases;
    expect(recorded["x-2"]).toContain("[trigger <em>appended</em>");
    expect(recorded["x-2:back"]).toContain("[trigger <em>appended</em>");
    expect(recorded["greeting"]).toContain("[trigger <em>appended</em>");
    expect(recorded["x-1"].match(/<img /g)).toHaveLength(2);
    expect(recorded["x-1"]).not.toContain("{{img::");
    // The server path renders the same.
    expect(differences(recorded, serverPath)).toEqual([]);
    expect(unexpected(errors)).toEqual([]);
});

test("on a page's first load the same render holds object URLs, a large image included, and is otherwise the recording", async ({
    page,
    baseURL,
}) => {
    // The Stop B fix (Phase 6): on a first load `getFileSrc` answered `undefined` (and a later read
    // of the path never settled). Its fallback is an object URL, not a data URL: the first asset
    // pass runs before the text goes to the server transform, and a data URL of a large image
    // (twice in the markup: `src` and `alt`) would pass the transform's text limit, so the display
    // trigger and the scripts would not run.
    const errors: string[] = [];
    await boot(page, baseURL!, errors, false);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    const chaId = "char-golden-first-load";
    const chatId = "chat-golden-first-load";
    const { pic1, pic2, pic1Bytes } = await seedExtra(page, {
        chaId,
        chatId,
        pics: ["golden-first-load-1", "golden-first-load-2"],
        pic1Size: 320,
    });
    expect(pic1Bytes).toBeGreaterThan(256 * 1024);

    const transformPosts: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/transform") {
            transformPosts.push(request.postData() ?? "");
        }
    });
    const firstLoad = await renderExtra(page, chaId, chatId);
    expect(transformPosts.length).toBeGreaterThan(0);
    // The message with the large image went to the server transform: its display trigger ran.
    expect(firstLoad["x-1"].includes("[trigger <em>appended</em>"), firstLoad["x-1"].slice(0, 300)).toBe(true);
    expect(Math.max(...transformPosts.map((body) => body.length))).toBeLessThan(64 * 1024);
    // A later read of each path answers the URL the render used: an object URL that displays.
    const sources = await page.evaluate(
        async (paths) => {
            const { getFileSrc } = await import("/src/ts/globalApi.svelte.ts");
            const out: { src: string; width: number }[] = [];
            for (const path of paths) {
                const src = await getFileSrc(path);
                const image = new Image();
                image.src = src;
                await image.decode().catch(() => {});
                out.push({ src, width: image.naturalWidth });
            }
            return out;
        },
        [pic1, pic2],
    );
    expect(sources.map(({ src }) => src.startsWith("blob:"))).toEqual([true, true]);
    expect(sources.map(({ width }) => width)).toEqual([320, 1]);
    expect(firstLoad["x-1"]).toContain(`src="${sources[0].src}"`);
    expect(firstLoad["x-1"]).toContain(`src="${sources[1].src}"`);

    // With the object URLs in place of the recording's worker URLs, the render is the recording.
    const asRecorded: Record<string, string> = {};
    for (const [id, html] of Object.entries(firstLoad)) {
        asRecorded[id] = html
            .replaceAll(sources[0].src, swUrl("assets/golden-pic-1.png"))
            .replaceAll(sources[1].src, swUrl("assets/golden-pic-2.png"));
    }
    expect(differences(extra.cases, asRecorded)).toEqual([]);
    expect(unexpected(errors)).toEqual([]);
});
