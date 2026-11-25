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

import { changeLanguage, language } from "src/lang";
import { alertError } from "src/ts/alert";
import * as globalApi from "src/ts/globalApi.svelte";
import * as util from "src/ts/util";
import { applyRaw, recordData, setRecordWriteListener } from "src/ts/storage/records.svelte";
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

function mountPage() {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(ImageGenerationSettings, { target }));
    flushSync();
    return target;
}

async function render() {
    const target = mountPage();
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
    vi.useRealTimers();
});

describe("NovelAI image models", () => {
    const legacyModel = "nai-diffusion-2";

    beforeEach(() => {
        installFlatDatabase({
            characters: [],
            sdProvider: "novelai",
            NAIImgModel: legacyModel,
            NAIImgConfig: { sampler: "k_euler_ancestral", noise_schedule: "karras", reference_mode: "" },
        });
    });

    it("offers the V5 Full Medium model and omits the V2 model", () => {
        const target = mountPage();
        const modelSelect = [...target.querySelectorAll("select")].find((select) =>
            [...select.options].some((option) => option.value.startsWith("nai-diffusion-")),
        );
        expect(modelSelect, "NovelAI model select").toBeDefined();
        const options = [...modelSelect!.options].map((option) => option.value);
        expect.soft(options).toContain("nai-diffusion-5-full-medium");
        expect(options).not.toContain(legacyModel);
    });

    it("keeps a stored V2 model when the page opens", async () => {
        const recordWrites = vi.fn();
        setRecordWriteListener(recordWrites);

        mountPage();
        await tick();

        expect(settings.memoryTranslateMedia.NAIImgModel).toBe(legacyModel);
        expect(recordData("memoryTranslateMedia")).toHaveProperty("NAIImgModel", legacyModel);
        expect(recordWrites).not.toHaveBeenCalledWith("memoryTranslateMedia");
    });
});

