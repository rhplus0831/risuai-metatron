import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
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

let remote: typeof import("src/ts/network/remoteSend");
let handoff: typeof import("src/ts/network/handoff");
let target: HTMLDivElement;
let component: ReturnType<typeof mount>;

beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    remote = await import("src/ts/network/remoteSend");
    handoff = await import("src/ts/network/handoff");
    const { default: RemoteHostControls } = await import("./RemoteHostControls.svelte");
    target = document.createElement("div");
    document.body.append(target);
    component = mount(RemoteHostControls, { target });
    flushSync();
});

afterEach(async () => {
    await unmount(component);
    target.remove();
    handoff.replaceConnectedClients([]);
    localStorage.clear();
});

it("lists connected hosts by name with tab counts, excludes this tab and non-hosts, and shows an empty list message", () => {
    handoff.replaceConnectedClients([
        { clientId: "self", name: "This tab", worker: true, host: true },
        { clientId: "desk-a", name: "Desk", worker: false, host: true },
        { clientId: "desk-b", name: "Desk", worker: true, host: true },
        { clientId: "desk-worker", name: "Desk", worker: true, host: false },
        { clientId: "phone", name: "Phone", worker: true },
        { clientId: "laptop", name: "Laptop", worker: false, host: true },
    ]);
    flushSync();
    expect([...target.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent?.trim()).sort()).toEqual([
        "Desk (2 tabs)",
        "Laptop",
    ]);
    expect(target.textContent).not.toContain("No hosts connected.");

    handoff.replaceConnectedClients([
        { clientId: "self", name: "This tab", worker: true, host: true },
        { clientId: "phone", name: "Phone", worker: true },
    ]);
    flushSync();
    expect(target.querySelectorAll("li")).toHaveLength(0);
    expect(target.textContent).toContain("No hosts connected.");
});

it("defaults remote send off and fallback on, and writes the switches and the host chosen with Use", () => {
    const checkbox = (label: string) =>
        [...target.querySelectorAll("label")]
            .find((entry) => entry.textContent?.trim() === label)!
            .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const enabled = checkbox("Send through a remote host");
    const fallback = checkbox("Send from this device if the host cannot take the send");
    expect(enabled.checked).toBe(false);
    expect(get(remote.remoteSend)).toBe(false);
    expect(fallback.checked).toBe(true);
    expect(get(remote.remoteSendFallback)).toBe(true);
    // The host is chosen from the list only: no field takes a typed name.
    expect(target.querySelector('input[type="text"]')).toBeNull();

    enabled.click();
    fallback.click();
    flushSync();
    expect(get(remote.remoteSend)).toBe(true);
    expect(get(remote.remoteSendFallback)).toBe(false);

    handoff.replaceConnectedClients([{ clientId: "desk", name: "Desk", worker: false, host: true }]);
    flushSync();
    const use = [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Use")!;
    expect(use.getAttribute("aria-pressed")).toBe("false");
    use.click();
    flushSync();
    expect(get(remote.remoteSendHost)).toBe("Desk");
    expect(use.getAttribute("aria-pressed")).toBe("true");
});

it("keeps a chosen host that is not connected in its own row, which Clear empties", () => {
    const awayRow = () => target.querySelector<HTMLLIElement>("[data-away-host]");
    // No name chosen: nothing to keep, and the empty name is not shown as an absent host.
    expect(awayRow()).toBeNull();
    expect(target.textContent).toContain("No hosts connected.");

    remote.remoteSendHost.set("Desk");
    flushSync();
    expect(awayRow()?.firstElementChild?.textContent?.trim()).toBe("Desk · Not connected");
    expect(target.textContent).not.toContain("No hosts connected.");

    // Connected again: its ordinary row carries the choice, and the absent row goes.
    handoff.replaceConnectedClients([{ clientId: "desk", name: "Desk", worker: false, host: true }]);
    flushSync();
    expect(awayRow()).toBeNull();
    expect(target.querySelectorAll("li")).toHaveLength(1);

    // Another host connected instead: both rows show, and Clear drops only the remembered name.
    handoff.replaceConnectedClients([{ clientId: "laptop", name: "Laptop", worker: false, host: true }]);
    flushSync();
    expect(target.querySelectorAll("li")).toHaveLength(2);
    awayRow()!.querySelector("button")!.click();
    flushSync();
    expect(get(remote.remoteSendHost)).toBe("");
    expect(awayRow()).toBeNull();
    expect(target.querySelectorAll("li")).toHaveLength(1);
});
