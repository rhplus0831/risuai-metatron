import { flushSync, mount, unmount } from "svelte";
import { get, type Writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
    request: vi.fn<typeof import("src/ts/network/generationJobs").requestGenerationHandoff>(),
    takeover: vi.fn<typeof import("src/ts/network/generationJobs").takeoverGenerationJob>(),
    follow: vi.fn<typeof import("src/ts/process/serverCommands").followJobToEnd>(),
}));
vi.mock("src/ts/network/generationJobs", async () =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "self",
        savedGenerationJobIds: () => ["own-job"],
        requestGenerationHandoff: stubs.request,
        takeoverGenerationJob: stubs.takeover,
    }),
);
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock({
        followJobToEnd: stubs.follow,
    }),
);
vi.mock("src/ts/storage/resourceClient", async () =>
    (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock({
        getResourceEpoch: () => "epoch",
    }),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);
vi.mock("src/ts/plugins/plugins.svelte", async () =>
    (await import("src/ts/tests/bootMocks")).createBootMock("plugins", { pluginsStarted: async () => {} }),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import {
    acceptHandoffs,
    receiveHandoffOffer,
    replaceHandoffOffers,
    replaceConnectedClients,
} from "src/ts/network/handoff";
import { viewingJobs } from "src/ts/process/serverCommands";
import HandoffControls from "./HandoffControls.svelte";

const viewers = viewingJobs as Writable<ReadonlySet<string>>;
let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
const buttons = () => [...target.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((entry) => entry.textContent?.trim() === label)!;
function render(jobIds: readonly string[]) {
    const props = $state({ jobIds, height: "48px" });
    component = mount(HandoffControls, { target, props });
    flushSync();
    return props;
}
function openMenu() {
    target.querySelector<HTMLButtonElement>('button[aria-label="Job handoff"]')!.click();
    flushSync();
}
async function settleOffers() {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers();
    stubs.request.mockReset().mockResolvedValue("offered");
    stubs.takeover.mockReset().mockResolvedValue("take-back-ticket");
    stubs.follow.mockReset().mockResolvedValue("lost");
    acceptHandoffs.set(false);
    replaceConnectedClients([]);
    replaceHandoffOffers([]);
    viewers.set(new Set());
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (component) await unmount(component);
    component = undefined;
    target.remove();
    replaceConnectedClients([]);
    replaceHandoffOffers([]);
    viewers.set(new Set());
    localStorage.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
});

it("lists other workers once per name with tab counts and hands the selected chat's followed job to the chosen worker", async () => {
    replaceConnectedClients([
        { clientId: "self", name: "This tab", worker: true },
        { clientId: "desk-a", name: "Desk", worker: true },
        { clientId: "desk-b", name: "Desk", worker: true },
        { clientId: "phone", name: "Phone", worker: false },
        { clientId: "laptop", name: "Laptop", worker: true },
    ]);
    const props = render([]);
    expect(buttons()).toHaveLength(0);
    props.jobIds = ["selected-job"];
    flushSync();
    openMenu();
    expect(
        buttons()
            .slice(1)
            .map((entry) => entry.textContent?.trim())
            .sort(),
    ).toEqual(["Hand off to Desk (2 tabs)", "Hand off to Laptop"]);
    button("Hand off to Desk (2 tabs)").click();
    await settleOffers();
    expect(stubs.request).toHaveBeenCalledTimes(1);
    const [jobId, workerId] = stubs.request.mock.calls[0];
    expect(jobId).toBe("selected-job");
    expect(["desk-a", "desk-b"]).toContain(workerId);
    openMenu();
    button("Hand off to Laptop").click();
    await settleOffers();
    expect(stubs.request).toHaveBeenLastCalledWith("selected-job", "laptop");
    props.jobIds = [];
    flushSync();
    expect(buttons()).toHaveLength(0);
});

it("offers Take back only for a viewer follow and takes its self-targeted offer with worker acceptance off", async () => {
    const props = render(["own-job"]);
    expect(buttons()).toHaveLength(0);
    viewers.set(new Set(["different-chat-job"]));
    flushSync();
    expect(buttons()).toHaveLength(0);
    viewers.set(new Set(["own-job"]));
    props.jobIds = ["own-job", "still-owned-job"];
    flushSync();
    openMenu();
    expect(
        buttons()
            .slice(1)
            .map((entry) => entry.textContent?.trim()),
    ).toEqual(["Take back"]);
    button("Take back").click();
    await settleOffers();
    expect(stubs.request).toHaveBeenCalledExactlyOnceWith("own-job", "self");
    receiveHandoffOffer({
        epoch: "epoch",
        jobId: "own-job",
        characterId: "character",
        chatId: "chat",
        state: "open",
        reason: "requested",
        target: "self",
    });
    await settleOffers();
    expect(get(acceptHandoffs)).toBe(false);
    expect(stubs.takeover).toHaveBeenCalledExactlyOnceWith("own-job");
    expect(stubs.follow).toHaveBeenCalledExactlyOnceWith("own-job", { chaId: "character", chatId: "chat" }, undefined, {
        ticket: "take-back-ticket",
    });
    viewers.set(new Set());
    flushSync();
    expect(buttons()).toHaveLength(0);
});
