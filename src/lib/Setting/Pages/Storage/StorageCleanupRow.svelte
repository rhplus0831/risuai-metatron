<script lang="ts">
    import { language } from "src/lang";
    import { assetExtension } from "../../../../../shared/assetMime.ts";
    import StorageAssetPreview from "./StorageAssetPreview.svelte";
    import { shortAssetKey } from "./storageCleanup";
    import { getStorageController } from "./storageContext";

    /** Explicit checkbox updates preserve selections in other components and hidden filter rows. */
    const {
        assetKey,
        value,
        inlayId,
        bytes,
        since,
        generatedAt,
        checked,
        disabled,
        onchange,
    }: {
        assetKey: string | null;
        value: string;
        inlayId?: string;
        bytes: number;
        since: number | null;
        generatedAt: number | null;
        checked: boolean;
        disabled: boolean;
        onchange: (checked: boolean) => void;
    } = $props();
    const controller = getStorageController();
    const extension = $derived(assetExtension(assetKey ?? ""));
    const days = $derived(
        since === null ? null : Math.max(0, Math.floor(((generatedAt ?? Date.now()) - since) / 86_400_000)),
    );
</script>

<label class="flex min-w-0 items-center gap-2 border-b border-darkborderc p-2 last:border-b-0">
    <input
        type="checkbox"
        {value}
        {checked}
        {disabled}
        onchange={(event) => onchange(event.currentTarget.checked)}
        class="shrink-0"
    />
    <StorageAssetPreview {assetKey} {generatedAt} />
    <span class="min-w-0 flex-1">
        <span class="flex flex-wrap gap-x-2">
            <span class="break-all font-medium"
                >{extension ? extension.toUpperCase() : language.storagePage.cleanup.noExtension}</span
            >
            <span class="text-textcolor2">{controller.formatBytes(bytes)}</span>
        </span>
        <span class="block text-xs text-textcolor2">
            {days === null ? language.storage.missingValue : language.storagePage.cleanup.unusedDays(days)}
        </span>
        <span class="block truncate font-mono text-xs" title={assetKey ?? undefined}>
            {assetKey === null ? language.storage.none : shortAssetKey(assetKey)}
        </span>
        {#if inlayId !== undefined}
            <span class="block truncate text-xs text-textcolor2" title={inlayId}>
                {language.storage.inlayId}: <span class="font-mono">{inlayId}</span>
            </span>
        {/if}
    </span>
</label>
