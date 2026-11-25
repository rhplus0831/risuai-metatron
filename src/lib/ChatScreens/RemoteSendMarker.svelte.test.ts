import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("src/ts/network/generationJobs", async () =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "self",
    }),
);
vi.mock("src/ts/storage/resourceClient", async () =>
    (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock(),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);

import { get } from "svelte/store";
import { replaceConnectedClients } from "src/ts/network/handoff";
import { hostMode } from "src/ts/network/remoteHost";
import { remoteSend, remoteSendHost } from "src/ts/network/remoteSend";
import { currentJump, finishJump } from "src/ts/setting/settingJump.svelte";
import { DEVICE_LINK_SETTINGS_MENU } from "src/ts/settingsMenu";
import { SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
import RemoteSendMarker from "./RemoteSendMarker.svelte";

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

beforeEach(() => {
    hostMode.set(false);
    remoteSend.set(false);
    remoteSendHost.set("Desk");
    replaceConnectedClients([]);
    target = document.createElement("div");
    document.body.append(target);
    component = mount(RemoteSendMarker, { target });
    flushSync();
});

afterEach(async () => {
    await unmount(component);
    target.remove();
    hostMode.set(false);
    remoteSend.set(false);
    remoteSendHost.set("");
    replaceConnectedClients([]);
    const jump = currentJump();
    if (jump) finishJump(jump.version);
    settingsOpen.set(false);
    SettingsMenuIndex.set(-1);
    localStorage.clear();
});

/** The marker as a reader meets it: the button's name, then the visible host and state words. */
function shown() {
    const marker = target.querySelector('[role="status"]');
    if (!marker) return null;
    return {
        state: marker.getAttribute("data-remote-send-marker"),
        name: marker.querySelector(".sr-only")?.textContent,
        title: marker.querySelector("button")?.title,
        host: marker.querySelector("[data-remote-send-marker-host]")?.textContent,
        words: marker.querySelector("[data-remote-send-marker-state]")?.textContent?.trim() ?? null,
    };
}
const connectedTo = (host: string) => ({
    state: "connected",
    name: `Sends go through ${host} · Connected`,
    title: `Sends go through ${host} · Connected`,
    host,
    words: null,
});
const awayFrom = (host: string) => ({
    state: "disconnected",
    name: `Sends go through ${host} · Not connected`,
    title: `Sends go through ${host} · Not connected`,
    host,
    words: "· Not connected",
});

it("shows the chosen host's live connection status only while remote sending is on outside host mode", () => {
    const desk = { clientId: "desk", name: "Desk", worker: false, host: true };
    const laptop = { clientId: "laptop", name: "Laptop", worker: false, host: true };
    replaceConnectedClients([desk, laptop]);
    flushSync();
    expect(target.textContent?.trim()).toBe("");
    expect(shown()).toBeNull();

    remoteSend.set(true);
    flushSync();
    expect(shown()).toEqual(connectedTo("Desk"));

    replaceConnectedClients([
        laptop,
        { clientId: "self", name: "Desk", worker: true, host: true },
        { clientId: "worker", name: "Desk", worker: true, host: false },
        { clientId: "different-case", name: "desk", worker: false, host: true },
    ]);
    flushSync();
    expect(shown()).toEqual(awayFrom("Desk"));

    replaceConnectedClients([desk, laptop]);
    flushSync();
    expect(shown()).toEqual(connectedTo("Desk"));
    remoteSendHost.set("Laptop");
    flushSync();
    expect(shown()).toEqual(connectedTo("Laptop"));
    remoteSendHost.set("Travel");
    flushSync();
    expect(shown()).toEqual(awayFrom("Travel"));

    hostMode.set(true);
    flushSync();
    expect(target.textContent?.trim()).toBe("");
    expect(shown()).toBeNull();
    hostMode.set(false);
    flushSync();
    expect(shown()).toEqual(awayFrom("Travel"));
    remoteSend.set(false);
    flushSync();
    expect(target.textContent?.trim()).toBe("");
    expect(shown()).toBeNull();
});

it("names an unnamed host and opens the remote host section of Device Link when pressed", () => {
    remoteSendHost.set("");
    remoteSend.set(true);
    flushSync();
    expect(shown()).toEqual(awayFrom("Unnamed host"));

    target.querySelector("button")?.click();
    expect(get(settingsOpen)).toBe(true);
    expect(get(SettingsMenuIndex)).toBe(DEVICE_LINK_SETTINGS_MENU);
    expect(currentJump()).toMatchObject({ kind: "section", sectionId: "deviceLink.remoteHost", available: true });
});
