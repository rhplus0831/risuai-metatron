// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/resourceClient", async () =>
    (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock(),
);
vi.mock(
    "src/ts/drive/backuplocal",
    () =>
        ({
            LoadLocalBackup: vi.fn<typeof import("src/ts/drive/backuplocal").LoadLocalBackup>(),
            SaveLocalBackup: vi.fn(),
            SavePartialLocalBackup: vi.fn(),
            SaveUpstreamLocalBackup: vi.fn(),
            readFirstRecordName: vi.fn(),
            upstreamBackupFileName: vi.fn(),
        }) satisfies typeof import("src/ts/drive/backuplocal"),
);
vi.mock("src/ts/storage/exportAsDataset", () => ({ exportAsDataset: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({ moduleUpdate: vi.fn(), getModules: () => [] }));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: (text: string) => text }));
vi.mock("src/ts/parser/transformClient", () => ({ resetTransformEffects: vi.fn() }));
vi.mock("src/ts/process/index.svelte", () => ({}));

import { language } from "src/lang";
import { alertConfirm } from "src/ts/alert";
import { currentJump, finishJump, jumpVersion } from "src/ts/setting/settingJump.svelte";
import { restoreBackup } from "src/ts/storage/resourceClient";
import { SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
import UserSettings from "./UserSettings.svelte";

let target: HTMLDivElement;
let mounted: ReturnType<typeof mount> | undefined;

beforeEach(() => {
    vi.clearAllMocks();
    finishJump(jumpVersion());
    SettingsMenuIndex.set(-1);
    settingsOpen.set(false);
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    target.remove();
    finishJump(jumpVersion());
    SettingsMenuIndex.set(-1);
    settingsOpen.set(false);
});

it("opens Storage's snapshots section from Backups without confirming or restoring", async () => {
    mounted = mount(UserSettings, { target });
    flushSync();
    const link = [...target.querySelectorAll<HTMLElement>("a, button")].find(
        (element) => element.textContent?.trim() === language.storagePage.snapshots.backupsLink,
    );
    expect(link, "Backups snapshots link").toBeDefined();

    link!.click();
    await tick();

    expect(get(settingsOpen)).toBe(true);
    expect(get(SettingsMenuIndex)).toBe(23);
    expect(currentJump()).toMatchObject({
        kind: "section",
        id: "storage.snapshots",
        menu: 23,
        sectionId: "storage.snapshots",
        available: true,
    });
    expect(alertConfirm).not.toHaveBeenCalled();
    expect(restoreBackup).not.toHaveBeenCalled();
});
