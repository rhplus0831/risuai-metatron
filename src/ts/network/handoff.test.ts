import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_FEED_CLIENT_NAME, type HandoffOffer } from "../../../shared/events.ts";

type Jobs = typeof import("./generationJobs");
const stubs = vi.hoisted(() => ({
    current: vi.fn<Jobs["readChatGeneration"]>(),
    takeover: vi.fn<Jobs["takeoverGenerationJob"]>(),
    started: vi.fn<() => Promise<void>>(),
    follow: vi.fn<typeof import("../process/serverCommands").followJobToEnd>(),
    request: vi.fn<Jobs["requestGenerationHandoff"]>(),
    toast: vi.fn<typeof import("../alert").alertToast>(),
}));
vi.mock("./generationJobs", async () =>
    (await import("./tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "self",
        savedGenerationJobIds: () => ["own-saved"],
        readChatGeneration: stubs.current,
        takeoverGenerationJob: stubs.takeover,
        requestGenerationHandoff: stubs.request,
    }),
);
vi.mock("../process/serverCommands", async () =>
    (await import("../process/tests/serverCommandsMock")).createServerCommandsMock({ followJobToEnd: stubs.follow }),
);
vi.mock("../plugins/plugins.svelte", async () =>
    (await import("../tests/bootMocks")).createBootMock("plugins", { pluginsStarted: stubs.started }),
);
vi.mock("../storage/resourceClient", async () =>
    (await import("../storage/tests/resourceClientMock")).createResourceClientMock({ getResourceEpoch: () => "epoch" }),
);
vi.mock("../storage/serverAuth", async () => (await import("../storage/tests/serverAuthMock")).createServerAuthMock());
vi.mock("../alert", async () => (await import("../tests/alertMock")).createAlertMock({ alertToast: stubs.toast }));

let handoff: typeof import("./handoff");
const offer = (jobId: string, extra: Partial<HandoffOffer> = {}): HandoffOffer => ({
    epoch: "epoch",
    jobId,
    characterId: "character",
    chatId: jobId,
    state: "open",
    reason: "preferred",
    ...extra,
});
const windowsChromeAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function reloadHandoff(userAgent: string) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.resetModules();
    return import("./handoff");
}
// Module loading is part of offer evaluation. Drain it before inspecting an intentionally blocked gate.
async function settleOffers() {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    localStorage.clear();
    stubs.current
        .mockReset()
        .mockImplementation(async ({ chatId }) => ({ jobId: chatId, kind: "send", owned: chatId.startsWith("own") }));
    stubs.takeover.mockReset().mockImplementation(async (jobId) => `ticket:${jobId}`);
    stubs.started.mockReset().mockResolvedValue(undefined);
    stubs.follow.mockReset().mockResolvedValue("lost");
    stubs.request.mockReset().mockResolvedValue("offered");
    stubs.toast.mockReset();
    handoff = await import("./handoff");
    await import("./generationJobs");
    await import("../plugins/plugins.svelte");
    await import("../process/serverCommands");
});
afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("targets the newest other host per name and counts only connected hosts", () => {
    expect(
        handoff.hostTargets(
            [
                { clientId: "self", name: "Desk", worker: true, host: true },
                { clientId: "worker", name: "Desk", worker: true },
                { clientId: "newest", name: "Desk", worker: false, host: true },
                { clientId: "disabled", name: "Desk", worker: true, host: false },
                { clientId: "older", name: "Desk", worker: true, host: true },
                { clientId: "tablet", name: "Tablet", worker: false, host: true },
            ],
            "self",
        ),
    ).toEqual([
        { name: "Desk", clientId: "newest", count: 2 },
        { name: "Tablet", clientId: "tablet", count: 1 },
    ]);
});

