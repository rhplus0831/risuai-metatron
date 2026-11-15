import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it } from "vitest";
import { language } from "src/lang";
import { alertWait } from "src/ts/alert";
import { hostMode } from "src/ts/network/remoteHost";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { alertStore } from "src/ts/stores.svelte";
import RemoteHostScreen from "./RemoteHostScreen.svelte";

let root: HTMLDivElement;
let screen: ReturnType<typeof mount>;

const leaveButtons = () =>
    [...root.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === language.serverJob.remoteHost.leave,
    );
const overAlert = () => root.querySelector<HTMLButtonElement>("[data-remote-host-leave-over-alert]");

beforeEach(() => {
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
