import { flushSync, mount, tick, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The home screen's More section over the real settings views and the real host mode store; the character import
// it starts is a spy.
// The Realm screen, the logo, asset loading and the application-wide stores are isolated.
vi.mock("./Realm/RealmMain.svelte", () => ({ default: () => {} }));
vi.mock("./Title.svelte", () => ({ default: () => {} }));
vi.mock("src/ts/characters", () => ({
    getCharImage: vi.fn(async () => "/avatar.png"),
    changeChar: vi.fn(),
    importCharacterAndSelect: vi.fn(async () => {}),
}));
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({ getVersionString: () => "test" }),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/util", () => ({ sleep: vi.fn() }));
vi.mock("src/ts/stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return (await import("src/ts/tests/storesMock")).createStoresMock({
        gridOpenStore: writable(false),
        OpenRealmStore: writable(false),
    });
});

import { language } from "src/lang";
import { importCharacterAndSelect } from "src/ts/characters";
import { hostMode } from "src/ts/network/remoteHost";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { OpenRealmStore } from "src/ts/stores.svelte";
import MainMenu from "./MainMenu.svelte";

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
    localStorage.clear();
    hostMode.set(false);
    OpenRealmStore.set(false);
    selectCharacter(null);
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    target.remove();
    hostMode.set(false);
    installFlatDatabaseWithChats({ characters: [] });
});

async function render(hideRealm: boolean) {
    installFlatDatabaseWithChats({ characters: [], hideRealm });
    instance = mount(MainMenu, { target });
    flushSync();
    await tick();
}

const card = (name: string) => target.querySelector<HTMLButtonElement>(`[data-risu-home-card="${name}"]`);
const cards = () =>
    [...target.querySelectorAll<HTMLButtonElement>('[data-risu-home-section="more"] [data-risu-home-card]')].map(
        (entry) => entry.dataset.risuHomeCard,
    );

it("keeps the import and remote host cards when the Realm card is hidden, and the card turns host mode on", async () => {
    await render(true);
    expect(cards()).toEqual(["import-character", "remote-host"]);
    expect(card("remote-host")!.textContent).toContain(language.serverJob.remoteHost.start);
    expect(card("remote-host")!.textContent).toContain(language.serverJob.remoteHost.startDescription);
    expect(get(hostMode)).toBe(false);
    card("remote-host")!.click();
    expect(get(hostMode)).toBe(true);
    expect(get(OpenRealmStore)).toBe(false);
});

it("lists the Realm card first while Realm is shown, and that card opens Realm without host mode", async () => {
    await render(false);
    expect(cards()).toEqual(["realm", "import-character", "remote-host"]);
    card("realm")!.click();
    expect(get(OpenRealmStore)).toBe(true);
    expect(get(hostMode)).toBe(false);
});

it("opens the character import from its own card, without the add dialog, Realm or host mode", async () => {
    await render(false);
    expect(card("import-character")!.textContent).toContain(language.importCharacter);
    expect(card("import-character")!.textContent).toContain(language.homeImportCharacterDescription);
    card("import-character")!.click();
    expect(importCharacterAndSelect).toHaveBeenCalledTimes(1);
    expect(get(OpenRealmStore)).toBe(false);
    expect(get(hostMode)).toBe(false);
});
