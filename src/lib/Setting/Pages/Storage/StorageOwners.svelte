<script lang="ts">
    import { language } from "src/lang";
    import { getStorageController } from "./storageContext";
    import { getTopOwners } from "./storageUsage";

    const controller = getStorageController();
    const uid = $props.id();
    let showAll = $state(false);
    const usage = $derived(
        controller.report ? getTopOwners(controller.report, showAll ? controller.report.owners.length : 10) : null,
    );
</script>

<div class="mt-2 flex min-w-0 flex-col gap-3 text-sm text-textcolor">
    {#if usage}
        <p class="text-textcolor2">{language.storage.sharesNote}</p>
        <div
            id={uid}
            role="table"
            aria-label={language.storagePage.owners.title}
            aria-colcount="4"
            class="min-w-0 rounded-md border border-darkborderc bg-darkbg"
        >
            <div
                role="row"
                class="sr-only gap-x-3 px-3 py-2 text-textcolor2 sm:not-sr-only sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]"
            >
                <span role="columnheader">{language.storage.ownerKind}</span>
                <span role="columnheader">{language.storage.name}</span>
                <span role="columnheader" class="text-right">{language.storage.count}</span>
                <span role="columnheader" class="text-right">{language.storage.bytes}</span>
            </div>
            {#each usage.owners as owner (`${owner.kind}:${owner.id}`)}
                <div role="row" class="owner-row min-w-0 gap-x-3 gap-y-1 border-t border-darkborderc p-3">
                    <div role="cell" class="owner-kind min-w-0 text-xs text-textcolor2 break-words">
                        {language.storage.ownerKinds[owner.kind]}
                    </div>
                    <div role="cell" class="owner-name min-w-0 break-all">{owner.name}</div>
                    <div role="cell" class="owner-count min-w-0 text-right tabular-nums break-all">
                        {owner.count.toLocaleString()}
                    </div>
                    <div role="cell" class="owner-bytes min-w-0 text-right tabular-nums break-words">
                        {controller.formatBytes(owner.bytes)}
                    </div>
                    <div class="owner-bar mt-1 h-1.5 overflow-hidden rounded-full bg-selected" aria-hidden="true">
                        <div class="h-full rounded-full bg-primary-500" style:width={`${owner.fraction * 100}%`}></div>
                    </div>
                </div>
            {/each}
        </div>
        {#if usage.totalCount > 10}
            <button
                type="button"
                aria-expanded={showAll}
                aria-controls={uid}
                class="self-start rounded-md border border-darkborderc bg-darkbutton px-3 py-1.5 text-sm hover:bg-selected focus-visible:outline-2 focus-visible:outline-primary-500"
                onclick={() => {
                    showAll = !showAll;
                }}
            >
                {showAll
                    ? language.storagePage.owners.showFewer
                    : language.storagePage.owners.showAll(usage.totalCount)}
            </button>
        {/if}
    {/if}
</div>

<style>
    .owner-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, auto);
        grid-template-areas: "kind count" "name bytes" "bar bar";
    }
    .owner-kind {
        grid-area: kind;
    }
    .owner-name {
        grid-area: name;
    }
    .owner-count {
        grid-area: count;
    }
    .owner-bytes {
        grid-area: bytes;
    }
    .owner-bar {
        grid-area: bar;
    }

    @media (min-width: 640px) {
        .owner-row {
            grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
            grid-template-areas: "kind name count bytes" "bar bar bar bar";
        }
    }
</style>
