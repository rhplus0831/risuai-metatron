// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "./tests/reactiveProps.svelte";

// The NanoGPT dashboard no longer receives the key; it depends on whether one is stored and on the
// key's version. An answer still on its way when the key is cleared, replaced, or the dashboard
// leaves must not write the subscription state (`ModelSettings` resets it when the key is cleared;
// the chat requests pick their endpoint by it).

const { nano } = vi.hoisted(() => ({
    nano: { balance: vi.fn(), subscription: vi.fn(), providers: vi.fn() },
}));

vi.mock("src/ts/model/nanogpt", () => ({
    getNanoGPTBalance: (profile: unknown) => nano.balance(profile),
    getNanoGPTSubscription: (profile: unknown) => nano.subscription(profile),
    getNanoGPTModelProviders: (modelId: string, profile: unknown) => nano.providers(modelId, profile),
}));
vi.mock("src/lang", () => ({
    language: new Proxy({} as Record<string, unknown>, {
        get: (_target, key) => (typeof key === "string" && /Until$|PeriodEnd$/.test(key) ? () => key : String(key)),
    }),
}));

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import NanoGPTDashboard from "./NanoGPTDashboard.svelte";
import NanoGPTProviderPicker from "./NanoGPTProviderPicker.svelte";

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
    // Installed into the records (the `providers` section), since the dashboard writes the state
    // through the settings views: the test reads and writes the same record.
    installFlatDatabase({ nanogptSubscriptionState: "" });
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

        // The key is cleared while the first answer is on its way: `ModelSettings` resets the state,
        // and the late answer must not undo that.
        props.keySet = false;
        settings.providers.nanogptSubscriptionState = "";
        flushSync();
        expect(target.textContent).not.toContain("nanoGPTLoadingAccountInfo");
        first.resolve(subscription("active"));
        await settle();
        expect(settings.providers.nanogptSubscriptionState).toBe("");
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
        expect(settings.providers.nanogptSubscriptionState).toBe("active");
        expect(target.textContent).toContain("ACTIVE");
        second.resolve(subscription("grace"));
        await settle();
        expect(settings.providers.nanogptSubscriptionState).toBe("active");

        // The dashboard leaves with an answer on its way.
        const fourth = deferred<unknown>();
        nano.subscription.mockReturnValueOnce(fourth.promise);
        props.keyVersion = 4;
        flushSync();
        expect(nano.subscription).toHaveBeenCalledTimes(4);
        await unmount(mounted.pop()!);
        fourth.resolve(subscription("inactive"));
        await settle();
        expect(settings.providers.nanogptSubscriptionState).toBe("active");
    });
});

vi.mock("src/ts/plugins/apiV3/v3.svelte", () => ({ customV3ProviderMetaStore: [] }));
vi.mock("src/ts/network/auxFetch", () => ({ auxFetch: vi.fn() }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
import { normalizeModelProfile } from "../../../shared/presets.ts";
import { maskLlmSecrets } from "../../../shared/llmSecrets.ts";
import { setMaskedSecrets, secretVersion } from "src/ts/storage/llmSecrets.svelte";
import { credentialStatusFor } from "src/ts/model/credentials";

describe("NanoGPTDashboard binding changes", () => {
    it.each(["a", undefined])(
        "refetches %s to B at equal key versions and ignores the earlier account",
        async (credentialId) => {
            installFlatDatabase({
                credentials: [
                    { id: "a", name: "A", type: "nanogpt" },
                    { id: "b", name: "B", type: "nanogpt" },
                ],
                nanogptSubscriptionState: "",
            });
            setMaskedSecrets(
                maskLlmSecrets({ nanogptKey: "flat", credentials: { a: { key: "A" }, b: { key: "B" } } }),
                "all",
            );
            const flat = { kind: "flat", field: "nanogptKey" } as const;
            expect(secretVersion(flat)).toBe(secretVersion({ kind: "entry", field: "credentials", id: "b" }));
            expect(secretVersion({ kind: "entry", field: "credentials", id: "a" })).toBe(
                secretVersion({ kind: "entry", field: "credentials", id: "b" }),
            );
            const profile = normalizeModelProfile({ id: "edited", modelId: "nanogpt", credentialId });
            const props = reactiveProps({ profile, ...credentialStatusFor(profile, flat) });
            const old = deferred<unknown>();
            nano.subscription.mockReturnValueOnce(old.promise).mockResolvedValueOnce(subscription("active"));
            mounted.push(mount(NanoGPTDashboard, { target, props }));
            flushSync();
            expect(nano.subscription).toHaveBeenCalledTimes(1);
            expect(nano.subscription).toHaveBeenLastCalledWith(expect.objectContaining({ id: "edited" }));
            expect(nano.subscription.mock.calls.at(-1)![0].credentialId).toBe(credentialId);
            props.profile.credentialId = "b";
            Object.assign(props, credentialStatusFor(props.profile, flat));
            flushSync();
            await settle();
            expect(nano.subscription).toHaveBeenCalledTimes(2);
            expect(nano.balance).toHaveBeenLastCalledWith(expect.objectContaining({ id: "edited", credentialId: "b" }));
            expect(target.textContent).toContain("ACTIVE");
            old.resolve(subscription("inactive"));
            await settle();
            expect(settings.providers.nanogptSubscriptionState).toBe("active");
            expect(target.textContent).toContain("ACTIVE");
        },
    );
});

describe("NanoGPTProviderPicker binding changes", () => {
    it("refetches providers when the binding changes at equal secret versions", async () => {
        installFlatDatabase({
            credentials: [
                { id: "a", name: "A", type: "nanogpt" },
                { id: "b", name: "B", type: "nanogpt" },
            ],
        });
        setMaskedSecrets(maskLlmSecrets({ credentials: { a: { key: "A" }, b: { key: "B" } } }), "all");
        expect(secretVersion({ kind: "entry", field: "credentials", id: "a" })).toBe(
            secretVersion({ kind: "entry", field: "credentials", id: "b" }),
        );
        const profile = normalizeModelProfile({ id: "edited", modelId: "nanogpt", credentialId: "a" });
        const flat = { kind: "flat", field: "nanogptKey" } as const;
        const props = reactiveProps({
            profile,
            modelId: "vendor/model",
            value: "",
            ...credentialStatusFor(profile, flat),
        });
        nano.providers.mockResolvedValue(null);
        mounted.push(mount(NanoGPTProviderPicker, { target, props }));
        flushSync();
        expect(nano.providers).toHaveBeenCalledTimes(1);
        props.profile.credentialId = "b";
        Object.assign(props, credentialStatusFor(props.profile, flat));
        flushSync();
        expect(nano.providers).toHaveBeenCalledTimes(2);
        expect(nano.providers).toHaveBeenLastCalledWith(
            "vendor/model",
            expect.objectContaining({ id: "edited", credentialId: "b" }),
        );
    });
});
