// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { alertError, alertMd } from "src/ts/alert";
import { findChat, selectChat, setChatMeta } from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selectPersona } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import DevTool from "./DevTool.svelte";

const mocks = vi.hoisted(() => ({
    serverSend: vi.fn<typeof import("src/ts/process/serverGeneration").sendChatOnServer>(),
}));
vi.mock("src/ts/process/serverGeneration", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/process/serverGeneration")>()),
    sendChatOnServer: mocks.serverSend,
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
    if (component) await unmount(component);
    target?.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
});

it("renders instruct preview with the starting chat's character and user after switching chats", async () => {
    vi.useFakeTimers();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c1",
                type: "character",
                name: "Luna",
                chats: [{ id: "k1", name: "First chat", bindedPersona: "p1", message: [] }],
            },
            {
                chaId: "c2",
                type: "character",
                name: "Sol",
                chats: [{ id: "k2", name: "Second chat", bindedPersona: "p2", message: [] }],
            },
        ],
        personas: [
            { id: "p1", name: "Alice", icon: "", note: "", personaPrompt: "" },
            { id: "p2", name: "Bob", icon: "", note: "", personaPrompt: "" },
        ],
    });
    // The tab's persona differs from the first chat's binding.
    selectPersona("p2");
    selectCharacter("c1");
    selectChat("c1", "k1");

    type ServerResult = Awaited<ReturnType<typeof mocks.serverSend>>;
    let complete!: (result: ServerResult) => void;
    mocks.serverSend.mockReturnValue(new Promise<ServerResult>((resolve) => (complete = resolve)));

    target = document.createElement("div");
    document.body.append(target);
    component = mount(DevTool, { target });
    flushSync();
    [...target.querySelectorAll("button")].find((button) => button.textContent.trim() === "Preview Prompt")!.click();
    flushSync();
    const select = (option: string, value: string) => {
        const input = [...target!.querySelectorAll("select")].find((input) =>
            [...input.options].some((item) => item.value === option),
        )!;
        input.value = value;
        // happy-dom does not match :checked for options; Svelte reads it on change.
        const querySelector = input.querySelector.bind(input);
        (input as { querySelector: unknown }).querySelector = (selector: string) =>
            selector === ":checked" ? (input.options[input.selectedIndex] ?? null) : querySelector(selector);
        input.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
    };
    select("instruct", "instruct");
    select("jinja", "jinja");
    const template = target.querySelector("textarea")!;
    template.value = "{{ risu_char }} speaks to {{ risu_user }}: {{ messages[0]['content'] }}";
    template.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    [...target.querySelectorAll("button")].find((button) => button.textContent.trim() === "Run")!.click();
    expect(mocks.serverSend).toHaveBeenCalledExactlyOnceWith({
        preview: true,
        target: { chaId: "c1", chatId: "k1" },
    });
    expect(alertMd).not.toHaveBeenCalled();

    selectCharacter("c2");
    selectChat("c2", "k2");
    flushSync();
    complete({
        ok: true,
        outcome: "started",
        settled: true,
        result: { messages: [{ role: "user", content: "Hello." }], context: undefined },
    });
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    expect(alertMd).toHaveBeenCalledExactlyOnceWith("### Instruction\n```\nLuna speaks to Alice: Hello.\n```\n");
});

it("autopilot appends nothing while the chat has orphaned lore overrides, and checks again before each line", async () => {
    installFlatDatabaseWithChats({
        characters: [
            { chaId: "c1", type: "character", name: "Luna", chats: [{ id: "k1", name: "Chat", message: [] }] },
        ],
    });
    selectCharacter("c1");
    selectChat("c1", "k1");
    const ref = { chaId: "c1", chatId: "k1" };
    // An override whose owner entry is gone (the character has no lore).
    setChatMeta(ref, {
        loreOverrides: [{ entry: { id: "gone", key: "", comment: "Gone entry", content: "" }, off: false }],
    });
    mocks.serverSend.mockResolvedValue({ ok: true, outcome: "started", settled: true });

    target = document.createElement("div");
    document.body.append(target);
    component = mount(DevTool, { target });
    flushSync();
    [...target.querySelectorAll("button")].find((button) => button.textContent.trim() === "Autopilot")!.click();
    flushSync();
    const plus = target.querySelector(".lucide-plus")!.closest("button")!;
    plus.click();
    plus.click();
    flushSync();
    const lines = [...target.querySelectorAll("textarea")];
    expect(lines).toHaveLength(2);
    for (const [index, text] of ["hello", "again"].entries()) {
        lines[index].value = text;
        lines[index].dispatchEvent(new Event("input", { bubbles: true }));
    }
    flushSync();
    const run = () =>
        [...target!.querySelectorAll("button")].find((button) => button.textContent.trim() === "Run")!.click();

    run();
    await vi.waitFor(() => expect(alertError).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertError).mock.calls[0][0]).toContain("Gone entry");
    expect(findChat(ref)!.message).toEqual([]);
    expect(mocks.serverSend).not.toHaveBeenCalled();

    // Without the orphan the run appends its first line; an orphan made during that line's send
    // refuses the second before it is appended.
    setChatMeta(ref, { loreOverrides: [] });
    mocks.serverSend.mockImplementationOnce(async () => {
        setChatMeta(ref, {
            loreOverrides: [{ entry: { id: "gone", key: "", comment: "Gone entry", content: "" }, off: false }],
        });
        return { ok: true, outcome: "started", settled: true };
    });
    run();
    await vi.waitFor(() => expect(alertError).toHaveBeenCalledTimes(2));
    expect(mocks.serverSend).toHaveBeenCalledTimes(1);
    expect(findChat(ref)!.message.map((message) => message.data)).toEqual(["hello"]);
});
