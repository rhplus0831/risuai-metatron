import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import { language } from "src/lang";
import { unconfirmedSave } from "src/ts/storage/resourceSync.svelte";
import SavePopupIcon from "./SavePopupIcon.svelte";

vi.mock("src/lang", async () => ({ language: (await import("src/lang/en")).languageEnglish }));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({ settings: { ui: { showSavingIcon: false } } }));
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({ saving: { state: true } }),
);
vi.mock("src/ts/storage/resourceSync.svelte", async () => {
    const { fromStore, writable } = await import("svelte/store");
    const unconfirmed = fromStore(writable(false));
    return (await import("src/ts/tests/bootMocks")).createBootMock("resourceSync", {
        unconfirmedSave: {
            get state() {
                return unconfirmed.current;
            },
            set state(value) {
                unconfirmed.current = value;
            },
        },
    });
});

it("shows a focusable unconfirmed save tooltip with the saving icon setting off", async () => {
    const target = document.body.appendChild(document.createElement("div"));
    const instance = mount(SavePopupIcon, { target });
    try {
        flushSync();
        expect(target.children).toHaveLength(0);

        flushSync(() => (unconfirmedSave.state = true));
        const warning = target.querySelector<HTMLElement>("[title]");
        expect(warning).not.toBeNull();
        expect(warning!.title).toBe(language.resourceSaveUnconfirmed);
        expect(warning!.getAttribute("aria-label")).toBe(language.resourceSaveUnconfirmed);
        expect(warning!.tabIndex).toBe(0);
        warning!.focus();
        expect(document.activeElement).toBe(warning);

        flushSync(() => (unconfirmedSave.state = false));
        expect(target.children).toHaveLength(0);
    } finally {
        await unmount(instance);
        target.remove();
    }
});
