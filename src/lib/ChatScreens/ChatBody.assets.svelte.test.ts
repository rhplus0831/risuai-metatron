// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/parser/parser.svelte", () => ({
    ParseMarkdown: vi.fn(async (text: string) => text),
    trimMarkdown: (html: string) => html,
    addMetadataToElement: (html: string) => html,
    postTranslationParse: async (html: string) => html,
}));
vi.mock("src/ts/parser/assetSearch", async (original) => {
    const actual = await original<typeof import("src/ts/parser/assetSearch")>();
    return { ...actual, findAssetPrefix: vi.fn(actual.findAssetPrefix) };
});
vi.mock("src/ts/translator/translator", () => ({
    applyEdittransToStoredTranslation: (text: string) => text,
    getLLMCache: async () => null,
    translateHTML: async (html: string) => html,
}));
vi.mock("src/ts/parser/transformClient", () => ({ captureTransform: () => null }));
vi.mock("src/ts/process/modules", () => ({ getModuleAssets: vi.fn(() => []), getModules: () => [] }));
vi.mock("src/ts/globalApi.svelte", () => ({ getFileSrc: async (path: string) => path }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn() }));
vi.mock("src/ts/util", () => ({ sleep: async () => undefined }));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ selectedCharacter: vi.fn() }));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({
    settings: { ui: {}, memoryTranslateMedia: { newImageHandlingBeta: true } },
}));

import ChatBody from "./ChatBody.svelte";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { getModuleAssets } from "src/ts/process/modules";
import { findAssetPrefix } from "src/ts/parser/assetSearch";

type Asset = [string, string, string];
const character = $state({ additionalAssets: [] as Asset[], prebuiltAssetStyle: "" });
const modules = $state({ assets: [] as Asset[] });
const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    character.additionalAssets = [];
    modules.assets = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

async function settle() {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
}

function render() {
    vi.mocked(selectedCharacter).mockImplementation(() => character as ReturnType<typeof selectedCharacter>);
    vi.mocked(getModuleAssets).mockImplementation(() => modules.assets);
    const target = document.createElement("div");
    document.body.append(target);
    const props = $state({
        msgDisplay: '<img src="pose.png">',
        bodyRoot: target,
        role: "char",
        translated: false,
        translating: false,
        retranslate: false,
        modelShortName: "",
    });
    mounted.push(mount(ChatBody, { target, props }));
    return { target, props };
}

describe("ChatBody image asset fallback", () => {
    it("renders the first prefix minimum from module and character assets, retaining an empty-path winner", async () => {
        modules.assets = [["pose.jpg", "blob:first", "jpg"]];
        character.additionalAssets = [
            ["pose.gif", "blob:tie", "gif"],
            ["posf.png", "blob:wrong-prefix", "png"],
        ];
        const { target, props } = render();
        await settle();
        expect(target.querySelector("img")?.getAttribute("src")).toBe("blob:first");
        // A still closer non-prefix candidate must never win.
        modules.assets = [["pose.jpg", "", "jpg"]];
        props.msgDisplay = '<p>empty winner</p><img src="pose.png">';
        await settle();
        expect(target.querySelector("img")?.getAttribute("noimage")).toBe("true");
        expect(target.querySelector("img")?.getAttribute("src")).toBe("pose.png");
    });

    it("memoizes unresolved names across renders and rescans when the image asset value changes", async () => {
        const { target, props } = render();
        props.msgDisplay = '<p>first</p><img src="missing.png">';
        await settle();
        expect(target.querySelector("img")?.getAttribute("noimage")).toBe("true");
        expect(findAssetPrefix).toHaveBeenCalledTimes(1);
        props.msgDisplay = '<p>second</p><img src="missing.png">';
        await settle();
        expect(target.querySelector("img")?.getAttribute("noimage")).toBe("true");
        expect(findAssetPrefix).toHaveBeenCalledTimes(1);
        character.additionalAssets = [["missing.jpg", "blob:found", "jpg"]];
        props.msgDisplay = '<p>third</p><img src="missing.png">';
        await settle();
        expect(target.querySelector("img")?.getAttribute("src")).toBe("blob:found");
        expect(findAssetPrefix).toHaveBeenCalledTimes(2);
        props.msgDisplay = '<p>fourth</p><img src="missing.png">';
        await settle();
        expect(target.querySelector("img")?.getAttribute("src")).toBe("blob:found");
        expect(findAssetPrefix).toHaveBeenCalledTimes(2);
    });
});
