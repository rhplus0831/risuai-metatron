// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryReceipt } from "../../../shared/structuredMemory.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

import { runServerJob } from "src/ts/process/serverCommands";
import { resetMemoryTasks, noteMemoryTaskFrame } from "src/ts/process/memoryTasks.svelte";
import { findCharacter, type AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import { patchMessage } from "src/ts/storage/chatStore.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import MemoryReceiptLine from "./MemoryReceiptLine.svelte";

const ref = { chaId: "c", chatId: "k" };
let target: HTMLElement;
const mounted: ReturnType<typeof mount>[] = [];
const receipt = (extra: Partial<MemoryReceipt>): MemoryReceipt => ({
    state: "recorded",
    pages: [],
    refused: [],
    unverified: [],
    warnings: [],
    ...extra,
});
const patch = (memory: MemoryReceipt) => {
    patchMessage(ref, "a2", { generationInfo: { memory } });
    flushSync();
};
const button = (text: string) =>
    [...target.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text)!;

beforeEach(() => {
    vi.useFakeTimers();
    resetMemoryTasks();
    vi.mocked(runServerJob).mockClear();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "group",
                name: "Group",
                chatPage: 0,
                chats: [
                    {
                        id: "k",
                        name: "Chat",
                        message: [
                            { chatId: "a1", role: "char", data: "Old reply" },
                            { chatId: "a2", role: "char", data: "Newest reply" },
                        ],
                    },
                ],
            },
        ],
    } as any);
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component)));
    document.body.replaceChildren();
    resetMemoryTasks();
    vi.useRealTimers();
});
function render(messageId = "a2", idx = 1) {
    const props = $state({
        chatRef: ref,
        messageId,
        idx,
        locked: false,
        owner: findCharacter("c")! as AnyClientCharacter,
    });
    mounted.push(mount(MemoryReceiptLine, { target, props }));
    flushSync();
    return props;
}

it("updates a held message's collapsible receipt without remounting and names the slot or trigger needing the tab", () => {
    render();
    expect(target.textContent).toContain("No memory receipt yet");
    patch(
        receipt({
            eventId: "event",
            model: "writer-model",
            inputTokens: 12,
            outputTokens: 7,
            warnings: [{ kind: "unknown", detail: "Check this evidence" }],
        }),
    );
    expect(target.textContent).toContain("Recorded: 1 event");
    expect(target.textContent).not.toContain("writer-model");
    const toggle = target.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    flushSync();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(target.textContent).toContain("writer-model");
    expect(target.textContent).toContain("Check this evidence");
    expect(target.textContent).toContain("Tokens: 12 in, 7 out");
    toggle.click();
    flushSync();
    expect(target.textContent).not.toContain("Check this evidence");
    for (const [reason, label] of [
        ["pluginModel", "memory model is a plugin model"],
        ["requestTrigger", "request trigger applies"],
    ]) {
        patch(receipt({ state: "notAutomatic", reason }));
        expect(target.textContent).toContain("Not recording automatically");
        expect(target.textContent).toContain(label);
        expect(target.textContent).toContain("needs this tab");
    }
    patch(receipt({ state: "failed", reason: "requestFailed" }));
    expect(target.textContent).toContain("Not recorded: the model request failed");
});

it("records the newest message or resumes the chat through a job, and disables recording while the task or generation owns it", async () => {
    render("a1", 0);
    expect(target.textContent).toBe("");
    const props = render();
    button("Record now").click();
    await tick();
    expect(runServerJob).toHaveBeenLastCalledWith(findCharacter("c"), ref, {
        kind: "command",
        command: { type: "memoryRecord", messageId: "a2" },
        label: "memoryRecord",
        context: { mode: "manual" },
    });
    props.locked = true;
    flushSync();
    expect(button("Record now").disabled).toBe(true);
    props.locked = false;
    noteMemoryTaskFrame({
        type: "memoryTask",
        epoch: "e",
        characterId: "c",
        chatId: "k",
        status: { kind: "structuredMemory", taskId: "task", state: "running", done: 0, total: 1 },
    });
    flushSync();
    expect(target.textContent).toContain("The memory writer is working in this chat");
    expect(target.querySelectorAll("[data-memory-receipt]")).toHaveLength(1);
    expect(button("Record now").disabled).toBe(true);
    resetMemoryTasks();
    patch(receipt({ state: "skipped", reason: "writerPaused" }));
    expect(target.textContent).toContain("Recording is paused");
    button("Resume").click();
    await tick();
    expect(runServerJob).toHaveBeenLastCalledWith(findCharacter("c"), ref, {
        kind: "command",
        command: { type: "memoryRecord" },
        label: "memoryRecord",
        context: { mode: "manual" },
    });
});
