// @vitest-environment happy-dom

import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/process/modules", async (original) => ({
    ...(await original<typeof import("src/ts/process/modules")>()),
    moduleUpdate: vi.fn(),
}));

import { language } from "src/lang";
import { activePreset } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { disableHighlight } from "src/ts/stores.svelte";
import PromptDataItem from "./PromptDataItem.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const targets: HTMLDivElement[] = [];
let previousHighlight: boolean;

beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabase({
        characters: [],
        promptTemplate: [{ type: "plain", type2: "normal", text: "Keep {{user}} literal", role: "system" }],
    });
    previousHighlight = get(disableHighlight);
    disableHighlight.set(false);
});

afterEach(async () => {
    for (const component of mounted.splice(0)) await unmount(component);
    for (const target of targets.splice(0)) target.remove();
    disableHighlight.set(previousHighlight);
    vi.useRealTimers();
});

function render(props: Partial<ComponentProps<typeof PromptDataItem>> = {}) {
    const target = document.createElement("div");
    document.body.append(target);
    targets.push(target);
    mounted.push(
        mount(PromptDataItem, {
            target,
            props: {
                promptItem: activePreset.promptTemplate![0],
                isOpened: true,
                ...props,
            },
        }),
    );
    flushSync();
    return target;
}

const optionValues = (select: HTMLSelectElement) => [...select.options].map((option) => option.value);

describe("PromptDataItem", () => {
    it("hides the single allowed type and special type, and renders a plain textarea with CBS off", () => {
        const target = render({ allowedTypes: ["plain"], showType2: false, cbs: false });
        const labels = [...target.querySelectorAll("span")].map((span) => span.textContent?.trim());
        expect(labels).not.toContain(language.type);
        expect(labels).not.toContain(language.specialType);
        const selects = [...target.querySelectorAll("select")];
        expect(selects.map(optionValues)).toEqual([["user", "bot", "system"]]);
        expect(target.querySelector("textarea")?.value).toBe("Keep {{user}} literal");
        expect(target.querySelector("[contenteditable=true]")).toBeNull();
    });

    it("keeps template types, special types and highlighted editing by default, with cot gated by the preset", () => {
        const types = [
            "plain",
            "jailbreak",
            "chat",
            "persona",
            "description",
            "authornote",
            "lorebook",
            "memory",
            "postEverything",
            "chatML",
            "cache",
        ];
        for (const customChainOfThought of [false, true]) {
            const target = render({ promptSettings: { customChainOfThought, sendChatAsSystem: false } });
            const selects = [...target.querySelectorAll("select")];
            expect(selects.map(optionValues)).toEqual([
                customChainOfThought ? [...types, "cot"] : types,
                ["normal", "main", "globalNote"],
                ["user", "bot", "system"],
            ]);
            expect(target.querySelector("textarea")).toBeNull();
            expect(target.querySelector('[role="textbox"][contenteditable=true]')?.textContent).toBe(
                "Keep {{user}} literal",
            );
        }
    });
});
