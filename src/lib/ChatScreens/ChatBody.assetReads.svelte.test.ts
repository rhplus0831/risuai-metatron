// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the row, parser and file-source cache real: only storage/network I/O and unrelated
// application services are replaced, so a missing opt-in at either call boundary is visible.
vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/assetClient", async () =>
    (await import("src/ts/storage/tests/assetClientMock")).createAssetClientMock(),
);
vi.mock("src/ts/parser/transformClient", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/parser/transformClient")>()),
    captureTransform: vi.fn(() => null),
    serverProcessScript: vi.fn(async (_char: unknown, data: string) => ({ data, emoChanged: false })),
}));

import { alertError } from "src/ts/alert";
import { setDirectAssets, setUsingSw } from "src/ts/globalApi.svelte";
import { ParseMarkdown } from "src/ts/parser/parser.svelte";
import { isTransient } from "src/ts/parser/renderErrors";
import { serverProcessScript, type CapturedTransform } from "src/ts/parser/transformClient";
import * as inlays from "src/ts/process/files/inlays";
import { readAsset } from "src/ts/storage/assetClient";
import { resetRecords } from "src/ts/storage/records.svelte";
import { selectCharacter, selectPersona } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import ChatBody from "./ChatBody.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const originalNavigator = globalThis.navigator;
let serial = 0;
let assets: Record<"picture" | "emotion" | "char" | "user" | "inlay", string>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    setUsingSw(false);
    setDirectAssets(false);
    assets = {
        picture: `assets/picture-${++serial}.png`,
        emotion: `assets/emotion-${serial}.png`,
        char: `assets/char-${serial}.png`,
        user: `assets/user-${serial}.png`,
        inlay: `assets/inlay-${serial}.png`,
    };
    vi.mocked(readAsset).mockReset().mockRejectedValue(new TypeError("Asset storage unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:requested-icon");
    vi.spyOn(inlays, "getInlayMedia").mockResolvedValue({ type: "image", asset: assets.inlay });
    installFlatDatabase({
        hideAllImages: false,
        legacyMediaFindings: false,
        enabledModules: [],
        modules: [],
        personas: [{ id: "persona", name: "User", icon: assets.user }],
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                image: assets.char,
                additionalAssets: [["picture", assets.picture, "png"]],
                emotionImages: [["joy", assets.emotion]],
                customscript: [],
            },
        ],
    });
    selectCharacter("c");
    selectPersona("persona");
    flushSync();
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    document.body.innerHTML = "";
    resetRecords();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.stubGlobal("navigator", originalNavigator);
    setUsingSw(false);
    setDirectAssets(false);
});

const parse = (text: string, rejectFailedAssetReads = false) =>
    ParseMarkdown(text, "c", "normal", -1, {}, null, undefined, { rejectFailedAssetReads });

