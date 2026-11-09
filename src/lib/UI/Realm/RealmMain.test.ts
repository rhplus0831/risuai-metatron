// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { expect, it, vi } from "vitest";

vi.mock("src/ts/characterCards", async () =>
    (await import("src/ts/tests/bootMocks")).createBootMock("characterCards", {
        getRisuHub: vi.fn<(typeof import("src/ts/characterCards"))["getRisuHub"]>(async () => []),
        hubAdditionalHTML: `<section id="realm-extra" onclick="alert(1)">
            <h2>Community <em>notice</em></h2>
            <img alt="Banner" src="data:image/png;base64,AQID" onerror="alert(2)">
            <a id="unsafe-link" href="javascript:alert(3)" onmouseover="alert(4)">Unsafe link</a>
            <a id="safe-link" href="https://example.org/community">Read more</a>
            <script>globalThis.realmInjected = true</script>
        </section>`,
    }),
);
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import RealmMain from "./RealmMain.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { REALM_TERMS_VERSION } from "src/ts/realmTerms";

it("sanitizes additional hub HTML at the mounted Realm sink while preserving safe content", async () => {
    installFlatDatabase({ characters: [], realmTermsAccepted: REALM_TERMS_VERSION });
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(RealmMain, { target });
    try {
        flushSync();
        await tick();
        expect(settings.ui.realmTermsAccepted).toBe(REALM_TERMS_VERSION);
        const extra = target.querySelector<HTMLElement>("#realm-extra");
        expect(extra).not.toBeNull();
        expect(extra!.querySelector("h2")?.textContent).toBe("Community notice");
        expect(extra!.querySelector("h2 em")?.textContent).toBe("notice");
        expect(extra!.querySelector("img")?.getAttribute("alt")).toBe("Banner");
        expect(extra!.querySelector("#safe-link")?.getAttribute("href")).toBe("https://example.org/community");
        expect(extra!.querySelector("#unsafe-link")?.textContent).toBe("Unsafe link");
        expect(extra!.querySelector("#unsafe-link")?.getAttribute("href")).toBe("");
        expect(extra!.querySelector("script")).toBeNull();
        for (const node of [extra!, ...extra!.querySelectorAll("*")]) {
            expect([...node.attributes].filter((attribute) => attribute.name.toLowerCase().startsWith("on"))).toEqual(
                [],
            );
        }
    } finally {
        await unmount(component);
        target.remove();
    }
});
