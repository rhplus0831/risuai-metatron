// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The partial editor's translation writes (`docs/plan/translation.md` slice 1.4; Astra challenge
// point 1): with a `saveTranslation` callback the controller awaits the write, keeps the draft when
// it is refused or throws, closes only when the edit session that saved is still the open one (a
// cancel or a newer edit started meanwhile leaves the newer editor alone), refuses overlapping saves,
// and never edits the original from a translated view whose translation context is missing. Without
// the callback it dispatches `save` as before, and an original edit still dispatches.

const alerts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertError: alerts.error, alertNormal: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PartialEditController from "./PartialEditController.svelte";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

/** An IntersectionObserver that reports every observed element as in view at once. */
class InViewObserver {
    constructor(private readonly callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
    observe(target: Element) {
        this.callback([{ isIntersecting: true, target }]);
    }
    disconnect() {}
}

const mounted: ReturnType<typeof mount>[] = [];
const SOURCE = "Hello world";

type SaveEvent = { newData: string; target: "original" | "translation"; translationKey?: string };

function render(props: {
    translatedView?: boolean;
    context?: () => Promise<{ key: string; data: string } | null>;
    saveTranslation?: (newData: string, key: string) => Promise<boolean> | boolean;
    /** The message's source (default `SOURCE`) and its rendered HTML (default one paragraph of it). */
    source?: string;
    html?: string;
    /** Which rendered block the pointer is over (default the first paragraph). */
    hovered?: (bodyRoot: HTMLElement) => HTMLElement;
    dragEditEnabled?: boolean;
}) {
    const source = props.source ?? SOURCE;
    const target = document.createElement("div");
    document.body.appendChild(target);
    const bodyRoot = document.createElement("div");
    bodyRoot.innerHTML = props.html ?? `<p>${source}</p>`;
    target.appendChild(bodyRoot);
    const block = props.hovered?.(bodyRoot) ?? bodyRoot.querySelector("p")!;
    // The hover detection asks the document what is under the pointer.
    document.elementFromPoint = () => block;
    const saved: SaveEvent[] = [];
    mounted.push(
        mount(PartialEditController, {
            target,
            props: {
                messageData: source,
                chatIndex: 0,
                bodyRoot,
                blockEditEnabled: true,
                dragEditEnabled: props.dragEditEnabled ?? false,
                translatedView: props.translatedView ?? false,
                getTranslationEditContext: props.context,
                saveTranslation: props.saveTranslation,
            },
            events: {
                save: (event: CustomEvent<SaveEvent>) => {
                    saved.push(event.detail);
                },
            },
        }),
    );
    flushSync();

    const query = <T extends Element>(selector: string) => document.querySelector<T>(selector);
    const anyModal = () =>
        query(".partial-edit-modal") ??
        query(".partial-delete-modal") ??
        query(".partial-match-failed-modal") ??
        query(".partial-match-selection-modal");
    /** Waits for the editor or a modal, then (unless `settle` is false) for the editor's focus and scroll timers. */
    const opened = async ({ settle = true } = {}) => {
        await vi.waitFor(() => expect(anyModal()).not.toBeNull());
        // `proceedWithEdit` focuses the textarea 10 ms after opening and scrolls its buttons 200 ms later.
        if (settle) {
            await new Promise((resolve) => setTimeout(resolve, 230));
        }
    };
    /** Hovers the block and clicks its edit (or delete) button, then `opened`. */
    const start = async (action: "edit" | "delete", { settle = true } = {}) => {
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5, bubbles: true }));
        await vi.waitFor(() => {
            const wrapper = query<HTMLElement>(".partial-edit-btn-wrapper");
            expect(wrapper).not.toBeNull();
            expect(wrapper!.style.display).not.toBe("none");
        });
        query<HTMLButtonElement>(`.partial-edit-btn-${action}`)!.click();
        await opened({ settle });
    };
    /**
     * Selects `text` inside the rendered body (the first text node holding it) as a drag would, lets
     * the controller's debounce see it, and clicks the drag edit (or delete) button, then `opened`.
     */
    const dragStart = async (text: string, action: "edit" | "delete") => {
        const walker = document.createTreeWalker(bodyRoot, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const at = node.textContent!.indexOf(text);
            if (at >= 0) {
                const range = document.createRange();
                range.setStart(node, at);
                range.setEnd(node, at + text.length);
                const selection = window.getSelection()!;
                selection.removeAllRanges();
                selection.addRange(range);
                break;
            }
        }
        expect(window.getSelection()!.toString()).toBe(text);
        document.dispatchEvent(new Event("selectionchange"));
        await vi.waitFor(() => {
            const wrapper = query<HTMLElement>(".partial-edit-drag-btn-wrapper");
            expect(wrapper).not.toBeNull();
            expect(wrapper!.style.display).not.toBe("none");
        });
        query<HTMLButtonElement>(`.partial-edit-drag-btn-wrapper .partial-edit-btn-${action}`)!.click();
        await opened();
    };
    /** The chooser's rows, with the source text each one would edit. */
    const choices = () =>
        Array.from(document.querySelectorAll(".partial-match-selection-modal .match-item")).map((item) =>
            item.querySelector(".match-text")!.textContent!.trim(),
        );
    const choose = async (index: number) => {
        document.querySelectorAll<HTMLElement>(".partial-match-selection-modal .match-item")[index]!.click();
        flushSync();
        await vi.waitFor(() => expect(query(".partial-match-selection-modal")).toBeNull());
        await opened();
    };
    const confirmDelete = () => {
        query<HTMLButtonElement>(".partial-delete-confirm-btn")!.click();
        flushSync();
    };
    const textarea = () => query<HTMLTextAreaElement>(".partial-edit-textarea");
    const type = (text: string) => {
        const area = textarea()!;
        area.value = text;
        area.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    const save = () => {
        query<HTMLButtonElement>(".partial-edit-modal .partial-edit-save-btn")!.click();
        flushSync();
    };
    const cancel = () => {
        query<HTMLButtonElement>(".partial-edit-modal .partial-edit-cancel-btn")!.click();
        flushSync();
    };
    return { saved, start, dragStart, choices, choose, confirmDelete, textarea, type, save, cancel, query, block };
}

