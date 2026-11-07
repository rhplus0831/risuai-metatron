<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { getStorageController } from "./storageContext";

    const controller = getStorageController();
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    <p class="text-textcolor2">{language.storage.heldBytesNote}</p>
    <div class="flex flex-wrap items-center gap-2">
        <input
            class="min-w-0 rounded-md border border-darkborderc bg-darkbg p-2 text-textcolor"
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
    <ul class="max-h-64 overflow-auto rounded-md border border-darkborderc bg-darkbg">
        {#each controller.snapshots as snapshot (snapshot.id)}
            {@const heldBytes = controller.report?.snapshots.find((item) => item.id === snapshot.id)?.heldBytes}
            <li class="flex flex-col gap-2 border-b border-darkborderc p-2">
                <dl class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <div>
                        <dt class="text-textcolor2">{language.storage.createdAt}</dt>
                        <dd class="break-all">{controller.date(snapshot.createdAt)}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.bytes}</dt>
                        <dd>{controller.formatBytes(snapshot.size)}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.snapshotLabel}</dt>
                        <dd class="break-all">{snapshot.label ?? language.storage.none}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.pinnedState}</dt>
                        <dd>{snapshot.pinned ? language.storage.pinned : language.storage.unpinned}</dd>
                    </div>
                    <div>
                        <dt class="text-textcolor2">{language.storage.heldBytes}</dt>
                        <dd>
                            {heldBytes === undefined
                                ? language.storage.missingValue
                                : controller.formatBytes(heldBytes)}
                        </dd>
                    </div>
                </dl>
                {#if controller.unreadable(snapshot.id)}<p class="text-draculared break-all">
                        {language.storage.unreadableSnapshot}
                    </p>{/if}
                <div class="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        disabled={controller.busy || controller.running}
                        onclick={() => controller.pin(snapshot.id, snapshot.pinned)}
                        >{snapshot.pinned ? language.storage.unpin : language.storage.pin}</Button
                    >
                    <Button
                        size="sm"
                        disabled={controller.busy || controller.running}
                        onclick={() => {
                            controller.editingLabel = snapshot.id;
                            controller.labelText = snapshot.label ?? "";
                        }}>{language.storage.label}</Button
                    >
                    <Button
                        size="sm"
                        disabled={controller.busy || controller.running}
                        onclick={() => controller.restore(snapshot.id, snapshot.createdAt)}
                        >{language.storage.restore}</Button
                    >
                    <Button
                        size="sm"
                        disabled={controller.busy || controller.running}
                        onclick={() => controller.removeSnapshot(snapshot.id, snapshot.createdAt)}
                        >{language.storage.deleteSnapshot}</Button
                    >
                </div>
                {#if controller.editingLabel === snapshot.id}
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            class="min-w-0 rounded-md border border-darkborderc bg-bgcolor p-2 text-textcolor"
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