describe("ComfyUI workflow upload", () => {
    const originalWorkflow = '{\n  "1": { "class_type": "SaveImage" }\n}';

    beforeEach(() => {
        changeLanguage("ko");
        vi.mocked(alertError).mockClear();
        installFlatDatabase({
            characters: [],
            sdProvider: "comfyui",
            comfyConfig: { workflow: originalWorkflow, timeout: 30 },
        });
    });

    afterEach(() => changeLanguage("en"));

    async function uploadWorkflow(text: string | null) {
        const target = mountPage();
        const workflow = target.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${language.comfyWorkflow}"]`);
        const upload = [...target.querySelectorAll("button")].find((button) => {
            const name = button.getAttribute("aria-label") || button.textContent?.trim() || button.title;
            return name === language.comfyWorkflowUpload;
        });
        expect(workflow?.value, "textarea with the translated workflow label").toBe(originalWorkflow);
        expect(upload, "button with the workflow upload name").toBeDefined();
        expect(workflow!.compareDocumentPosition(upload!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        const picker = vi
            .spyOn(util, "selectSingleFile")
            .mockResolvedValueOnce(
                text === null ? null : { name: "workflow.json", data: new TextEncoder().encode(text) },
            );
        upload!.click();
        await tick();
        flushSync();

        expect(picker).toHaveBeenCalledExactlyOnceWith(["json"]);
        return workflow!;
    }

    it("imports valid UTF-8 JSON into the workflow textarea and stores the original text", async () => {
        const fileText = '{\n    "3": { "class_type" : "CLIPTextEncode", "inputs": { "text": "밤하늘" } }\n}\n';

        const workflow = await uploadWorkflow(fileText);

        expect(workflow.value).toBe(fileText);
        expect(settings.memoryTranslateMedia.comfyConfig.workflow).toBe(fileText);
        expect(recordData("memoryTranslateMedia")).toHaveProperty("comfyConfig.workflow", fileText);
        expect(alertError).not.toHaveBeenCalled();
    });

    it("alerts on invalid JSON and keeps the previous workflow", async () => {
        const workflow = await uploadWorkflow('{ "1": }');

        expect(alertError).toHaveBeenCalledExactlyOnceWith(language.comfyWorkflowInvalidJson);
        expect(workflow.value).toBe(originalWorkflow);
        expect(settings.memoryTranslateMedia.comfyConfig.workflow).toBe(originalWorkflow);
        expect(recordData("memoryTranslateMedia")).toHaveProperty("comfyConfig.workflow", originalWorkflow);
    });

    it("keeps the workflow and raises no alert when the picker is cancelled", async () => {
        const workflow = await uploadWorkflow(null);

        expect(alertError).not.toHaveBeenCalled();
        expect(workflow.value).toBe(originalWorkflow);
        expect(settings.memoryTranslateMedia.comfyConfig.workflow).toBe(originalWorkflow);
        expect(recordData("memoryTranslateMedia")).toHaveProperty("comfyConfig.workflow", originalWorkflow);
    });
});

it.each(["upload", "model change"] as const)(
    "stores finite NovelAI vibe information and preserves the previous value for malformed information on %s",
    async (action) => {
        vi.useFakeTimers();
        const cases = [
            { model: "v4curated", information: "0.25", expected: 0.25 },
            { model: "v4-5full", information: "not-a-number", expected: 0.25 },
            { model: "v4-5curated", information: "Infinity", expected: 0.25 },
            { model: "v4full", information: 0.75, expected: 0.75 },
        ];
        const encodings = (information: string | number) => ({
            first: { params: { information_extracted: information } },
            second: { params: { information_extracted: 0.99 } },
        });
        const vibe = {
            version: 1,
            identifier: "novelai-vibe-transfer",
            thumbnail: "data:image/png;base64,AA==",
            encodings: Object.fromEntries(cases.map(({ model, information }) => [model, encodings(information)])),
        };
        installFlatDatabase({
            characters: [],
            sdProvider: "novelai",
            NAIImgModel: "nai-diffusion-4-full",
            NAIImgConfig: {
                reference_mode: "vibe",
                InfoExtracted: 0.65,
                reference_strength_multiple: [0.7],
                ...(action === "model change" ? { vibe_data: vibe, vibe_model_selection: "v4full" } : {}),
            },
        });
        const target = document.createElement("div");
        document.body.append(target);
        mounted.push(mount(ImageGenerationSettings, { target }));
        flushSync();
        const picker = vi.spyOn(util, "selectSingleFile");

        for (const { model, information, expected } of cases) {
            if (action === "upload") {
                picker.mockResolvedValueOnce({
                    name: "reference.naiv4vibe",
                    data: new TextEncoder().encode(
                        JSON.stringify({ ...vibe, encodings: { v4full: encodings(information) } }),
                    ),
                });
                const upload = [...target.querySelectorAll("button")].find(
                    (button) =>
                        button.querySelector('img[alt="Vibe Preview"]') || button.textContent?.includes("Upload"),
                )!;
                upload.click();
                await tick();
            } else {
                const select = [...target.querySelectorAll("select")].find((node) =>
                    [...node.options].some((option) => option.value === "v4full"),
                )!;
                select.value = model;
                // happy-dom does not match :checked, which Svelte's native select binding reads.
                const querySelector = select.querySelector.bind(select);
                (select as { querySelector: unknown }).querySelector = (selector: string) =>
                    selector === ":checked" ? (select.options[select.selectedIndex] ?? null) : querySelector(selector);
                try {
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                } finally {
                    delete (select as { querySelector?: unknown }).querySelector;
                }
            }
            flushSync();
            const config = settings.memoryTranslateMedia.NAIImgConfig;
            expect(config.InfoExtracted, `${action}: ${information}`).toBe(expected);
            expect(JSON.parse(JSON.stringify(config)).InfoExtracted).toBe(expected);
            expect(config.vibe_model_selection).toBe(action === "upload" ? "v4full" : model);
        }
    },
);

it("offers only finite uploaded vibe strengths and refuses an injected invalid selection", async () => {
    installFlatDatabase({
        characters: [],
        sdProvider: "novelai",
        NAIImgModel: "nai-diffusion-4-full",
        NAIImgConfig: { reference_mode: "vibe", InfoExtracted: 0.65, reference_strength_multiple: [0.7] },
    });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(ImageGenerationSettings, { target }));
    flushSync();
    const vibe = {
        version: 1,
        identifier: "novelai-vibe-transfer",
        thumbnail: "data:image/png;base64,AA==",
        encodings: {
            v4full: {
                first: { params: { information_extracted: 0.25 }, encoding: "first" },
                overflow: { params: { information_extracted: "overflow" }, encoding: "retained" },
                second: { params: { information_extracted: 0.5 }, encoding: "second" },
            },
        },
    };
    vi.spyOn(util, "selectSingleFile").mockResolvedValueOnce({
        name: "reference.naiv4vibe",
        data: new TextEncoder().encode(JSON.stringify(vibe).replace('"overflow"}', "1e400}")),
    });
    [...target.querySelectorAll("button")].find((button) => button.textContent?.includes("Upload"))!.click();
    await tick();
    flushSync();
    const config = settings.memoryTranslateMedia.NAIImgConfig;
    const select = [...target.querySelectorAll("select")].find((node) =>
        [...node.options].some((option) => option.value === "0.25"),
    )!;
    expect(config.InfoExtracted).toBe(0.25);
    expect(select.value).toBe("0.25");
    expect.soft([...select.options].map((option) => option.value)).toEqual(["0.25", "0.5"]);
    expect(Object.keys(config.vibe_data.encodings.v4full)).toEqual(["first", "overflow", "second"]);
    expect(config.vibe_data.encodings.v4full.overflow.encoding).toBe("retained");
    expect(config.vibe_data.encodings.v4full.overflow.params.information_extracted).toBe(Infinity);

    function choose(value: string) {
        select.value = value;
        // Match the native selected option for Svelte's binding in happy-dom.
        const querySelector = select.querySelector.bind(select);
        (select as { querySelector: unknown }).querySelector = (selector: string) =>
            selector === ":checked" ? select.options[select.selectedIndex] : querySelector(selector);
        try {
            select.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
            delete (select as { querySelector?: unknown }).querySelector;
        }
        flushSync();
    }
    choose("0.5");
    expect(config.InfoExtracted).toBe(0.5);
    const invalid = document.createElement("option");
    invalid.value = "Infinity";
    select.append(invalid);
    choose("Infinity");
    expect(config.InfoExtracted).toBe(0.5);
    expect(JSON.parse(JSON.stringify(config)).InfoExtracted).toBe(0.5);
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