beforeEach(() => {
    alerts.error.mockReset();
    vi.stubGlobal("IntersectionObserver", InViewObserver);
    installFlatDatabase({ zoomsize: 100, lineHeight: 1.25 });
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
});

describe("PartialEditController translation writes", () => {
    it("awaits the callback, refuses an overlapping save, and a save that ends after a cancel and a newer edit leaves the newer editor alone", async () => {
        const first = deferred<boolean>();
        const saveTranslation = vi.fn(() => first.promise);
        const ui = render({
            translatedView: true,
            context: async () => ({ key: "stored:1", data: SOURCE }),
            saveTranslation,
        });

        await ui.start("edit");
        expect(ui.textarea()!.value).toBe(SOURCE);
        ui.type("Hola world");
        ui.save();
        ui.save();
        await tick();
        expect(saveTranslation).toHaveBeenCalledTimes(1);
        expect(saveTranslation).toHaveBeenCalledWith("Hola world", "stored:1");
        // Still open while the write runs.
        expect(ui.query(".partial-edit-modal")).not.toBeNull();

        ui.cancel();
        expect(ui.query(".partial-edit-modal")).toBeNull();

        await ui.start("edit");
        ui.type("A newer draft");
        first.resolve(true);
        await tick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The first save's completion does not close the editor opened after it.
        expect(ui.query(".partial-edit-modal")).not.toBeNull();
        expect(ui.textarea()!.value).toBe("A newer draft");
        expect(ui.saved).toEqual([]);
    });

    it("keeps the draft open when the write is refused, alerts and keeps it when the callback throws, and closes when it is taken", async () => {
        let outcome: "refuse" | "throw" | "take" = "refuse";
        const saveTranslation = vi.fn(async () => {
            if (outcome === "throw") {
                throw new Error("write exploded");
            }
            return outcome === "take";
        });
        const ui = render({
            translatedView: true,
            context: async () => ({ key: "stored:7", data: SOURCE }),
            saveTranslation,
        });

        await ui.start("edit");
        ui.type("Draft one");
        ui.save();
        await vi.waitFor(() => expect(saveTranslation).toHaveBeenCalledTimes(1));
        await tick();
        expect(ui.query(".partial-edit-modal")).not.toBeNull();
        expect(ui.textarea()!.value).toBe("Draft one");
        expect(alerts.error).not.toHaveBeenCalled();

        outcome = "throw";
        ui.save();
        await vi.waitFor(() => expect(alerts.error).toHaveBeenCalledWith("write exploded"));
        await tick();
        expect(ui.query(".partial-edit-modal")).not.toBeNull();
        expect(ui.textarea()!.value).toBe("Draft one");

        outcome = "take";
        ui.save();
        await vi.waitFor(() => expect(ui.query(".partial-edit-modal")).toBeNull());
        expect(saveTranslation).toHaveBeenCalledTimes(3);
        expect(saveTranslation).toHaveBeenLastCalledWith("Draft one", "stored:7");
        // Taken by the callback: nothing is dispatched.
        expect(ui.saved).toEqual([]);
    });

    it("shows the match failure instead of editing the original when a translated view has no translation context", async () => {
        const saveTranslation = vi.fn(async () => true);
        const ui = render({ translatedView: true, context: async () => null, saveTranslation });
        await ui.start("edit");
        expect(ui.query(".partial-match-failed-modal")).not.toBeNull();
        expect(ui.query(".partial-edit-modal")).toBeNull();
        expect(saveTranslation).not.toHaveBeenCalled();
        expect(ui.saved).toEqual([]);
    });

    it("a delete through the callback ends the confirmation whether the write is taken or refused", async () => {
        const saveTranslation = vi.fn(async () => false);
        const ui = render({
            translatedView: true,
            context: async () => ({ key: "stored:2", data: SOURCE }),
            saveTranslation,
        });
        await ui.start("delete");
        expect(ui.query(".partial-delete-modal")).not.toBeNull();
        ui.query<HTMLButtonElement>(".partial-delete-confirm-btn")!.click();
        await vi.waitFor(() => expect(saveTranslation).toHaveBeenCalledWith("", "stored:2"));
        await vi.waitFor(() => expect(ui.query(".partial-delete-modal")).toBeNull());
        expect(ui.saved).toEqual([]);
    });

    it("without a callback a translation edit is dispatched as `save` with its key and closes, as before", async () => {
        const ui = render({
            translatedView: true,
            context: async () => ({ key: "llm:abc:Hello world", data: SOURCE }),
        });
        await ui.start("edit");
        ui.type("Hola world");
        ui.save();
        await vi.waitFor(() => expect(ui.saved).toHaveLength(1));
        expect(ui.saved[0]).toEqual({
            newData: "Hola world",
            target: "translation",
            translationKey: "llm:abc:Hello world",
        });
        expect(ui.query(".partial-edit-modal")).toBeNull();
    });

    it("an editor closed before its scroll timer runs leaves the timer nothing to do (no error)", async () => {
        const ui = render({ translatedView: false });
        await ui.start("edit", { settle: false });
        ui.cancel();
        expect(ui.query(".partial-edit-modal")).toBeNull();
        // The 10 ms focus timer saw the editor; its 200 ms scroll timer runs after the editor closed.
        // An error thrown there fails the run as an unhandled error.
        await new Promise((resolve) => setTimeout(resolve, 260));
        expect(ui.saved).toEqual([]);
    });

    it("an original edit dispatches `save` on the original and never calls the translation callback", async () => {
        const saveTranslation = vi.fn(async () => true);
        const ui = render({
            translatedView: false,
            context: async () => ({ key: "stored:9", data: "X" }),
            saveTranslation,
        });
        await ui.start("edit");
        expect(ui.textarea()!.value).toBe(SOURCE);
        ui.type("Hello there");
        ui.save();
        await vi.waitFor(() => expect(ui.saved).toHaveLength(1));
        expect(ui.saved[0]).toEqual({ newData: "Hello there", target: "original", translationKey: undefined });
        expect(saveTranslation).not.toHaveBeenCalled();
        expect(ui.query(".partial-edit-modal")).toBeNull();
    });
});

