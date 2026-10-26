import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PartialEditController from "../PartialEditController.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

const mounted: ReturnType<typeof mount>[] = [];
type SaveEvent = { newData: string; target: "original" | "translation"; translationKey?: string };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
            observe() {
                this.callback([{ isIntersecting: true }]);
            }
            disconnect() {}
        },
    );
    window.getSelection()?.removeAllRanges();
    installFlatDatabase({ zoomsize: 100, lineHeight: 1.25 });
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
});

async function openEditor() {
    const target = document.createElement("div");
    const bodyRoot = document.createElement("div");
    bodyRoot.innerHTML = "<p>Hello world</p>";
    target.append(bodyRoot);
    document.body.append(target);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(bodyRoot.querySelector("p"));
    const saved: SaveEvent[] = [];
    mounted.push(
        mount(PartialEditController, {
            target,
            props: { messageData: "Hello world", chatIndex: 0, bodyRoot, blockEditEnabled: true },
            events: { save: (event: CustomEvent<SaveEvent>) => saved.push(event.detail) },
        }),
    );
    flushSync();
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5, bubbles: true }));
    await vi.advanceTimersToNextFrame();
    const edit = document.querySelector<HTMLButtonElement>(".partial-edit-btn-edit")!;
    expect(edit.parentElement!.style.display).not.toBe("none");
    edit.click();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    const textarea = document.querySelector<HTMLTextAreaElement>(".partial-edit-textarea")!;
    expect(textarea).not.toBeNull();
    textarea.value = "Edited draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    return { saved, textarea };
}

describe("partial editor keyboard shortcuts", () => {
    it.each([
        { shortcut: "Escape cancels", init: { key: "Escape" }, saves: false },
        { shortcut: "Ctrl+Enter saves", init: { key: "Enter", ctrlKey: true }, saves: true },
        { shortcut: "Meta+Enter saves", init: { key: "Enter", metaKey: true }, saves: true },
    ])("$shortcut only outside IME composition", async ({ init, saves }) => {
        const ui = await openEditor();
        for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
            const event = new KeyboardEvent("keydown", { ...init, ...composition, bubbles: true, cancelable: true });
            const preventDefault = vi.spyOn(event, "preventDefault");
            ui.textarea.dispatchEvent(event);
            await tick();
            expect(ui.saved).toEqual([]);
            expect(document.querySelector(".partial-edit-textarea")).toBe(ui.textarea);
            expect(ui.textarea.value).toBe("Edited draft");
            expect(preventDefault).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        }

        ui.textarea.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
        await tick();
        expect(document.querySelector(".partial-edit-modal")).toBeNull();
        expect(ui.saved).toEqual(
            saves ? [{ newData: "Edited draft", target: "original", translationKey: undefined }] : [],
        );
    });
});
