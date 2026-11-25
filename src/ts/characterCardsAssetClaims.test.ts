import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { cardV3, charx } from "./storage/tests/importFixtures";
import { bootMutations, warmMutationGraph } from "./storage/tests/mutationStoresHarness";

const boundary = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn() }));
vi.mock("./storage/serverAuth", async () =>
    (await import("./storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: boundary.fetch }),
);
vi.mock("./alert", async () =>
    (await import("./tests/alertMock")).createAlertMock({
        alertError: boundary.error,
        alertConfirm: vi.fn(async () => true),
    }),
);

let booted: Awaited<ReturnType<typeof bootMutations>> | undefined;
beforeAll(() => warmMutationGraph(() => import("./characterCards")));
beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    vi.stubGlobal("location", new URL("http://localhost/"));
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
});
afterEach(() => {
    booted?.fake.close();
    booted = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

it.each(["present", "missing"])("claims server-imported card keys at the record boundary when %s", async (state) => {
    booted = await bootMutations((fake) => boundary.fetch.mockImplementation((url, init) => fake.fetch(url, init)));
    const b = booted;
    const before = b.characterList().map((c) => c.chaId);
    const checked: string[][] = [];
    boundary.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (url === "/api/assets/missing") {
            const { names } = JSON.parse(init.body as string);
            checked.push(names);
            expect(b.characterList().map((c) => c.chaId)).toEqual(before);
            return Response.json({ missing: state === "missing" ? names : [] });
        }
        return b.fake.fetch(url, init);
    });
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    const cards = await import("./characterCards");
    const bytes = new TextEncoder().encode("imported backdrop");
    const archive = charx(
        cardV3("Claimed card", {
            assets: [{ type: "x-risu-asset", name: "Backdrop", uri: "embeded://assets/backdrop.png", ext: "png" }],
        }),
        { "assets/backdrop.png": bytes },
    );
    const result = await cards.importCharacterProcess({
        name: "claimed.charx",
        data: new File([new Uint8Array(archive)], "claimed.charx"),
    });
    const key = `assets/${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}.png`;
    expect(checked).toEqual([[key]]);
    if (state === "missing") {
        expect(result).toBeNull();
        expect(b.characterList().map((c) => c.chaId)).toEqual(before);
        expect(boundary.error).toHaveBeenCalledWith(language.errors.cardAssetsUnavailable);
    } else {
        expect(result).toEqual(expect.any(String));
        expect(b.characterList()).toHaveLength(before.length + 1);
        expect(boundary.error).not.toHaveBeenCalled();
        await b.sync.flushResources();
        expect(b.fake.record("characters", result as string)?.data).toMatchObject({
            additionalAssets: [["Backdrop", key, "png"]],
        });
    }
});
