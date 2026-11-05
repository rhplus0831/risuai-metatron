// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { disableHighlight } from "src/ts/stores.svelte";
import * as highlighting from "./highlight";

class TestHighlight extends Set<Range> {
    constructor(...ranges: Range[]) {
        super(ranges);
    }
}

let registry: Map<string, TestHighlight>;
let allocatedIds: MockInstance<typeof highlighting.getNewHighlightId>;
const mounted: ReturnType<typeof mount>[] = [];
const initialDisableHighlight = get(disableHighlight);

function editor(text: string) {
    const dom = document.createElement("div");
    dom.textContent = text;
    document.body.appendChild(dom);
    return dom;
}

function registeredRanges() {
    return [...registry.values()].flatMap((highlight) => [...highlight]);
}

function render(highlight: boolean, value: string) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(TextAreaInput, { target, props: { highlight, value, popupEditor: false } });
    mounted.push(instance);
    flushSync();
    return { target };
}

beforeEach(() => {
    vi.useFakeTimers();
    disableHighlight.set(false);
    registry = new Map();
    vi.stubGlobal("CSS", {
        get highlights() {
            return registry;
        },
    });
    vi.stubGlobal("Highlight", TestHighlight);
    // Observe allocations without changing them, including ids allocated inside TextAreaInput, for cleanup.
    allocatedIds = vi.spyOn(highlighting, "getNewHighlightId");
    installFlatDatabase({ characters: [], personas: [] });
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    await vi.runAllTimersAsync();
    for (const result of allocatedIds.mock.results) {
        if (result.type === "return") highlighting.removeHighlight(result.value);
    }
    document.body.replaceChildren();
    disableHighlight.set(initialDisableHighlight);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("editor highlight registry", () => {
    it("highlights exactly {{char}} after 300 plain characters", () => {
        const id = highlighting.getNewHighlightId();
        const dom = editor("a".repeat(300) + "{{char}}");
        highlighting.highlighter(dom, id);

        const ranges = registeredRanges();
        expect(ranges).toHaveLength(1);
        expect(ranges[0].toString()).toBe("{{char}}");
        expect(ranges[0].startOffset).toBe(300);
    });

    it("deletes CBS categories when the same editor changes from {{user}} to plain text", () => {
        const id = highlighting.getNewHighlightId();
        const dom = editor("{{user}}");
        highlighting.highlighter(dom, id);
        expect([...registry.keys()].filter((key) => key.startsWith("cbsnest"))).toHaveLength(1);
        expect(registeredRanges().map((range) => range.toString())).toEqual(["{{user}}"]);

        dom.textContent = "plain text";
        highlighting.highlighter(dom, id);
        expect([...registry.keys()].filter((key) => key.startsWith("cbsnest"))).toEqual([]);
    });

    it("removes only the departing editor's ranges from a shared category and deletes it when the last editor leaves", () => {
        const firstId = highlighting.getNewHighlightId();
        const secondId = highlighting.getNewHighlightId();
        expect(secondId).not.toBe(firstId);
        const first = editor("{{user}}");
        const second = editor("{{user}}");
        highlighting.highlighter(first, firstId);
        highlighting.highlighter(second, secondId);
        expect(registry.size).toBe(1);
        const [category] = registry.keys();
        expect(registry.get(category)!.size).toBe(2);

        highlighting.removeHighlight(firstId);
        expect([...registry.keys()]).toEqual([category]);
        const remaining = [...registry.get(category)!];
        expect(remaining).toHaveLength(1);
        expect(remaining[0].startContainer).toBe(second.firstChild);
        expect(remaining[0].endContainer).toBe(second.firstChild);
        expect(remaining[0].toString()).toBe("{{user}}");

        highlighting.removeHighlight(secondId);
        expect(registry.size).toBe(0);
    });

    it("never touches the registry or another editor's highlights when TextAreaInput highlighting is off", async () => {
        const id = highlighting.getNewHighlightId();
        const liveEditor = editor("{{user}}");
        highlighting.highlighter(liveEditor, id);
        expect(registeredRanges().map((range) => range.toString())).toEqual(["{{user}}"]);
        const entries = [...registry.entries()];
        const access = vi.spyOn(CSS, "highlights", "get");

        const ui = render(false, "plain text");
        const input = ui.target.querySelector("textarea")!;
        expect(input).not.toBeNull();
        input.value = "{{user}}";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        await vi.runAllTimersAsync();
        await unmount(mounted.pop()!);
        await vi.runAllTimersAsync();

        expect(access).not.toHaveBeenCalled();
        expect([...registry.entries()]).toEqual(entries);
        expect(registeredRanges()).toHaveLength(1);
        expect(registeredRanges()[0].startContainer).toBe(liveEditor.firstChild);
    });
});
