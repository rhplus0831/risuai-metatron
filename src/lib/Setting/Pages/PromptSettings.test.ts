// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { installBootRecords } from "src/ts/bootstrap";
import type { PromptItem } from "src/ts/process/prompt";
import { initializeChats, seedChats, selectChat } from "src/ts/storage/chatStore.svelte";
import { readKinds } from "src/ts/storage/resourceClient";
import {
    flushResources,
    noteRemoteChanges,
    seedResources,
    startResourceSync,
    stopResourceSync,
} from "src/ts/storage/resourceSync.svelte";
import { selectCharacter, selectPreset } from "src/ts/storage/selection.svelte";
import { activeMainProfile, activePreset, editedPreset } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { KINDS } from "src/ts/storage/tests/mutationStoresHarness";
import { StoreBackedServer } from "src/ts/storage/tests/storeBackedServer";
import type { botPreset } from "../../../../shared/database.ts";
import PromptSettings from "./PromptSettings.svelte";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
    if (component) await unmount(component);
    target?.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
});

function render(props: { subMenu?: number } = {}) {
    target = document.createElement("div");
    document.body.append(target);
    component = mount(PromptSettings, { target, props });
    flushSync();
    return target;
}

it("recounts both displayed totals after changing the main model with the prompt template unchanged", async () => {
    vi.useFakeTimers();
    const template: PromptItem[] = [
        { type: "plain", type2: "normal", role: "system", text: "Describe the scene." },
        { type: "plain", type2: "normal", role: "system", text: "Continue the story." },
    ];
    installFlatDatabase({
        aiModel: "gpt-3.5-turbo",
        useTokenizerCaching: false,
        promptTemplate: structuredClone(template),
        characters: [],
    });
    activeMainProfile.modelId = "gpt-3.5-turbo";

    const requests: { scope: { aiModel: string }; texts: string[] }[] = [];
    mocks.authFetch.mockImplementation(async (path, init) => {
        expect(path).toBe("/api/tokens/count");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
        requests.push(body);
        return Response.json({ counts: body.texts.map(() => (body.scope.aiModel === "gpt-3.5-turbo" ? 11 : 29)) });
    });

    const target = render();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    // Both totals include the two text items: 2 × the server's count for this model.
    expect(target.textContent).toContain("22 Approximate Tokens");
    expect(target.textContent).toContain("22 Exact Tokens");
    expect(requests.flatMap((request) => request.texts)).toEqual(
        expect.arrayContaining(["Describe the scene.", "Continue the story."]),
    );
    const initialRequests = requests.length;

    activeMainProfile.modelId = "gpt4om";
    flushSync();
    await vi.advanceTimersByTimeAsync(399);
    expect(requests).toHaveLength(initialRequests);
    expect(target.textContent).toContain("22 Approximate Tokens");
    expect(target.textContent).toContain("22 Exact Tokens");
    await vi.advanceTimersByTimeAsync(1);
    // Drain the tokenizer's queued zero-delay request batch.
    await vi.runOnlyPendingTimersAsync();
    flushSync();
    expect(target.textContent).toContain("58 Approximate Tokens");
    expect(target.textContent).toContain("58 Exact Tokens");
    const recounted = requests.slice(initialRequests);
    expect(recounted).not.toHaveLength(0);
    expect(recounted.every((request) => request.scope.aiModel === "gpt4om")).toBe(true);
    expect(recounted.flatMap((request) => request.texts)).toEqual(
        expect.arrayContaining(["Describe the scene.", "Continue the story."]),
    );
    expect(activePreset.promptTemplate).toEqual(template);
});

it("keeps the OOC toggle editor collapsed behind a count of the preset's forced keys", () => {
    mocks.authFetch.mockImplementation(async () => Response.json({ counts: [] }));
    installFlatDatabase({
        customPromptTemplateToggle: "ooc=OOC mode\nstyle=Answer style=select=Brief,Detailed",
        oocToggles: { ooc: "1", retired: "0" },
        characters: [],
    });
    const section = render({ subMenu: 1 }).querySelector("[data-preset-ooc-toggles]")!;
    const header = section.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const headerText = () => header.textContent!.replace(/\s+/g, " ").trim();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // A key the definitions no longer hold is still sent, so it counts.
    expect(headerText()).toBe("OOC session toggles 2 forced");
    expect(section.querySelector("[data-ooc-toggle-editor]")).toBeNull();

    header.click();
    flushSync();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(section.textContent).toContain("These values are forced on the toggles for an OOC session question.");
    const choice = (key: string) => section.querySelector<HTMLSelectElement>(`[data-ooc-toggle="${key}"] select`)!;
    const choose = (key: string, option: number) => {
        choice(key).value = choice(key).options[option].value;
        choice(key).dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
    };
    choose("style", 2);
    expect(editedPreset.oocToggles).toEqual({ ooc: "1", retired: "0", style: "1" });
    expect(headerText()).toBe("OOC session toggles 3 forced");
    choose("ooc", 0);
    choose("style", 0);
    section.querySelector<HTMLButtonElement>('button[aria-label="Remove stale OOC toggle: retired"]')!.click();
    flushSync();
    expect(editedPreset.oocToggles).toEqual({});
    expect(headerText()).toBe("OOC session toggles");
    expect(header.getAttribute("aria-expanded")).toBe("true");
});

