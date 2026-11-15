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

it("defaults remote send off and fallback on and writes all three preferences from the controls and Use", () => {
    const checkbox = (label: string) =>
        [...target.querySelectorAll("label")]
            .find((entry) => entry.textContent?.trim() === label)!
            .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const enabled = checkbox("Send through a remote host");
    const fallback = checkbox("Send from this device if the host cannot take the send");
    const hostName = target.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(enabled.checked).toBe(false);
    expect(get(remote.remoteSend)).toBe(false);
    expect(fallback.checked).toBe(true);
    expect(get(remote.remoteSendFallback)).toBe(true);

    enabled.click();
    fallback.click();
    hostName.value = "Offline host";
    hostName.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(get(remote.remoteSend)).toBe(true);
    expect(get(remote.remoteSendFallback)).toBe(false);
    expect(get(remote.remoteSendHost)).toBe("Offline host");

    handoff.replaceConnectedClients([{ clientId: "desk", name: "Desk", worker: false, host: true }]);
    flushSync();
    const use = [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Use")!;
    use.click();
    flushSync();
    expect(get(remote.remoteSendHost)).toBe("Desk");
    expect(hostName.value).toBe("Desk");
    expect(use.getAttribute("aria-pressed")).toBe("true");
});
