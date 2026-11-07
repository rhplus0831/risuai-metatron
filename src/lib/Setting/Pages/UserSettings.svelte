<script lang="ts">
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import {
        LoadLocalBackup,
        SaveLocalBackup,
        SavePartialLocalBackup,
        SaveUpstreamLocalBackup,
    } from "src/ts/drive/backuplocal";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { exportAsDataset } from "src/ts/storage/exportAsDataset";
    import { openSetting } from "src/ts/setting/settingJump.svelte";
    import type { SettingHit } from "src/ts/setting/searchIndex";
    import { STORAGE_SETTINGS_MENU } from "src/ts/settingsMenu";
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.backups}</h2>

<Button
    onclick={async () => {
        if (await alertConfirm(language.backupConfirm)) {
            SaveLocalBackup();
        }
    }}
    className="mt-2"
>
    {language.saveBackupLocal}
</Button>

<Button
    onclick={async () => {
        if (await alertConfirm(language.backupConfirm)) {
            SavePartialLocalBackup();
        }
    }}
    className="mt-2"
>
    {language.savePartialLocalBackup}
</Button>

<Button
    onclick={async () => {
        if (await alertConfirm(language.backupConfirm)) {
            SaveUpstreamLocalBackup();
        }
    }}
    className="mt-2"
>
    {language.upstreamExport.button}
</Button>

<Button
    onclick={async () => {
        if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
            LoadLocalBackup();
        }
    }}
    className="mt-2"
>
    {language.loadBackupLocal}
</Button>

<button
    type="button"
    class="mt-2 rounded-sm text-textcolor underline underline-offset-4 hover:text-textcolor2 focus-visible:ring-2 focus-visible:ring-selected"
    onclick={() =>
        openSetting({
            kind: "section",
            id: "storage.snapshots",
            label: language.storagePage.snapshots.title,
            breadcrumb: [language.storagePage.title],
            target: { menu: STORAGE_SETTINGS_MENU, sectionId: "storage.snapshots" },
            available: true,
            score: 0,
        } satisfies SettingHit)}
>
    {language.storagePage.snapshots.backupsLink}
</button>

<Button onclick={exportAsDataset} className="mt-2">
    {language.exportAsDataset}
</Button>
<!--

    My song for dear, my old friend.

    Should old aquaintance be forgot,
    and never brought to mind?
    Should old lang syne be forgot,
    and auld lang syne?

    For auld lang syne, my dear,
    for auld lang syne,
    we'll take a cup o' kindness yet,
    for auld lang syne.

-->