// Occurrence targeting (audit UI-02 and UI-03, `docs/plan/audit-findings-perf.md` slice 2c): two
// identical rendered blocks on one source line are offered as a choice and the chosen one is the one
// edited or deleted; a drag selection ending in a typographic ellipsis edits exactly the selection.
describe("PartialEditController occurrence targeting", () => {
    const TWO_BLOCKS = "<p>Hello</p><p>Hello</p>";
    const second = (bodyRoot: HTMLElement) => bodyRoot.querySelectorAll("p")[1] as HTMLElement;

    it("editing the second of two identical blocks on one line offers both and edits the chosen one", async () => {
        const ui = render({ source: TWO_BLOCKS, html: TWO_BLOCKS, hovered: second });
        await ui.start("edit");
        expect(ui.query(".partial-edit-modal")).toBeNull();
        expect(ui.choices()).toEqual(["Hello", "Hello"]);
        await ui.choose(1);
        expect(ui.textarea()!.value).toBe("Hello");
        ui.type("EDIT");
        ui.save();
        await vi.waitFor(() => expect(ui.saved).toHaveLength(1));
        expect(ui.saved[0].newData).toBe("<p>Hello</p><p>EDIT</p>");
    });

    it("deleting the second of two identical blocks on one line removes the chosen one", async () => {
        const ui = render({ source: TWO_BLOCKS, html: TWO_BLOCKS, hovered: second });
        await ui.start("delete");
        expect(ui.query(".partial-delete-modal")).toBeNull();
        expect(ui.choices()).toHaveLength(2);
        await ui.choose(1);
        expect(ui.query(".partial-delete-modal")).not.toBeNull();
        ui.confirmDelete();
        await vi.waitFor(() => expect(ui.saved).toHaveLength(1));
        // The block's range is its text (the matcher maps rendered text, not tags), so the chosen
        // paragraph is emptied and the first one is untouched.
        expect(ui.saved[0].newData).toBe("<p>Hello</p><p></p>");
    });

    it("a drag selection ending in an ellipsis edits the selection and keeps the character after it", async () => {
        // happy-dom's ranges have no layout; the controller hides the button for a rect without size.
        vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 40, 16));
        const ui = render({ source: "Wait…Next", dragEditEnabled: true });
        await ui.dragStart("Wait…", "edit");
        expect(ui.textarea()!.value).toBe("Wait…");
        ui.type("EDIT");
        ui.save();
        await vi.waitFor(() => expect(ui.saved).toHaveLength(1));
        expect(ui.saved[0].newData).toBe("EDITNext");
    });
});
