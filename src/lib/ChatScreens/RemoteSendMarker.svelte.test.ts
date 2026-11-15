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

import { replaceConnectedClients } from "src/ts/network/handoff";
import { hostMode } from "src/ts/network/remoteHost";
import { remoteSend, remoteSendHost } from "src/ts/network/remoteSend";
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
    localStorage.clear();
});

it("shows the chosen host's live connection status only while remote sending is on outside host mode", () => {
    const desk = { clientId: "desk", name: "Desk", worker: false, host: true };
    const laptop = { clientId: "laptop", name: "Laptop", worker: false, host: true };
    const marker = () => target.querySelector('[role="status"]');
    replaceConnectedClients([desk, laptop]);
    flushSync();
    expect(target.textContent?.trim()).toBe("");
    expect(marker()).toBeNull();

    remoteSend.set(true);
    flushSync();
    expect(marker()?.textContent?.trim()).toBe("Sends go through Desk · Connected");

    replaceConnectedClients([
        laptop,
        { clientId: "self", name: "Desk", worker: true, host: true },
        { clientId: "worker", name: "Desk", worker: true, host: false },
        { clientId: "different-case", name: "desk", worker: false, host: true },
    ]);
    flushSync();
    expect(marker()?.textContent?.trim()).toBe("Sends go through Desk · Not connected");

    replaceConnectedClients([desk, laptop]);
    flushSync();
    expect(marker()?.textContent?.trim()).toBe("Sends go through Desk · Connected");
    remoteSendHost.set("Laptop");
    flushSync();
    expect(marker()?.textContent?.trim()).toBe("Sends go through Laptop · Connected");
    remoteSendHost.set("Travel");
    flushSync();
    expect(marker()?.textContent?.trim()).toBe("Sends go through Travel · Not connected");

    hostMode.set(true);
    flushSync();
    expect(target.textContent?.trim()).toBe("");
    expect(marker()).toBeNull();
    hostMode.set(false);
    flushSync();
    expect(marker()?.textContent?.trim()).toBe("Sends go through Travel · Not connected");
    remoteSend.set(false);
    flushSync();
    expect(target.textContent?.trim()).toBe("");
    expect(marker()).toBeNull();
});
