import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import {
    REALM_CANCEL_PATH,
    REALM_COMMIT_PATH,
    REALM_DOWNLOAD_FAILED,
    REALM_IMPORT_EXPIRED,
    REALM_IMPORT_PATH,
    REALM_TOO_MANY_STAGED,
} from "../../shared/realmImport.ts";
import { cardV2, cardV3 } from "./storage/tests/importFixtures";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

/**
 * `downloadRisuHub` over the real records with the server's Realm import answered by the test (the
 * prepare, commit, and cancel routes intercepted on the fake server's `fetch`): the tab sends the id
 * only, never fetches Realm itself, reads the prepared card and asks its questions (an rcc card's
 * password, the `lowLevelAccess` confirmation) before it commits, cancels a card that fails or is
 * declined so the server stores nothing, builds the character from the committed keys (CharX: the
 * module's fields merged, the asset keys as stored; PNG: the stored image key without a `saveAsset`,
 * an off-spec card converted; legacy JSON: the hub import with its portrait through `/hub-proxy`),
 * counts the import once for a binary answer, and alerts each failure once with the Realm texts.
 */

const { server, alerts } = vi.hoisted(() => {
    const alerts = {
        current: null as null | { set: (data: { type: string; msg: string }) => void },
        show: (type: string) => (msg: unknown) => alerts.current?.set({ type, msg: String(msg) }),
        error: vi.fn((msg: unknown) => alerts.show("error")(msg)),
        normal: vi.fn((msg: unknown) => alerts.show("normal")(msg)),
        wait: vi.fn((msg: unknown) => alerts.show("wait")(msg)),
        clear: vi.fn(() => alerts.current?.set({ type: "none", msg: "" })),
        confirm: vi.fn(async () => true),
        input: vi.fn(async () => ""),
        store: { set: vi.fn(), subscribe: vi.fn() },
    };
    return { server: { current: null as any }, alerts };
});
vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertWait: alerts.wait,
        alertConfirm: alerts.confirm,
        alertStore: alerts.store,
        alertInput: alerts.input,
        alertClear: alerts.clear,
    }),
);
vi.mock("./parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./process/index.svelte", () => ({}));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));

