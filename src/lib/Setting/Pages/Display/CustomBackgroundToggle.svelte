<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { saveImage } from "src/ts/storage/database.svelte";
    import { selectSingleFile } from "src/ts/util";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
</script>

<!-- No top margin: the field above it in Display's Colors & typography section ends with its own 1rem. -->
<div class="flex items-center">
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
