// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({ revision: "secrets-1" }));
vi.mock("src/ts/storage/resourceSync.svelte", async () => {
    const { fromStore, writable } = await import("svelte/store");
    const state = writable(false);
    const reactive = fromStore(state);
    return (await import("src/ts/tests/bootMocks")).createBootMock("resourceSync", {
        saving: {
            get state() {
                return reactive.current;
            },
            set state(value) {
                state.set(value);
            },
        },
        heldRecordRevision: (kind, id) => (kind === "secrets" && id === "main" ? sync.revision : null),
    });
});
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import * as globalApi from "src/ts/globalApi.svelte";
import { applyRaw, setRecordWriteListener } from "src/ts/storage/records.svelte";
import { saving } from "src/ts/storage/resourceSync.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import ImageGenerationSettings from "./ImageGenerationSettings.svelte";

type Lora = { path: string; scale: number };
const initial: Lora[] = [{ path: "owner/initial", scale: 1 }];
const remoteA: Lora[] = [{ path: "owner/remote-a", scale: 0.5 }];
const remoteB: Lora[] = [{ path: "owner/remote-b", scale: 1.5 }];
const mounted: ReturnType<typeof mount>[] = [];
const writes = vi.fn<(loras: Lora[] | undefined) => void>();
const saved = () => {
    const loras = settings.secrets.wavespeedImage.loras;
    return loras === undefined ? undefined : (JSON.parse(JSON.stringify(loras)) as Lora[]);
};
const wavespeed = (loras: Lora[]) => ({
    key: "test-key",
    model: "with-loras",
    reference_mode: "",
    loras: structuredClone(loras),
});

function receive(loras: Lora[], revision: string) {
    sync.revision = revision;
    // Live updates replace the whole secrets record, never assign through the settings view.
    applyRaw("secrets", { wavespeedImage: wavespeed(loras) });
    flushSync();
}

async function render() {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(ImageGenerationSettings, { target }));
    flushSync();
    const button = (name: string) =>
        [...target.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name)!;
    button("Refresh Models").click();
    await tick();
    flushSync();
    const inputs = () => [...target.querySelectorAll<HTMLInputElement>('input[placeholder^="LoRA "]')];
    const sliders = () => [...target.querySelectorAll<HTMLElement>('[role="slider"]')];
    return {
        target,
        button,
        rows: () =>
            inputs()
                .map((input, index) => ({
                    path: input.value,
                    scale: Number(sliders()[index].getAttribute("aria-valuenow")),
                }))
                .filter((row) => row.path !== ""),
        editPath(path: string) {
            inputs()[0].value = path;
            inputs()[0].dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
        },
        increaseScale() {
            sliders()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
            flushSync();
        },
        selectModel(model: string) {
            const select = [...target.querySelectorAll("select")].find((select) =>
                [...select.options].some((option) => option.value === "with-loras"),
            )!;
            select.value = model;
            // happy-dom does not match options with :checked; Svelte's select binding reads it.
            const querySelector = select.querySelector.bind(select);
            (select as { querySelector: unknown }).querySelector = (selector: string) =>
                selector === ":checked" ? (select.options[select.selectedIndex] ?? null) : querySelector(selector);
            try {
                select.dispatchEvent(new Event("change", { bubbles: true }));
            } finally {
                delete (select as { querySelector?: unknown }).querySelector;
            }
            flushSync();
        },
    };
}