it("reminds the requester at ten seconds only while its requested offer remains open", async () => {
    const open = offer("waiting", { reason: "requested", target: "worker" });
    const taken = offer("taken", { reason: "requested", target: "worker" });
    handoff.replaceHandoffOffers([open, taken]);
    await handoff.handOffJob("waiting", "worker");
    await handoff.handOffJob("taken", "worker");
    handoff.receiveHandoffOffer({ ...taken, state: "closed" });
    expect(stubs.request.mock.calls).toEqual([
        ["waiting", "worker"],
        ["taken", "worker"],
    ]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stubs.toast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.toast).toHaveBeenCalledExactlyOnceWith("The handoff offer is still open. No worker has taken it yet.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stubs.toast).toHaveBeenCalledTimes(1);
});

it("defaults worker preferences off and retains the toggles and device name across a reload", async () => {
    expect(get(handoff.acceptHandoffs)).toBe(false);
    expect(get(handoff.preferHandoff)).toBe(false);
    handoff.acceptHandoffs.set(true);
    handoff.preferHandoff.set(true);
    handoff.clientName.set("Kitchen tablet");
    vi.resetModules();
    const reloaded = await import("./handoff");
    expect(get(reloaded.acceptHandoffs)).toBe(true);
    expect(get(reloaded.preferHandoff)).toBe(true);
    expect(get(reloaded.clientName)).toBe("Kitchen tablet");
});

it.each([
    ["Edge · Windows", `${windowsChromeAgent} Edg/131.0.0.0`],
    [
        "Samsung Internet · Android",
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
    ],
    ["Opera · Windows", `${windowsChromeAgent} OPR/115.0.0.0`],
    ["Firefox · Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"],
    ["Chrome · Windows", windowsChromeAgent],
    [
        "Safari · iOS",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    ],
    ["Browser · Linux", "Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0"],
])("defaults to %s and uses it for registration", async (label, userAgent) => {
    localStorage.removeItem("risu-handoff-name");
    const reloaded = await reloadHandoff(userAgent);

    expect(get(reloaded.clientName)).toBe(label);
    expect(localStorage.getItem("risu-handoff-name")).toBe(JSON.stringify(label));
    expect(reloaded.registration("self", true)).toMatchObject({ name: label });
});

it("replaces a saved user-agent device name once and keeps the remembered remote host", async () => {
    const legacyName = windowsChromeAgent.slice(0, MAX_FEED_CLIENT_NAME);
    localStorage.setItem("risu-handoff-name", JSON.stringify(legacyName));
    localStorage.setItem("risu-remote-send-host", JSON.stringify(legacyName));
    const migrated = await reloadHandoff(windowsChromeAgent);
    const { remoteSendHost } = await import("./remoteSend");

    expect(get(migrated.clientName)).toBe("Chrome · Windows");
    expect(localStorage.getItem("risu-handoff-name")).toBe(JSON.stringify("Chrome · Windows"));
    expect(get(remoteSendHost)).toBe(legacyName);
    expect(localStorage.getItem("risu-remote-send-host")).toBe(JSON.stringify(legacyName));

    const reloaded = await reloadHandoff(`${windowsChromeAgent} Edg/131.0.0.0`);
    expect(get(reloaded.clientName)).toBe("Chrome · Windows");
    expect(localStorage.getItem("risu-handoff-name")).toBe(JSON.stringify("Chrome · Windows"));
});

it.each(["", "Mozilla/5.0"])("keeps the saved device name %j", async (name) => {
    localStorage.setItem("risu-handoff-name", JSON.stringify(name));
    const reloaded = await reloadHandoff(windowsChromeAgent);

    expect(get(reloaded.clientName)).toBe(name);
    expect(localStorage.getItem("risu-handoff-name")).toBe(JSON.stringify(name));
});

it("takes only eligible offers after plugins start, including own absent jobs and self-targeted take backs", async () => {
    for (const accepting of [false, true]) {
        handoff.acceptHandoffs.set(accepting);
        const cases: [HandoffOffer, boolean][] = [
            [offer("foreign"), accepting],
            [offer("foreign-absent", { reason: "absent" }), accepting],
            [offer("targeted", { target: "self" }), true],
            [offer("own-saved", { reason: "absent" }), true],
            [offer("own-unsaved", { reason: "absent" }), true],
            [offer("own-take-back", { reason: "requested", target: "self" }), true],
            [offer("own-preferred"), false],
            [offer("own-saved"), false],
            [offer("own-requested", { reason: "requested" }), false],
            [offer("other-target", { target: "someone-else" }), false],
            [offer("own-other-target", { reason: "absent", target: "someone-else" }), false],
        ];
        for (const [candidate, allowed] of cases) {
            let start!: () => void;
            stubs.started.mockReset().mockReturnValue(
                new Promise<void>((resolve) => {
                    start = resolve;
                }),
            );
            stubs.takeover.mockClear();
            stubs.follow.mockClear();
            handoff.replaceHandoffOffers([candidate]);
            await settleOffers();
            if (allowed) expect(stubs.started).toHaveBeenCalledTimes(1);
            expect(stubs.takeover).not.toHaveBeenCalled();
            expect(stubs.follow).not.toHaveBeenCalled();
            start();
            await settleOffers();
            if (allowed) {
                expect(stubs.takeover).toHaveBeenCalledExactlyOnceWith(candidate.jobId);
                expect(stubs.follow).toHaveBeenCalledExactlyOnceWith(
                    candidate.jobId,
                    { chaId: "character", chatId: candidate.jobId },
                    undefined,
                    { ticket: `ticket:${candidate.jobId}` },
                );
            } else {
                expect(stubs.takeover).not.toHaveBeenCalled();
                expect(stubs.follow).not.toHaveBeenCalled();
            }
            handoff.replaceHandoffOffers([]);
        }
    }
});

it("automatically claims a self-targeted offer after a transient lookup failure and one-second backoff", async () => {
    const { ResourceRequestError } = await import("../storage/resourceClient");
    stubs.current.mockRejectedValueOnce(new ResourceRequestError(503, "Service unavailable"));
    const candidate = offer("retry-current", { target: "self" });
    handoff.receiveHandoffOffer(candidate);
    await settleOffers();
    expect(stubs.current).toHaveBeenCalledExactlyOnceWith({ chaId: "character", chatId: "retry-current" });
    expect(get(handoff.handoffOffers).get(candidate.jobId)).toBe(candidate);
    expect(get(handoff.acceptHandoffs)).toBe(false);
    expect(stubs.takeover).not.toHaveBeenCalled();
    expect(stubs.follow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    await settleOffers();
    expect(stubs.current).toHaveBeenCalledTimes(1);
    expect(stubs.takeover).not.toHaveBeenCalled();
    expect(stubs.follow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settleOffers();
    expect(stubs.current).toHaveBeenCalledTimes(2);
    expect(stubs.takeover).toHaveBeenCalledExactlyOnceWith("retry-current");
    expect(stubs.follow).toHaveBeenCalledExactlyOnceWith(
        "retry-current",
        { chaId: "character", chatId: "retry-current" },
        undefined,
        { ticket: "ticket:retry-current" },
    );
});

it("drops an unavailable takeover offer without following or retrying after backoff or opt-in", async () => {
    // The claim client resolves null for HTTP 404 and 409.
    stubs.takeover.mockResolvedValue(null);
    handoff.receiveHandoffOffer(offer("unavailable", { target: "self" }));
    await settleOffers();
    expect(stubs.takeover).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(get(handoff.handoffOffers).size).toBe(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settleOffers();
    expect(stubs.current).toHaveBeenCalledTimes(1);
    expect(stubs.takeover).toHaveBeenCalledTimes(1);
    expect(stubs.follow).not.toHaveBeenCalled();

    handoff.acceptHandoffs.set(true);
    await settleOffers();
    expect(stubs.takeover).toHaveBeenCalledTimes(1);
    expect(stubs.follow).not.toHaveBeenCalled();
});

it("cancels a pending retry when a closed offer frame arrives during backoff", async () => {
    const { ResourceRequestError } = await import("../storage/resourceClient");
    stubs.current.mockRejectedValueOnce(new ResourceRequestError(503, "Service unavailable"));
    const candidate = offer("closed-during-backoff", { target: "self" });
    handoff.receiveHandoffOffer(candidate);
    await settleOffers();
    expect(stubs.current).toHaveBeenCalledExactlyOnceWith({ chaId: "character", chatId: "closed-during-backoff" });
    expect(stubs.takeover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    handoff.receiveHandoffOffer({ ...candidate, state: "closed" });
    await settleOffers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settleOffers();
    expect(stubs.current).toHaveBeenCalledTimes(1);
    expect(stubs.takeover).not.toHaveBeenCalled();
    expect(stubs.follow).not.toHaveBeenCalled();
    expect(get(handoff.handoffOffers).has(candidate.jobId)).toBe(false);
});
