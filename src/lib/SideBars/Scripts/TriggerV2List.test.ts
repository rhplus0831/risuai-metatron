// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { reactiveProps } from "src/lib/UI/tests/reactiveProps.svelte";

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import type { triggerscript } from "../../../../shared/triggers.ts";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import TriggerV2List from "./TriggerV2List.svelte";

let instance: ReturnType<typeof mount>;
let target: HTMLDivElement;
afterEach(async () => {
    await unmount(instance);
    target.remove();
    vi.useRealTimers();
});
const button = (text: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
function click(node: HTMLButtonElement) {
    node.click();
    flushSync();
}

it.each([
    ["input", false],
    ["input", true],
    ["display", true],
    ["request", true],
] as const)(
    "%s with low-level access %s gates the persona setter in the palette and opens its stored edit form",
    (type, lowLevelAble) => {
        vi.useFakeTimers();
        installFlatDatabase({ characters: [] });
        const value: triggerscript[] = [
            { comment: "", type: "manual", conditions: [], effect: [{ type: "v2Header", code: "", indent: 0 }] },
            {
                comment: "Stored persona effect",
                type,
                conditions: [],
                effect: [{ type: "v2SetPersonaDesc", valueType: "value", value: "Saved description", indent: 0 }],
            },
        ];
        const props = reactiveProps({ value, lowLevelAble });
        target = document.createElement("div");
        document.body.append(target);
        instance = mount(TriggerV2List, { target, props });
        flushSync();
        click(button(language.edit)!);
        expect(button("Stored persona effect")).toBeDefined();
        const effect = document.querySelector<HTMLButtonElement>("button.text-purple-500")!;
        expect(effect).not.toBeNull();
        effect.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        flushSync();
        const edit = [...document.querySelectorAll("button")]
            .filter((node) => node.textContent?.trim() === language.edit)
            .at(-1)!;
        click(edit);
        expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Saved description");
        expect(props.value[1].effect).toEqual(value[1].effect);
        click(document.querySelector<HTMLButtonElement>("button:has(.lucide-arrow-left)")!);
        const add = button("...")!;
        click(add);
        click(add);
        const data = button(language.triggerCategories.Data);
        if (type === "input") {
            expect(data).toBeDefined();
            click(data!);
            expect(button(language.triggerDesc.v2GetPersonaDesc)).toBeDefined();
        }
        expect(button(language.triggerDesc.v2SetPersonaDesc)).toBeUndefined();
        const lowLevel = button(language.triggerCategories["Low Level"]);
        const allowed = type === "input" && lowLevelAble;
        expect(!!lowLevel).toBe(allowed);
        if (lowLevel) {
            click(lowLevel);
            expect(button(language.triggerDesc.v2SetPersonaDesc)).toBeDefined();
            expect(button(language.triggerDesc.v2RunLLM)).toBeDefined();
        }
        expect(props.value[1].effect).toEqual([
            { type: "v2SetPersonaDesc", valueType: "value", value: "Saved description", indent: 0 },
        ]);
    },
);