beforeEach(() => {
    saving.state = false;
    sync.revision = "secrets-1";
    installFlatDatabase({ characters: [], sdProvider: "wavespeed", wavespeedImage: wavespeed(initial) });
    writes.mockClear();
    setRecordWriteListener((kind) => {
        if (kind === "secrets") writes(saved());
    });
    vi.spyOn(globalApi, "globalFetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers: {},
        data: {
            code: 200,
            data: [
                {
                    model_id: "with-loras",
                    name: "LoRA model",
                    type: "text-to-image",
                    base_price: 1,
                    api_schema: { api_schemas: [{ request_schema: { properties: { loras: {} } } }] },
                },
                { model_id: "without-loras", name: "Plain model", type: "text-to-image", base_price: 1 },
            ],
        },
    });
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    setRecordWriteListener(null);
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe("WaveSpeed LoRA editing", () => {
    it("two clean editors follow alternating remote records without saving on mount or adoption", async () => {
        const first = await render();
        const second = await render();
        expect(first.rows()).toEqual(initial);
        expect(second.rows()).toEqual(initial);
        expect(writes).not.toHaveBeenCalled();

        for (const [index, incoming] of [remoteA, remoteB, remoteA, remoteB].entries()) {
            receive(incoming, `remote-${index}`);
            expect(first.rows()).toEqual(incoming);
            expect(second.rows()).toEqual(incoming);
            expect(first.target.textContent).not.toContain(language.wavespeedLoraConflict);
            expect(second.target.textContent).not.toContain(language.wavespeedLoraConflict);
            expect(saved()).toEqual(incoming);
            expect(writes).not.toHaveBeenCalled();
        }
    });

    it("keeps an unacknowledged draft on conflict, saves the next edit, and loads saved rows without saving", async () => {
        const dirty = await render();
        const clean = await render();
        dirty.editPath("owner/my-draft");
        const draft = [{ path: "owner/my-draft", scale: 1 }];
        expect(writes.mock.calls).toEqual([[draft]]);
        expect(saved()).toEqual(draft);

        for (const [index, incoming] of [remoteA, remoteB].entries()) {
            receive(incoming, `remote-${index}`);
            expect(dirty.rows()).toEqual(draft);
            expect(dirty.target.querySelector('[role="status"]')?.textContent).toContain(
                language.wavespeedLoraConflict,
            );
            expect(dirty.button(language.wavespeedLoraUseSaved)).toBeDefined();
            expect(clean.rows()).toEqual(incoming);
            expect(clean.target.textContent).not.toContain(language.wavespeedLoraConflict);
            expect(saved()).toEqual(incoming);
            expect(writes.mock.calls).toEqual([[draft]]);
        }

        dirty.increaseScale();
        const edited = [{ path: "owner/my-draft", scale: 1.1 }];
        expect(writes.mock.calls).toEqual([[draft], [edited]]);
        expect(saved()).toEqual(edited);
        expect(dirty.target.textContent).not.toContain(language.wavespeedLoraConflict);

        receive(remoteA, "remote-after-edit");
        expect(dirty.rows()).toEqual(edited);
        expect(dirty.target.textContent).toContain(language.wavespeedLoraConflict);
        dirty.button(language.wavespeedLoraUseSaved).click();
        flushSync();
        expect(dirty.rows()).toEqual(remoteA);
        expect(dirty.target.textContent).not.toContain(language.wavespeedLoraConflict);
        expect(saved()).toEqual(remoteA);
        receive(remoteB, "remote-after-load");
        expect(dirty.rows()).toEqual(remoteB);
        expect(clean.rows()).toEqual(remoteB);
        expect(writes.mock.calls).toEqual([[draft], [edited]]);
    });

    it("follows remote LoRAs after its own save is acknowledged by a completed cycle and a new revision", async () => {
        const editor = await render();
        editor.editPath("owner/acknowledged");
        const own = [{ path: "owner/acknowledged", scale: 1 }];
        expect(saved()).toEqual(own);
        saving.state = true;
        flushSync();
        receive(own, "own-save-acknowledged");
        saving.state = false;
        flushSync();

        receive(remoteA, "remote-after-acknowledgement");
        expect(editor.rows()).toEqual(remoteA);
        expect(editor.target.textContent).not.toContain(language.wavespeedLoraConflict);
        expect(saved()).toEqual(remoteA);
        expect(writes.mock.calls).toEqual([[own]]);
    });

    it("resets LoRAs when the user selects a model without LoRA support", async () => {
        const editor = await render();
        expect(saved()).toEqual(initial);
        expect(writes).not.toHaveBeenCalled();
        editor.selectModel("without-loras");
        expect(settings.secrets.wavespeedImage.model).toBe("without-loras");
        expect(settings.secrets.wavespeedImage.loras ?? []).toEqual([]);
        // Returning to a compatible model must not republish the previous rows.
        editor.selectModel("with-loras");
        expect(settings.secrets.wavespeedImage.model).toBe("with-loras");
        expect(editor.rows()).toEqual([]);
        expect(settings.secrets.wavespeedImage.loras ?? []).toEqual([]);
    });
});
