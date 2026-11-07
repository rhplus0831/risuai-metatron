<script lang="ts">
    import { EllipsisIcon, LockKeyholeIcon, PinIcon, PinOffIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { getStorageController } from "./storageContext";

    const controller = getStorageController();
    let openMenu: string | null = $state(null);
    let menuTrigger: HTMLButtonElement | undefined;

    function closeOutside(event: MouseEvent) {
        if (openMenu !== null && event.target instanceof Node && !menuTrigger?.parentElement?.contains(event.target)) {
            openMenu = null;
        }
    }

    function closeOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape" && !event.isComposing && openMenu !== null) {
            event.preventDefault();
            event.stopPropagation();
            openMenu = null;
            menuTrigger?.focus();
        }
    }
</script>

<svelte:window onclickcapture={closeOutside} onkeydowncapture={closeOnEscape} />

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
        <input
            class="min-w-0 flex-1 rounded-md border border-darkborderc bg-darkbg p-2 text-textcolor"
            type="text"
            aria-label={language.storage.optionalLabel}
            placeholder={language.storage.optionalLabel}
            bind:value={controller.snapshotLabel}
            disabled={controller.busy || controller.running}
        />
        <Button size="sm" disabled={controller.busy || controller.running} onclick={controller.take}
            >{language.storage.takeSnapshot}</Button
        >
    </div>
    <p class="text-textcolor2">{language.storage.heldBytesNote}</p>
    <ul class="min-w-0 rounded-md border border-darkborderc bg-darkbg">
        {#each controller.snapshots as snapshot (snapshot.id)}
            {@const heldBytes = controller.report?.snapshots.find((item) => item.id === snapshot.id)?.heldBytes}
            <li class="flex min-w-0 flex-col gap-2 border-b border-darkborderc p-2 last:border-b-0">
                <div class="flex min-w-0 items-center gap-2">
                    <button
                        type="button"
                        class="shrink-0 rounded-md p-2 hover:bg-bgcolor focus-visible:ring-2 focus-visible:ring-selected disabled:opacity-50"
                        aria-label={snapshot.pinned ? language.storage.unpin : language.storage.pin}
                        aria-pressed={snapshot.pinned}
                        title={snapshot.pinned ? language.storage.unpin : language.storage.pin}
                        disabled={controller.busy || controller.running}
                        onclick={() => controller.pin(snapshot.id, snapshot.pinned)}
                    >
                        {#if snapshot.pinned}
                            <PinIcon size={16} aria-hidden="true" />
                        {:else}
                            <PinOffIcon size={16} class="text-textcolor2" aria-hidden="true" />
                        {/if}
                    </button>
                    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                        <span
                            class="min-w-0 flex-1 basis-32 truncate"
                            title={snapshot.label || language.storagePage.snapshots.noLabel}
                            >{snapshot.label || language.storagePage.snapshots.noLabel}</span
                        >
                        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-textcolor2">
                            <span class="wrap-anywhere" title={language.storage.createdAt}
                                >{controller.date(snapshot.createdAt)}</span
                            >
                            <span title={language.storage.bytes}>{controller.formatBytes(snapshot.size)}</span>
                            <span class="inline-flex min-w-0 items-center gap-1" title={language.storage.heldBytes}>
                                <LockKeyholeIcon size={12} class="shrink-0" aria-hidden="true" />
                                <span
                                    >{heldBytes === undefined
                                        ? language.storage.missingValue
                                        : controller.formatBytes(heldBytes)}</span
                                >
                            </span>
                        </div>
                    </div>
                    <div class="relative shrink-0">
                        <button
                            type="button"
                            class="rounded-md p-2 hover:bg-bgcolor focus-visible:ring-2 focus-visible:ring-selected disabled:opacity-50"
                            aria-label={language.storagePage.snapshots.actions}
                            aria-haspopup="menu"
                            aria-expanded={openMenu === snapshot.id}
                            disabled={controller.busy || controller.running}
                            onclick={(event) => {
                                menuTrigger = event.currentTarget;
                                openMenu = openMenu === snapshot.id ? null : snapshot.id;
                            }}
                        >
                            <EllipsisIcon size={16} aria-hidden="true" />
                        </button>
                        {#if openMenu === snapshot.id}
                            <div
                                role="menu"
                                aria-label={language.storagePage.snapshots.actions}
                                class="absolute right-0 top-full z-10 mt-1 w-40 max-w-[calc(100vw-4rem)] rounded-md border border-darkborderc bg-darkbg p-1 shadow-lg"
                            >
                                <button
                                    type="button"
                                    class="w-full rounded-sm px-3 py-2 text-start hover:bg-bgcolor focus-visible:ring-2 focus-visible:ring-selected disabled:opacity-50"
                                    disabled={controller.busy || controller.running}
                                    onclick={() => {
                                        openMenu = null;
                                        controller.editingLabel = snapshot.id;
                                        controller.labelText = snapshot.label ?? "";
                                    }}>{language.storagePage.snapshots.editLabel}</button
                                >
                                <button
                                    type="button"
                                    class="w-full rounded-sm px-3 py-2 text-start hover:bg-bgcolor focus-visible:ring-2 focus-visible:ring-selected disabled:opacity-50"
                                    disabled={controller.busy || controller.running}
                                    onclick={() => {
                                        openMenu = null;
                                        controller.restore(snapshot.id, snapshot.createdAt);
                                    }}>{language.storage.restore}</button
                                >
                                <button
                                    type="button"
                                    class="w-full rounded-sm px-3 py-2 text-start text-draculared hover:bg-bgcolor focus-visible:ring-2 focus-visible:ring-selected disabled:opacity-50"
                                    disabled={controller.busy || controller.running}
                                    onclick={() => {
                                        openMenu = null;
                                        controller.removeSnapshot(snapshot.id, snapshot.createdAt);
                                    }}>{language.storage.deleteSnapshot}</button
                                >
                            </div>
                        {/if}
                    </div>
                </div>
                {#if controller.unreadable(snapshot.id)}<p class="text-draculared break-all">
                        {language.storage.unreadableSnapshot}
                    </p>{/if}
                {#if controller.editingLabel === snapshot.id}
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                        <input
                            class="min-w-0 flex-1 rounded-md border border-darkborderc bg-bgcolor p-2 text-textcolor"
                            type="text"
                            aria-label={language.storage.snapshotLabel}
                            bind:value={controller.labelText}
                            disabled={controller.busy || controller.running}
                        />
                        <Button
                            size="sm"
                            disabled={controller.busy || controller.running}
                            onclick={() => controller.saveLabel(snapshot.id)}>{language.storage.save}</Button
                        >
                        <Button
                            size="sm"
                            disabled={controller.busy}
                            onclick={() => {
                                controller.editingLabel = null;
                            }}>{language.storage.cancel}</Button
                        >
                    </div>
                {/if}
            </li>
        {:else}
            {#if !controller.loading}<li class="p-2 text-textcolor2">{language.storage.emptySnapshots}</li>{/if}
        {/each}
    </ul>
</div>
