// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { alertConfirm } from "src/ts/alert";
import { language } from "src/lang";
import { characterList, selectedCharacter } from "src/ts/storage/characterStore.svelte";
import type { ClientCharacter } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import TriggerList from "./TriggerList.svelte";

let instance: ReturnType<typeof mount>;
let target: HTMLDivElement;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
const owner = () => selectedCharacter() as ClientCharacter;
const scripts = () =>
    JSON.parse(JSON.stringify(characterList().map((entry) => (entry as ClientCharacter).triggerscript)));
const button = (text: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;

beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabaseWithChats({
        characters: ["a", "b"].map((chaId) => ({
            chaId,
            type: "character",
            name: chaId,
            chats: [{ id: `${chaId}-chat`, name: chaId, message: [], localLore: [], note: "" }],
            triggerscript: [
                {
                    comment: `${chaId} script`,
                    type: "start",
                    conditions: [],
                    effect: [{ type: "triggercode", code: `${chaId} code` }],
                },
            ],
        })),
    });
    selectCharacter("a");
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(TriggerList, {
        target,
        props: {
            get value() {
                return owner().triggerscript;
            },
            set value(next) {
                owner().triggerscript = next;
            },
            get popupEditorContext() {
                return selectedCharacter()!.chaId;
            },
            lowLevelAble: true,
        },
    });
    flushSync();
});
afterEach(async () => {
    await unmount(instance);
    target.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it.each(["Lua", "V2"])("cancels a pending %s mode change when the selected character changes", async (mode) => {
    const before = scripts();
    const answer = deferred<boolean>();
    vi.mocked(alertConfirm).mockReturnValueOnce(answer.promise);
    button(mode).click();
    expect(alertConfirm).toHaveBeenLastCalledWith(language.triggerSwitchWarn);
    selectCharacter("b");
    flushSync();
    answer.resolve(true);
    await tick();
    flushSync();
    expect(scripts()).toEqual(before);
});

it("cancels a V2 import when selection changes while the file is being read", async () => {
    owner().triggerscript = [
        { comment: "", type: "manual", conditions: [], effect: [{ type: "v2Header", code: "", indent: 0 }] },
        { comment: "a event", type: "manual", conditions: [], effect: [] },
    ];
    flushSync();
    button(language.edit).click();
    flushSync();
    const before = scripts();
    let picker: HTMLInputElement | undefined;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
        expect(this.type).toBe("file");
        picker = this;
    });
    document.querySelector<HTMLButtonElement>("button:has(.lucide-upload)")!.click();
    expect(picker).toBeDefined();
    const read = deferred<string>();
    const text = vi.fn(() => read.promise);
    Object.defineProperty(picker!, "files", { value: [{ text }] });
    picker!.dispatchEvent(new Event("change"));
    expect(text).toHaveBeenCalledOnce();
    selectCharacter("b");
    flushSync();
    read.resolve(JSON.stringify([{ comment: "imported for a", type: "manual", conditions: [], effect: [] }]));
    await tick();
    flushSync();
    expect(scripts()).toEqual(before);
});
