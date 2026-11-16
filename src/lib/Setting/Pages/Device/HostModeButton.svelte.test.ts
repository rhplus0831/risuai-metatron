import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("src/ts/network/generationJobs", async () =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock(),
);
vi.mock("src/ts/storage/resourceClient", async () =>
    (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock(),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);

let remoteHost: typeof import("src/ts/network/remoteHost");
let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    remoteHost = await import("src/ts/network/remoteHost");
    const { default: HostModeButton } = await import("./HostModeButton.svelte");
    target = document.createElement("div");
    document.body.append(target);
    component = mount(HostModeButton, { target });
    flushSync();
});

afterEach(async () => {
    await unmount(component);
    target.remove();
    localStorage.clear();
});

it("turns host mode on from its one button and says that the screen locks", () => {
    expect(get(remoteHost.hostMode)).toBe(false);
    expect(target.textContent).toContain("host mode locks its screen");
    const buttons = target.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent?.trim()).toBe("Start Remote Host Mode");
    buttons[0].click();
    flushSync();
    expect(get(remoteHost.hostMode)).toBe(true);
    expect(localStorage.getItem("risu-remote-host")).toBe("true");
});
