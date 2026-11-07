<script lang="ts">
    import { FileIcon, ImageIcon, MusicIcon, VideoIcon } from "@lucide/svelte";
    import { loadAssetPreview } from "src/ts/storage/assetLifecycleClient";
    import { assetExtension, isActiveAssetExtension } from "../../../../../shared/assetMime.ts";
    import { cleanupAssetKind } from "./storageCleanup";

    /** The asset key owns the URL; equal keys in fresh reports keep their loaded preview. */
    const { assetKey, generatedAt }: { assetKey: string | null; generatedAt: number | null } = $props();
    // A prop getter can depend on the whole report row. Compare its string value before the
    // lifetime effect, so replacing that row with an equal key does not release its preview.
    const previewKey = $derived(assetKey);
    const kind = $derived(cleanupAssetKind(assetKey));
    const icon = $derived(
        kind === "image" ? ImageIcon : kind === "audio" ? MusicIcon : kind === "video" ? VideoIcon : FileIcon,
    );
    let anchor: HTMLSpanElement | undefined = $state();
    let src = $state("");
    let failPreview: (() => void) | undefined;

    $effect(() => {
        const key = previewKey;
        src = "";
        if (
            !anchor ||
            key === null ||
            cleanupAssetKind(key) !== "image" ||
            isActiveAssetExtension(assetExtension(key))
        ) {
            return;
        }
        let visible = $state(typeof IntersectionObserver === "undefined");
        let failed = $state(false);
        let disposed = false;
        let attemptedAt: number | null | undefined;
        let preview: ReturnType<typeof loadAssetPreview> | undefined;
        const observer =
            typeof IntersectionObserver === "undefined"
                ? undefined
                : new IntersectionObserver(
                      (entries) => {
                          visible = entries.some((entry) => entry.isIntersecting);
                      },
                      { rootMargin: "0px" },
                  );
        observer?.observe(anchor);

        failPreview = () => {
            preview?.release();
            src = "";
            failed = true;
        };

        // This child effect can retry a failed image on a newer report without ending the key's
        // lifetime or releasing a successful preview. Offscreen rows keep their loaded URL.
        $effect(() => {
            const reportTime = generatedAt;
            if (!visible || (preview && !failed) || attemptedAt === reportTime) return;
            attemptedAt = reportTime;
            failed = false;
            const request = loadAssetPreview(key);
            preview = request;
            request.src.then(
                (url) => {
                    if (!disposed && preview === request) src = url;
                },
                () => {
                    if (!disposed && preview === request) failPreview?.();
                },
            );
        });

        return () => {
            disposed = true;
            observer?.disconnect();
            preview?.release();
            failPreview = undefined;
        };
    });
</script>

<span
    bind:this={anchor}
    class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-darkbutton text-textcolor2"
>
    {#if src}
        <img {src} alt="" class="h-full w-full object-contain" onerror={() => failPreview?.()} />
    {:else}
        {@const Icon = icon}
        <Icon size={24} aria-hidden="true" />
    {/if}
</span>
