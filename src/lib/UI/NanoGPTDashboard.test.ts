// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "./tests/reactiveProps.svelte";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`): the NanoGPT dashboard no longer receives
// the key; it depends on whether one is stored and on the key's version. An answer still on its way
// when the key is cleared, replaced, or the dashboard leaves must not write the subscription state
// (`BotSettings` resets it when the key is cleared; the chat requests pick their endpoint by it).

const { nano, dbRef } = vi.hoisted(() => ({
    nano: { balance: vi.fn(), subscription: vi.fn() },
    dbRef: { db: { nanogptSubscriptionState: "" } as Record<string, unknown> },
}));

vi.mock("src/ts/model/nanogpt", () => ({
    getNanoGPTBalance: () => nano.balance(),
    getNanoGPTSubscription: () => nano.subscription(),
}));
vi.mock("src/lang", () => ({
    language: new Proxy({} as Record<string, unknown>, {
        get: (_target, key) => (typeof key === "string" && /Until$|PeriodEnd$/.test(key) ? () => key : String(key)),
    }),
}));

import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import NanoGPTDashboard from "./NanoGPTDashboard.svelte";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const subscription = (state: string) => ({ state, period: { currentPeriodEnd: "2026-01-01T00:00:00Z" } });

let target: HTMLElement;
const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
    // Installed as `setDatabaseLite` installs a database (its fields moved into the records, the
    // accessors on), since the dashboard writes the state through the settings views (Phase 6
    // slice 7): `dbRef.db` reads and writes the same record.
    dbRef.db = installFlatDatabase({ nanogptSubscriptionState: "" });
    nano.balance.mockResolvedValue(null);
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe("NanoGPTDashboard", () => {
    it("fetches once per stored key version and never applies an answer that arrived after the key was cleared, replaced, or the dashboard left", async () => {
        const props = reactiveProps({ keySet: true, keyVersion: 1 });
        const first = deferred<unknown>();
        nano.subscription.mockReturnValueOnce(first.promise);
        mounted.push(mount(NanoGPTDashboard, { target, props }));
        flushSync();
        expect(nano.subscription).toHaveBeenCalledTimes(1);
        expect(target.textContent).toContain("nanoGPTLoadingAccountInfo");

        // The key is cleared while the first answer is on its way: `BotSettings` resets the state,
        // and the late answer must not undo that.
        props.keySet = false;
        dbRef.db.nanogptSubscriptionState = "";
        flushSync();
        expect(target.textContent).not.toContain("nanoGPTLoadingAccountInfo");
        first.resolve(subscription("active"));
        await settle();
        expect(dbRef.db.nanogptSubscriptionState).toBe("");
        expect(nano.subscription).toHaveBeenCalledTimes(1);

        // A key set again, then replaced before its answer: only the latest answer is applied.
        const second = deferred<unknown>();
        const third = deferred<unknown>();
        nano.subscription.mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
        props.keySet = true;
        props.keyVersion = 2;
        flushSync();
        expect(nano.subscription).toHaveBeenCalledTimes(2);
        props.keyVersion = 3;
        flushSync();
        expect(nano.subscription).toHaveBeenCalledTimes(3);
        third.resolve(subscription("active"));
        await settle();
        expect(dbRef.db.nanogptSubscriptionState).toBe("active");
        expect(target.textContent).toContain("ACTIVE");
        second.resolve(subscription("grace"));
        await settle();
        expect(dbRef.db.nanogptSubscriptionState).toBe("active");

        // The dashboard leaves with an answer on its way.
        const fourth = deferred<unknown>();
        nano.subscription.mockReturnValueOnce(fourth.promise);
        props.keyVersion = 4;
        flushSync();
        expect(nano.subscription).toHaveBeenCalledTimes(4);
        await unmount(mounted.pop()!);
        fourth.resolve(subscription("inactive"));
        await settle();
        expect(dbRef.db.nanogptSubscriptionState).toBe("active");
    });
});