const route = REALM_IMPORT_PATH;
const line = (value: unknown) => JSON.stringify(value) + "\n";
const keyOf = (data: Uint8Array) => `assets/${createHash("sha256").update(data).digest("hex")}.png`;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
const payload = new Uint8Array([0, 255, 128, 80, 75, 3, 4]);
const TOKEN = "11111111-2222-4333-8444-555555555555";
const embedded = {
    id: "embedded-id",
    name: "Embedded",
    lorebook: [
        {
            key: "lore",
            secondkey: "",
            comment: "Embedded lore",
            content: "kept lore",
            mode: "normal",
            insertorder: 100,
            alwaysActive: false,
            selective: false,
        },
    ],
    regex: [{ comment: "Embedded regex", in: "hello", out: "hi", type: "editdisplay", flag: "", ableFlag: true }],
    trigger: [{ comment: "Embedded trigger", type: "start", conditions: [], effect: [] }],
};
const charxPrepared = (card: unknown, moduleData: string | null = null) => ({
    kind: "charx",
    token: TOKEN,
    card: JSON.stringify(card),
    moduleData,
});
const charxCommitted = (assets: Record<string, string> = {}) => ({ kind: "charx", assets, excluded: [] });
const pngPrepared = (card: string) => ({ kind: "png", token: TOKEN, card });
const pngCommitted = (image: string, assets: Record<string, string> = {}) => ({ kind: "png", image, assets });
/** An rcc card's text: the card encrypted with `password` (`RISU_NONE` without one). */
async function rccCard(
    util: { encryptBuffer: (data: Uint8Array, key: string) => Promise<ArrayBuffer> },
    card: unknown,
    password?: string,
) {
    const encrypted = new Uint8Array(
        await util.encryptBuffer(Buffer.from(JSON.stringify(card)), password ?? "RISU_NONE"),
    );
    // `hasher` is mocked to "" here, so the checksum part is "".
    return [
        "rcc",
        "rccv1",
        Buffer.from(encrypted).toString("base64"),
        "",
        b64({ usePassword: password !== undefined }),
    ].join("||");
}

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    alerts.current = booted.stores.alertStore;
    const globalApi = await import("./globalApi.svelte");
    const saveAsset = vi.spyOn(globalApi, "saveAsset").mockImplementation(async (data: Uint8Array) => keyOf(data));
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    const cards = await import("./characterCards");
    const modules = await import("./process/modules");
    const realFetch = booted.fake.fetch.bind(booted.fake);
    const fetch = vi.spyOn(booted.fake, "fetch");
    const toResponse = (response: Response | string) =>
        typeof response === "string" ? new Response(response) : response;
    /**
     * The server's answers to the next Realm import: the prepare's and the commit's (a `Response`, or
     * lines of its NDJSON body); a cancel answers 204.
     */
    const answer = (
        prepare: Response | string,
        commit: Response | string = new Response("unexpected commit", { status: 500 }),
    ) => {
        fetch.mockImplementation((url, init) => {
            if (url === route) return Promise.resolve(toResponse(prepare));
            if (url === REALM_COMMIT_PATH) return Promise.resolve(toResponse(commit));
            if (url === REALM_CANCEL_PATH) return Promise.resolve(new Response(null, { status: 204 }));
            return realFetch(url, init);
        });
    };
    const calls = (path: string) => fetch.mock.calls.filter(([url]) => url === path);
    const downloads = () => calls(route);
    const commits = () => calls(REALM_COMMIT_PATH);
    const cancels = () => calls(REALM_CANCEL_PATH);
    const ids = () => booted.characterList().map((c) => c.chaId);
    const imports = () => (booted.settings.statics as any)?.imports ?? 0;
    // The tab never fetches Realm (or anything else) itself for a binary answer.
    const globalFetch = vi.fn(async (input: unknown): Promise<Response> => {
        throw new Error(`unexpected fetch of ${String(input)}`);
    });
    vi.stubGlobal("fetch", globalFetch);
    /** Nothing was added or stored: no record, no import count change, no tab save. */
    const unchanged = async (before: string[], imports: number) => {
        expect(b.ids()).toEqual(before);
        expect(b.imports()).toBe(imports);
        expect(saveAsset).not.toHaveBeenCalled();
        expect(globalFetch).not.toHaveBeenCalled();
    };
    const b = {
        ...booted,
        cards,
        modules,
        util,
        saveAsset,
        fetch,
        answer,
        downloads,
        commits,
        cancels,
        ids,
        imports,
        globalFetch,
        unchanged,
    };
    return b;
}
/** A request's JSON body. */
const sent = ([, init]: [unknown, RequestInit?]) => JSON.parse(String(init?.body));

beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./characterCards");
}, 60_000);
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    alerts.current = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", new URL("http://localhost/"));
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    alerts.confirm.mockImplementation(async () => true);
    alerts.input.mockImplementation(async () => "");
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("the Realm import through the server (downloadRisuHub)", () => {
    it("sends the id, then the token, and builds a CharX card from the stored keys: module fields merged", async () => {
        const b = await boot();
        const module = await b.modules.exportModuleLegacy(embedded as any, { saveData: false, alertEnd: false });
        const card = cardV3("Downloaded", {
            assets: [{ type: "x-risu-asset", name: "Backdrop", uri: "embeded://assets/background.webp", ext: "webp" }],
        });
        b.answer(
            line(charxPrepared(card, Buffer.from(module).toString("base64"))),
            line({ done: 1, total: 1 }) + line(charxCommitted({ "assets/background.webp": keyOf(payload) })),
        );
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("fixture-id");
        expect(b.downloads()).toHaveLength(1);
        const [, init] = b.downloads()[0];
        expect(init.method).toBe("POST");
        expect(init.body).toBe(JSON.stringify({ id: "fixture-id" }));
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
        expect(b.commits()).toHaveLength(1);
        expect(b.commits()[0][1].body).toBe(JSON.stringify({ token: TOKEN }));
        expect(new Headers(b.commits()[0][1].headers).get("content-type")).toBe("application/json");
        expect(b.cancels()).toEqual([]);
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(b.globalFetch).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.store.set).toHaveBeenCalledWith({ type: "wait", msg: "Downloading..." });
        expect(alerts.wait).toHaveBeenCalledWith("Loading... (Saving Assets 1/1)");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.imports()).toBe(imports + 1);
        await b.sync.flushResources();
        const id = b.ids().at(-1);
        expect(b.record("characters", id)).toMatchObject({
            name: "Downloaded",
            nickname: "Downloaded nick",
            additionalAssets: [["Backdrop", keyOf(payload), "webp"]],
            customscript: embedded.regex,
            triggerscript: embedded.trigger,
            globalLore: [expect.objectContaining({ content: "kept lore" })],
        });
        expect(b.record("characterOrder")).toContain(id);
        expect(b.fake.chat(id, b.character(id).chats[0].id)).not.toBeNull();
    });

    it("builds a PNG card from the stored image key and asset keys without saving anything itself", async () => {
        const b = await boot();
        const card = cardV3("Portrait", {
            assets: [{ type: "x-risu-asset", name: "Asset 0", uri: "__asset:0", ext: "png" }],
        });
        b.answer(
            line(pngPrepared(b64(card))),
            line({ done: 1, total: 1 }) + line(pngCommitted("assets/image-key.png", { "0": "assets/a0.png" })),
        );
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("png-id");
        expect(b.commits()).toHaveLength(1);
        expect(b.cancels()).toEqual([]);
        expect(b.globalFetch).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.imports()).toBe(imports + 1);
        const id = b.ids().at(-1)!;
        expect(plain(b.character(id))).toMatchObject({
            name: "Portrait",
            image: "assets/image-key.png",
            additionalAssets: [["Asset 0", "assets/a0.png", "png"]],
        });
        await b.sync.flushResources();
        expect(b.record("characters", id)).toMatchObject({ image: "assets/image-key.png" });
    });

    it.each(["charx", "png"])(
        "asks a %s card's lowLevelAccess before the commit, and keeps it on the character once accepted",
        async (kind) => {
            const b = await boot();
            const card = cardV3("Powerful", {}, { lowLevelAccess: true });
            const order: string[] = [];
            alerts.confirm.mockImplementation(async () => {
                order.push(`confirm ${b.commits().length}`);
                return true;
            });
            b.answer(
                line(kind === "charx" ? charxPrepared(card) : pngPrepared(b64(card))),
                line(kind === "charx" ? charxCommitted() : pngCommitted("assets/powerful.png")),
            );
            const before = b.ids();
            await b.cards.downloadRisuHub("powerful-id");
            expect(alerts.confirm).toHaveBeenCalledExactlyOnceWith(language.lowLevelAccessConfirm);
            // Asked once, before any commit was sent.
            expect(order).toEqual(["confirm 0"]);
            expect(b.commits()).toHaveLength(1);
            expect(b.cancels()).toEqual([]);
            expect(alerts.error).not.toHaveBeenCalled();
            expect(b.ids()).toHaveLength(before.length + 1);
            expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Powerful", lowLevelAccess: true });
        },
    );

    it.each(["charx", "png"])(
        "cancels a %s card whose lowLevelAccess is declined: no commit, nothing added or stored, no alert",
        async (kind) => {
            const b = await boot();
            const card = cardV3("Declined", {}, { lowLevelAccess: true });
            alerts.confirm.mockImplementation(async () => false);
            b.answer(line(kind === "charx" ? charxPrepared(card) : pngPrepared(b64(card))));
            const before = b.ids();
            const imports = b.imports();
            await b.cards.downloadRisuHub("declined-id");
            expect(alerts.confirm).toHaveBeenCalledExactlyOnceWith(language.lowLevelAccessConfirm);
            expect(b.commits()).toEqual([]);
            expect(b.cancels()).toHaveLength(1);
            expect(sent(b.cancels()[0])).toEqual({ token: TOKEN });
            expect(alerts.error).not.toHaveBeenCalled();
            expect(b.imports()).toBe(imports + 1);
            expect(b.ids()).toEqual(before);
            expect(b.saveAsset).not.toHaveBeenCalled();
        },
    );

    it("decrypts an rcc card without a password and uses the stored image key", async () => {
        const b = await boot();
        b.answer(
            line(pngPrepared(await rccCard(b.util, cardV2("Encrypted")))),
            line(pngCommitted("assets/encrypted.png")),
        );
        const before = b.ids();
        await b.cards.downloadRisuHub("rcc-id");
        expect(alerts.input).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(b.commits()).toHaveLength(1);
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Encrypted", image: "assets/encrypted.png" });
    });

    it("asks an rcc card's password before the commit and imports it with the right password", async () => {
        const b = await boot();
        alerts.input.mockImplementation(async () => {
            expect(b.commits()).toEqual([]);
            return "secret";
        });
        b.answer(
            line(pngPrepared(await rccCard(b.util, cardV2("Locked", {}, { lowLevelAccess: true }), "secret"))),
            line(pngCommitted("assets/locked.png")),
        );
        const before = b.ids();
        await b.cards.downloadRisuHub("locked-id");
        expect(alerts.input).toHaveBeenCalledExactlyOnceWith(language.inputCardPassword);
        // The decrypted card's lowLevelAccess is asked too, after the password.
        expect(alerts.confirm).toHaveBeenCalledExactlyOnceWith(language.lowLevelAccessConfirm);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.commits()).toHaveLength(1);
        expect(b.cancels()).toEqual([]);
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Locked", image: "assets/locked.png" });
    });

    it.each([
        { name: "a wrong password", password: "guess", message: () => language.errors.wrongPassword },
        { name: "a dismissed password prompt", password: "", message: null },
    ])("cancels an rcc card after $name: no commit, nothing added", async ({ password, message }) => {
        const b = await boot();
        alerts.input.mockImplementation(async () => password);
        b.answer(line(pngPrepared(await rccCard(b.util, cardV2("Locked"), "secret"))));
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("locked-id");
        expect(alerts.input).toHaveBeenCalledOnce();
        if (message) expect(alerts.error).toHaveBeenCalledExactlyOnceWith(message());
        else expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(b.commits()).toEqual([]);
        expect(b.cancels()).toHaveLength(1);
        expect(sent(b.cancels()[0])).toEqual({ token: TOKEN });
        expect(b.ids()).toEqual(before);
        expect(b.imports()).toBe(imports + 1);
        expect(b.saveAsset).not.toHaveBeenCalled();
    });

    it("converts an off-spec (Tavern) PNG card with the stored image key", async () => {
        const b = await boot();
        const tavern = {
            name: "Tavern",
            description: "an old card",
            first_mes: "hello",
            personality: "",
            scenario: "",
        };
        b.answer(line(pngPrepared(b64(tavern))), line(pngCommitted("assets/tavern.png")));
        const before = b.ids();
        await b.cards.downloadRisuHub("tavern-id");
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.normal).toHaveBeenCalledWith(language.importedCharacter);
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Tavern", image: "assets/tavern.png" });
    });

    it.each([
        ["a CharX whose card is not V3", line(charxPrepared(cardV2("Old")))],
        ["a tampered rcc card", line(pngPrepared("rcc||rccv1||AAAA||not-the-hash||" + b64({ usePassword: false })))],
    ])("alerts noData for %s, cancels it, and adds no record", async (_name, prepared) => {
        const b = await boot();
        b.answer(prepared);
        const before = b.ids();
        await b.cards.downloadRisuHub("no-card");
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.errors.noData);
        expect(b.commits()).toEqual([]);
        expect(b.cancels()).toHaveLength(1);
        expect(b.ids()).toEqual(before);
        expect(b.saveAsset).not.toHaveBeenCalled();
    });

    it("cancels a card whose text is not JSON and alerts the import error", async () => {
        const b = await boot();
        b.answer(line({ ...charxPrepared({}), card: "{not json" }));
        const before = b.ids();
        await b.cards.downloadRisuHub("broken");
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith("Error while importing");
        expect(b.commits()).toEqual([]);
        expect(b.cancels()).toHaveLength(1);
        expect(b.ids()).toEqual(before);
    });

    it("imports a legacy JSON answer in hub mode: the portrait through /hub-proxy, no import count, no commit", async () => {
        const b = await boot();
        const portrait = new Uint8Array([1, 2, 3, 4]);
        b.globalFetch.mockImplementation(async (input: unknown) => {
            if (String(input) === "/hub-proxy/resource/portrait-id") return new Response(portrait);
            throw new Error(`unexpected fetch of ${String(input)}`);
        });
        b.answer(line({ kind: "json", body: JSON.stringify({ card: cardV3("Legacy"), img: "portrait-id" }) }));
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("legacy-id");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.commits()).toEqual([]);
        expect(b.cancels()).toEqual([]);
        expect(b.globalFetch).toHaveBeenCalledExactlyOnceWith("/hub-proxy/resource/portrait-id");
        expect(b.saveAsset).toHaveBeenCalledTimes(1);
        expect(Buffer.from(b.saveAsset.mock.calls[0][0])).toEqual(Buffer.from(portrait));
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.imports()).toBe(imports);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Legacy", image: keyOf(portrait) });
    });

    it("shows the download and commit alerts only without forceRedirect and the progress lines as they arrive", async () => {
        const b = await boot();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        b.answer(
            line(charxPrepared(cardV3("Progress"))),
            new Response(
                new ReadableStream({
                    start(c) {
                        controller = c;
                    },
                }),
            ),
        );
        const before = b.ids();
        const importing = b.cards.downloadRisuHub("slow-id", { forceRedirect: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(b.commits()).toHaveLength(1);
        expect(alerts.store.set).not.toHaveBeenCalledWith({ type: "wait", msg: "Downloading..." });
        expect(alerts.wait).not.toHaveBeenCalledWith("Loading...");
        for (let done = 1; done <= 2; done++) {
            controller.enqueue(new TextEncoder().encode(line({ done, total: 2 })));
            await vi.advanceTimersByTimeAsync(0);
            expect(alerts.wait).toHaveBeenLastCalledWith(`Loading... (Saving Assets ${done}/2)`);
            expect(b.ids()).toEqual(before);
        }
        controller.enqueue(new TextEncoder().encode(line(charxCommitted())));
        controller.close();
        await importing;
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(alerts.error).not.toHaveBeenCalled();

        b.answer(line(charxPrepared(cardV3("Quiet"))), line(charxCommitted()));
        await b.cards.downloadRisuHub("loud-id");
        expect(alerts.wait).toHaveBeenLastCalledWith("Loading...");
    });

    type Failure = {
        name: string;
        status?: number;
        error?: string;
        body?: string;
        network?: string;
        message: () => string;
    };
    const failures: Failure[] = [
        { name: "invalid file", status: 400, error: "Invalid character file", message: () => language.errors.noData },
        { name: "too large", status: 413, error: "File too large", message: () => language.realmImportFileTooLarge },
        { name: "busy", status: 409, error: "Another import is running", message: () => language.moduleImportBusy },
        { name: "rate limit", status: 429, message: () => language.moduleImportBusy },
        { name: "maintenance", status: 503, message: () => language.moduleImportMaintenance },
        {
            name: "a reverse proxy's 502",
            status: 502,
            message: () => language.realmImportRequestFailed.replace("{{status}}", "502"),
        },
        {
            name: "invalid failure line",
            body: line({ error: "Invalid character file" }),
            message: () => language.errors.noData,
        },
        {
            name: "other failure line",
            body: line({ error: "Import failed" }),
            message: () => language.realmImportStopped.replace("{{error}}", "Import failed"),
        },
        { name: "fetch TypeError", network: "fetch", message: () => language.realmImportInterrupted },
        { name: "body TypeError", network: "body", message: () => language.realmImportInterrupted },
        { name: "no result line", body: line({ done: 1, total: 1 }), message: () => language.errors.noData },
    ];
    const failed = (testCase: Failure) =>
        testCase.network === "body"
            ? new Response(
                  new ReadableStream({
                      start(c) {
                          c.error(new TypeError("lost response"));
                      },
                  }),
              )
            : testCase.status
              ? new Response(testCase.error ? JSON.stringify({ error: testCase.error }) : "proxy failure", {
                    status: testCase.status,
                })
              : new Response(testCase.body);

    it.each([
        ...failures,
        { name: "invalid id", status: 400, error: "Invalid Realm id", message: () => "Invalid Realm id" },
        {
            name: "too many waiting",
            status: 409,
            error: REALM_TOO_MANY_STAGED,
            message: () => language.realmImportTooManyWaiting,
        },
        {
            name: "download failed",
            status: 502,
            error: REALM_DOWNLOAD_FAILED,
            message: () => language.realmImportDownloadFailed,
        },
        {
            name: "Realm's refusal",
            status: 502,
            error: "Realm says: no such card",
            message: () => "Realm says: no such card",
        },
        {
            name: "malformed prepared line",
            body: line({ kind: "png", card: 1, token: null }),
            message: () => language.errors.noData,
        },
    ] as Failure[])(
        "a failed prepare alerts once, adds and counts nothing, never commits, and does not retry: $name",
        async (testCase) => {
            const b = await boot();
            b.answer(failed(testCase));
            if (testCase.network === "fetch") {
                b.fetch.mockImplementation(async () => {
                    throw new TypeError("lost request");
                });
            }
            const before = b.ids();
            const imports = b.imports();
            const order = plain(b.settings.characterOrder);
            await b.cards.downloadRisuHub("refused-id");
            expect(b.downloads()).toHaveLength(1);
            expect(b.commits()).toEqual([]);
            expect(b.cancels()).toEqual([]);
            expect(alerts.error).toHaveBeenCalledExactlyOnceWith(testCase.message());
            expect(alerts.normal).not.toHaveBeenCalled();
            await b.unchanged(before, imports);
            expect(plain(b.settings.characterOrder)).toEqual(order);
            await b.sync.flushResources();
            expect(b.record("characterOrder")).toEqual(order);
        },
    );

    it.each([
        ...failures,
        { name: "expired", status: 404, error: REALM_IMPORT_EXPIRED, message: () => language.realmImportExpired },
        {
            name: "malformed committed line",
            body: line({ kind: "png", image: null, assets: {} }),
            message: () => language.errors.noData,
        },
    ] as Failure[])(
        "a failed commit alerts once, adds nothing, cancels the staged import, and does not retry: $name",
        async (testCase) => {
            const b = await boot();
            b.answer(line(charxPrepared(cardV3("Never"))), failed(testCase));
            if (testCase.network === "fetch") {
                const realFetch = b.fetch.getMockImplementation()!;
                b.fetch.mockImplementation(async (url, init) => {
                    if (url === REALM_COMMIT_PATH) throw new TypeError("lost request");
                    return realFetch(url, init);
                });
            }
            const before = b.ids();
            const imports = b.imports();
            await b.cards.downloadRisuHub("commit-refused-id");
            expect(b.commits()).toHaveLength(1);
            expect(b.cancels()).toHaveLength(1);
            expect(sent(b.cancels()[0])).toEqual({ token: TOKEN });
            expect(alerts.error).toHaveBeenCalledExactlyOnceWith(testCase.message());
            expect(alerts.normal).not.toHaveBeenCalled();
            await b.unchanged(before, imports + 1);
        },
    );
});