it("reorders within a preset and discards a drag when its source preset is deleted", async () => {
    vi.useFakeTimers();
    const server = await StoreBackedServer.create({ feed: true });
    mocks.authFetch.mockImplementation(async (path, init, options) => {
        options?.beforeDispatch?.();
        if (path === "/api/tokens/count") {
            const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
            return Response.json({ counts: texts.map(() => 0) });
        }
        return server.fetch(path, init);
    });

    try {
        server.set(
            "presets",
            "main",
            ["X", "Y"].map((id) => ({
                id,
                name: id,
                promptTemplate: [1, 2, 3].map((row): PromptItem => ({
                    type: "plain",
                    type2: "normal",
                    role: "system",
                    name: `${id}${row}`,
                    text: `${id}${row}`,
                })),
            })),
        );
        server.set("modelPresets", "main", [{ id: "m", name: "Model" }]);
        server.set("personas", "main", [{ id: "u", name: "User" }]);
        server.set("characters", "c", { chaId: "c", type: "character", name: "Character" });
        server.store.applyChanges({
            ops: [],
            chats: [
                {
                    characterId: "c",
                    chatId: "chat",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: "chat",
                                name: "Chat",
                                note: "",
                                message: [],
                                localLore: [],
                                promptPresetId: "X",
                                modelPresetId: "m",
                                bindedPersona: "u",
                            },
                        },
                    ],
                },
            ],
        });
        const snapshot = await readKinds(KINDS, { chats: true });
        seedResources(snapshot);
        seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
        installBootRecords(snapshot);
        initializeChats();
        startResourceSync();
        selectCharacter("c");
        selectChat("c", "chat");
        selectPreset("Y");

        const target = render();
        const handles = () => [...target.querySelectorAll<HTMLElement>('[draggable="true"][style*="cursor"]')];
        const displayedOrder = () => handles().map((handle) => handle.querySelector("span")?.textContent);
        const draggingRows = () => handles().filter((handle) => handle.parentElement?.classList.contains("opacity-50"));
        const savedPresets = () => server.record("presets", "main")!.data as botPreset[];
        const savedOrder = (id: string) =>
            savedPresets()
                .find((preset) => preset.id === id)
                ?.promptTemplate?.map((row) => row.name);

        function startDrag(source: HTMLElement) {
            const dataTransfer = new DataTransfer();
            // happy-dom does not render the native drag image or install the event's data transfer.
            dataTransfer.setDragImage = () => {};
            const dispatch = (target: HTMLElement, type: string) => {
                const event = new DragEvent(type, { bubbles: true, cancelable: true, clientY: 20 });
                Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
                target.dispatchEvent(event);
                flushSync();
            };
            dispatch(source, "dragstart");
            return dispatch;
        }

        expect(activePreset.id).toBe("X");
        expect(displayedOrder()).toEqual(["Y1", "Y2", "Y3"]);
        const refusedDrag = startDrag(handles()[0]);
        expect(draggingRows()).toHaveLength(1);
        selectPreset("X");
        flushSync();
        refusedDrag(handles()[2], "dragover");
        refusedDrag(handles()[2], "drop");
        expect(draggingRows()).toHaveLength(0);

        // Revisit the source without firing dragend, which also clears the drag state.
        selectPreset("Y");
        flushSync();
        expect.soft(draggingRows()).toHaveLength(0);
        const [source, , destination] = handles();
        const drag = startDrag(source);
        expect.soft(displayedOrder()).toEqual(["Y1", "Y2", "Y3"]);
        drag(destination, "dragover");
        drag(destination, "drop");
        drag(source, "dragend");
        await flushResources();
        expect(displayedOrder()).toEqual(["Y2", "Y3", "Y1"]);
        expect(savedOrder("Y")).toEqual(["Y2", "Y3", "Y1"]);

        const staleSource = handles()[0];
        const staleDrag = startDrag(staleSource);
        server.onFeed = (event) => {
            if (event.type === "change") noteRemoteChanges(event.changes);
        };
        server.set(
            "presets",
            "main",
            savedPresets().filter((preset) => preset.id !== "Y"),
        );
        await vi.advanceTimersByTimeAsync(1500);
        flushSync();
        const fallbackOrder = ["X1", "X2", "X3"];
        expect(displayedOrder()).toEqual(fallbackOrder);

        const fallbackDestination = handles()[2];
        staleDrag(fallbackDestination, "dragover");
        expect.soft(displayedOrder()).toEqual(fallbackOrder);
        staleDrag(fallbackDestination, "drop");
        staleDrag(staleSource, "dragend");
        await flushResources();
        expect.soft(displayedOrder()).toEqual(fallbackOrder);
        expect(savedOrder("X")).toEqual(fallbackOrder);
    } finally {
        selectCharacter(null);
        stopResourceSync();
        server.close();
    }
});
