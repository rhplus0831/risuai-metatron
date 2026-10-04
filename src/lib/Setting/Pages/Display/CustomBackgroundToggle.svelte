<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { saveImage } from "src/ts/storage/database.svelte";
    import { selectSingleFile } from "src/ts/util";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
</script>

<div class="flex items-center mt-2">
    <Check
        check={settings.ui.customBackground !== ""}
        onChange={async (check) => {
            if (check) {
                settings.ui.customBackground = "-";
                const d = await selectSingleFile(["png", "webp", "gif"]);
                if (!d) {
                    settings.ui.customBackground = "";
                    return;
                }
                const img = await saveImage(d.data);
                settings.ui.customBackground = img;
            } else {
                settings.ui.customBackground = "";
            }
        }}
        name={language.useCustomBackground}
    />
</div>
