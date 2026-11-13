// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ selectSingleFile: vi.fn<typeof import("src/ts/util").selectSingleFile>() }));
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    selectSingleFile: io.selectSingleFile,
}));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { alertConfirm } from "src/ts/alert";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { characterList, selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { selectCharacter, selectPreset } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import RegexList from "./RegexList.svelte";

let instance: ReturnType<typeof mount>;
let target: HTMLDivElement;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
const regex = (name: string) => ({ comment: name, in: name, out: name, type: "editoutput" as const });
function install() {
    installFlatDatabaseWithChats({
        characters: ["a", "b"].map((chaId) => ({
            chaId,
            type: "character",
            name: chaId,
            chats: [{ id: `${chaId}-chat`, name: chaId, message: [], localLore: [], note: "" }],
            customscript: [regex(chaId)],
        })),
        botPresets: ["p1", "p2"].map((id) => ({ id, name: id, regex: [regex(id)] })),
    });
    target = document.createElement("div");
    document.body.append(target);
}
afterEach(async () => {
    await unmount(instance);
    target.remove();
});

it.each(["character switch", "row replacement"])(
    "cancels regex deletion after a %s during confirmation",
    async (change) => {
        install();
        selectCharacter("a");
        instance = mount(RegexList, {
            target,
            props: {
                get value() {
                    return selectedCharacter()!.customscript;
                },
                set value(next) {
                    selectedCharacter()!.customscript = next;
                },
                get popupEditorContext() {
                    return selectedCharacter()!.chaId;
                },
            },
        });
        flushSync();
        const answer = deferred<boolean>();
        vi.mocked(alertConfirm).mockReturnValueOnce(answer.promise);
        target.querySelector<HTMLButtonElement>('[data-risu-idx="0"] button:has(.lucide-x)')!.click();
        expect(alertConfirm).toHaveBeenCalled();
        if (change === "character switch") selectCharacter("b");
        else selectedCharacter()!.customscript = [regex("remote replacement")];
        flushSync();
        const before = JSON.parse(JSON.stringify(characterList().map((owner) => owner.customscript)));
        answer.resolve(true);
        await tick();
        flushSync();
        expect(characterList().map((owner) => owner.customscript)).toEqual(before);
    },
);

it("cancels a preset regex import after a preset switch without mutating either list", async () => {
    install();
    selectPreset("p1");
    instance = mount(RegexList, {
        target,
        props: {
            buttons: true,
            get value() {
                return activePreset.regex;
            },
            set value(next) {
                activePreset.regex = next;
            },
            get popupEditorContext() {
                return activePreset.id;
            },
        },
    });
    flushSync();
    const picked = deferred<Awaited<ReturnType<typeof io.selectSingleFile>>>();
    io.selectSingleFile.mockReturnValueOnce(picked.promise);
    target.querySelector<HTMLButtonElement>("button:has(.lucide-hard-drive-upload)")!.click();
    expect(io.selectSingleFile).toHaveBeenCalledExactlyOnceWith(["json"]);
    const before = JSON.parse(JSON.stringify(settings.presets.map((preset) => preset.regex)));
    selectPreset("p2");
    flushSync();
    picked.resolve({
        name: "scripts.json",
        data: new TextEncoder().encode(JSON.stringify({ type: "regex", data: [regex("imported")] })),
    });
    await tick();
    await tick();
    flushSync();
    expect(settings.presets.map((preset) => preset.regex)).toEqual(before);
});
