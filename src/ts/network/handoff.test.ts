import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HandoffOffer } from "../../../shared/events.ts";

type Jobs = typeof import("./generationJobs");
const stubs = vi.hoisted(() => ({
    current: vi.fn<Jobs["readChatGeneration"]>(),
    takeover: vi.fn<Jobs["takeoverGenerationJob"]>(),
    started: vi.fn<() => Promise<void>>(),
    follow: vi.fn<typeof import("../process/serverCommands").followJobToEnd>(),
}));
vi.mock("./generationJobs", async () =>
    (await import("./tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "self",
        savedGenerationJobIds: () => ["own-saved"],
        readChatGeneration: stubs.current,
        takeoverGenerationJob: stubs.takeover,
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
    handoff = await import("./handoff");
    await import("./generationJobs");
    await import("../plugins/plugins.svelte");
    await import("../process/serverCommands");
});
afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
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

it("drops an unavailable takeover offer without starting a follow or retrying it on opt-in", async () => {
    stubs.takeover.mockResolvedValue(null);
    handoff.receiveHandoffOffer(offer("unavailable", { target: "self" }));
    await settleOffers();
    expect(stubs.takeover).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(get(handoff.handoffOffers).size).toBe(0);
    handoff.acceptHandoffs.set(true);
    await settleOffers();
    expect(stubs.takeover).toHaveBeenCalledTimes(1);
    expect(stubs.follow).not.toHaveBeenCalled();
});