describe("asset read failures in chat renders", () => {
    it("replaces an errored direct thumbnail after controller loss through the row's capture listener", async () => {
        const worker: { controller: object | null } = { controller: {} };
        vi.stubGlobal("navigator", { serviceWorker: worker });
        setUsingSw(true);
        setDirectAssets(true);
        vi.mocked(readAsset).mockResolvedValue(Buffer.from([137, 80, 78, 71]));
        const target = document.createElement("div");
        document.body.append(target);
        const instance = mount(ChatBody, {
            target,
            props: {
                bodyRoot: target,
                msgDisplay: "{{img::picture}}",
                character: "c",
                role: "char",
                translated: false,
                translating: false,
                retranslate: false,
            },
        });
        mounted.push(instance);
        flushSync();
        await vi.advanceTimersByTimeAsync(0);
        await instance.whenRendered();
        const image = target.querySelector("img")!;
        const direct = `/api/asset/${Buffer.from(assets.picture).toString("hex")}`;
        expect(image.getAttribute("src")).toBe(direct);
        expect(readAsset).not.toHaveBeenCalled();
        // The browser may already have requested a thumbnail when it loses its controller.
        image.setAttribute("src", `${direct}?w=256`);
        worker.controller = null;
        image.dispatchEvent(new Event("error", { bubbles: false }));
        await vi.advanceTimersByTimeAsync(0);
        expect(image.getAttribute("src")).toBe("blob:requested-icon");
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(assets.picture);
        image.dispatchEvent(new Event("error", { bubbles: false }));
        await vi.advanceTimersByTimeAsync(0);
        expect(readAsset).toHaveBeenCalledTimes(1);
        expect(alertError).not.toHaveBeenCalled();
    });

    it("alerts once for an HTTP 401 asset refusal without retrying the read", async () => {
        const failure = Object.assign(new Error("Asset access refused"), { status: 401 });
        vi.mocked(readAsset).mockRejectedValue(failure);
        const target = document.createElement("div");
        document.body.append(target);
        const text = "Look {{img::picture}}";
        const instance = mount(ChatBody, {
            target,
            props: {
                msgDisplay: text,
                character: "c",
                role: "char",
                translated: false,
                translating: false,
                retranslate: false,
            },
        });
        mounted.push(instance);
        flushSync();
        await vi.advanceTimersByTimeAsync(0);
        expect(alertError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                message: "Error while parsing chat message: Asset access refused",
                stack: failure.stack,
            }),
        );
        expect(isTransient(failure)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await instance.whenRendered();
        expect(target.textContent).toBe(text);
        await vi.runAllTimersAsync();
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(assets.picture);
        expect(alertError).toHaveBeenCalledTimes(1);
    });

    it("retries a failed asset read after 250 ms and 1 s, then alerts once and renders the input", async () => {
        const failure = new TypeError("Asset storage unavailable");
        vi.mocked(readAsset).mockRejectedValue(failure);
        const target = document.createElement("div");
        document.body.append(target);
        const text = "Look {{img::picture}}";
        const instance = mount(ChatBody, {
            target,
            props: {
                msgDisplay: text,
                character: "c",
                role: "char",
                translated: false,
                translating: false,
                retranslate: false,
            },
        });
        mounted.push(instance);
        flushSync();
        await vi.advanceTimersByTimeAsync(0);
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(assets.picture);
        await vi.advanceTimersByTimeAsync(249);
        expect(readAsset).toHaveBeenCalledTimes(1);
        expect(alertError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(readAsset).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(readAsset).toHaveBeenCalledTimes(2);
        expect(alertError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(vi.mocked(readAsset).mock.calls).toEqual([[assets.picture], [assets.picture], [assets.picture]]);
        expect(alertError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                message: "Error while parsing chat message: Asset storage unavailable",
                stack: failure.stack,
            }),
        );
        await instance.whenRendered();
        expect(target.textContent).toBe(text);
        await vi.runAllTimersAsync();
        expect(readAsset).toHaveBeenCalledTimes(3);
        expect(alertError).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["picture", "{{raw::picture}}"],
        ["emotion", "{{emotion::joy}}"],
        ["char", "{{source::char}}"],
        ["user", "{{source::user}}"],
        ["inlay", "{{inlay::picture}}"],
    ] as const)("keeps failed %s reads silent by default and marks opted-in failures transient", async (kind, tag) => {
        const failure = new TypeError("Asset storage unavailable");
        vi.mocked(readAsset).mockRejectedValue(failure);
        // Omit the trailing option entirely, as existing callers do.
        const output = document.createElement("div");
        output.innerHTML = await ParseMarkdown(tag, "c", "normal", -1, {}, null);
        expect(output.textContent?.trim()).toBe(kind === "inlay" ? tag : "");
        await expect(parse(tag, true)).rejects.toBe(failure);
        expect(isTransient(failure)).toBe(true);
        expect(vi.mocked(readAsset).mock.calls).toEqual([[assets[kind]], [assets[kind]]]);
    });

    it.each(["char", "user"] as const)("reads only the requested %s source icon under the opt-in", async (kind) => {
        vi.mocked(readAsset).mockImplementation(async (key) => {
            if (key !== assets[kind]) throw new Error("The unused icon is unavailable");
            return Buffer.from([137, 80, 78, 71]);
        });
        const output = document.createElement("div");
        output.innerHTML = await parse(`{{source::${kind}}}`, true);
        expect(output.textContent?.trim()).toBe("blob:requested-icon");
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(assets[kind]);
    });

    it("applies the failure opt-in to an asset introduced by the display transform", async () => {
        const transform: CapturedTransform = {
            chatRef: { chaId: "c", chatId: "chat-c" },
            context: {
                characterId: "c",
                chatId: "chat-c",
                presetId: "preset",
                modelPresetId: "model-preset",
                personaId: "persona",
                selectedPersonaId: "persona",
            },
            pluginContext: undefined,
            generation: 0,
            cacheGeneration: 0,
            noCache: false,
            locked: false,
            installVersion: 0,
            hadUnackedWork: false,
            mixedDisplay: false,
        };
        const failure = new TypeError("Transformed asset unavailable");
        vi.mocked(readAsset).mockRejectedValue(failure);
        await vi.mocked(serverProcessScript).withImplementation(
            async () => ({ data: "{{raw::picture}}", emoChanged: false }),
            async () => {
                await expect(ParseMarkdown("plain text", "c", "normal", -1, {}, transform)).resolves.toBe("");
                await expect(
                    ParseMarkdown("plain text", "c", "normal", -1, {}, transform, undefined, {
                        rejectFailedAssetReads: true,
                    }),
                ).rejects.toBe(failure);
                expect(isTransient(failure)).toBe(true);
                expect(vi.mocked(readAsset).mock.calls).toEqual([[assets.picture], [assets.picture]]);
            },
        );
    });

    it("omits a hidden inlay image without reading its failing asset under the opt-in", async () => {
        settings.ui.hideAllImages = true;
        const output = document.createElement("div");
        output.innerHTML = await parse("before{{inlay::picture}}after", true);
        expect(output.textContent?.trim()).toBe("beforeafter");
        expect(output.querySelector("img")).toBeNull();
        expect(readAsset).not.toHaveBeenCalled();
    });
});
