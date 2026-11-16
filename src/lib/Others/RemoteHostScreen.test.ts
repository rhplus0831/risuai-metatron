import { flushSync, mount, unmount } from "svelte";
import { get, type Writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { alertWait } from "src/ts/alert";
import { feedConnected } from "src/ts/network/eventFeed";
import { hostMode, noteHostCommand } from "src/ts/network/remoteHost";
import { safeBootOff } from "src/ts/safeBoot";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { alertStore } from "src/ts/stores.svelte";
import RemoteHostScreen from "./RemoteHostScreen.svelte";

vi.mock("src/ts/network/eventFeed", async (importOriginal) => {
    const actual = await importOriginal<typeof import("src/ts/network/eventFeed")>();
    const { writable } = await import("svelte/store");
    return { ...actual, feedConnected: writable(false) };
});
vi.mock("src/ts/safeBoot", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/safeBoot")>()),
    safeBootOff: vi.fn(() => false),
}));

const connected = feedConnected as Writable<boolean>;
let root: HTMLDivElement;
let screen: ReturnType<typeof mount>;

const leaveButtons = () =>
    [...root.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === language.serverJob.remoteHost.leave,
    );
const overAlert = () => root.querySelector<HTMLButtonElement>("[data-remote-host-leave-over-alert]");
const hostScreen = () => root.querySelector<HTMLElement>(":scope > section[data-remote-host-screen]")!;

beforeEach(() => {
    connected.set(false);
    vi.mocked(safeBootOff).mockReturnValue(false);
    installFlatDatabase({ characters: [{ chaId: "c", name: "Character", type: "character" }] });
    hostMode.set(true);
    root = document.createElement("div");
    document.body.append(root);
    screen = mount(RemoteHostScreen, { target: root });
    flushSync();
});
afterEach(async () => {
    alertStore.clearStatus();
    await unmount(screen);
    root.remove();
    hostMode.set(false);
});

it("has one leave control, inside the lock, while no alert is shown", () => {
    const lock = root.querySelector('[aria-labelledby="remote-host-title"]')!;
    expect(leaveButtons()).toHaveLength(1);
    expect(lock.contains(leaveButtons()[0])).toBe(true);
    expect(overAlert()).toBeNull();
    leaveButtons()[0].click();
    expect(get(hostMode)).toBe(false);
});

it("keeps a leave control above the alert layer while a status overlay covers the lock", () => {
    // A `wait` overlay has no button and paints at layer 1100, over the lock at 1050.
    alertWait("working");
    flushSync();
    const lock = root.querySelector('[aria-labelledby="remote-host-title"]')!;
    const leave = overAlert()!;
    expect(leave).not.toBeNull();
    expect(lock.contains(leave)).toBe(false);
    expect(leave.classList.contains("fixed")).toBe(true);
    expect(leave.classList.contains("z-1110")).toBe(true);
    leave.click();
    expect(get(hostMode)).toBe(false);
    // Leaving answers and discards nothing: the status is still its producer's to clear.
    expect(get(alertStore).type).toBe("wait");
    alertStore.clearStatus();
    flushSync();
    expect(overAlert()).toBeNull();
});

it("marks the root and exposes feed connection changes as boolean strings", () => {
    const lock = hostScreen();
    expect(lock).not.toBeNull();
    expect(lock.getAttribute("data-feed-connected")).toBe("false");

    connected.set(true);
    flushSync();
    expect(lock.getAttribute("data-feed-connected")).toBe("true");

    connected.set(false);
    flushSync();
    expect(lock.getAttribute("data-feed-connected")).toBe("false");
});

it("exposes queued dialogs, including between dialogs, without treating status as a dialog", () => {
    const lock = hostScreen();
    expect(lock.getAttribute("data-dialogs")).toBe("false");
    alertWait("working");
    flushSync();
    expect(lock.getAttribute("data-dialogs")).toBe("false");

    vi.useFakeTimers();
    const first = alertStore.open({ type: "normal", msg: "First dialog" });
    const queued = alertStore.open({ type: "normal", msg: "Queued dialog" });
    try {
        flushSync();
        expect(lock.getAttribute("data-dialogs")).toBe("true");

        first.cancel();
        flushSync();
        expect(lock.getAttribute("data-dialogs")).toBe("true");

        queued.cancel();
        flushSync();
        expect(lock.getAttribute("data-dialogs")).toBe("false");
    } finally {
        first.cancel();
        queued.cancel();
        vi.runAllTimers();
        vi.useRealTimers();
    }
});

it("exposes whether safe boot disabled plugins for the page load", async () => {
    expect(hostScreen().getAttribute("data-plugins-off")).toBe("false");

    await unmount(screen);
    vi.mocked(safeBootOff).mockImplementation((category) => category === "plugins");
    screen = mount(RemoteHostScreen, { target: root });
    flushSync();
    expect(hostScreen().getAttribute("data-plugins-off")).toBe("true");
});

it("exposes each command's fields and omits the code attribute when no code is present", () => {
    noteHostCommand({
        commandId: "dom-command-with-code",
        type: "send",
        state: "refused",
        code: "host_off",
        at: 1,
    });
    noteHostCommand({
        commandId: "dom-command-without-code",
        type: "reload",
        state: "running",
        at: 2,
    });
    flushSync();

    const lock = hostScreen();
    const codedRows = lock.querySelectorAll('li[data-command-id="dom-command-with-code"]');
    expect(codedRows).toHaveLength(1);
    expect(codedRows[0].getAttribute("data-command-type")).toBe("send");
    expect(codedRows[0].getAttribute("data-command-state")).toBe("refused");
    expect(codedRows[0].getAttribute("data-command-code")).toBe("host_off");

    const uncodedRows = lock.querySelectorAll('li[data-command-id="dom-command-without-code"]');
    expect(uncodedRows).toHaveLength(1);
    expect(uncodedRows[0].getAttribute("data-command-type")).toBe("reload");
    expect(uncodedRows[0].getAttribute("data-command-state")).toBe("running");
    expect(uncodedRows[0].hasAttribute("data-command-code")).toBe(false);
});
