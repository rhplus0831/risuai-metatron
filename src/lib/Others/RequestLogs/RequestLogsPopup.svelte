<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertStore } from "src/ts/stores.svelte";
    import ServerRequestHistory from "./ServerRequestHistory.svelte";
    import TabRequestLogs from "./TabRequestLogs.svelte";

    /**
     * The `requestlogs` popup (`alertRequestLogs`): the server's request history, and this tab's own
     * request log for what only the browser saw.
     */
    let tab: "server" | "tab" = $state("server");
</script>

<div class="fixed inset-0 z-50 bg-black/80 flex justify-center items-start overflow-y-auto p-4">
    <div class="bg-darkbg rounded-lg w-full max-w-4xl my-4 flex flex-col max-h-[90vh]">
        <div class="flex items-center justify-between p-4 border-b border-darkborderc sticky top-0 bg-darkbg z-10">
            <h1 class="text-xl font-bold text-textcolor">{language.ShowLog}</h1>
            <button
                class="text-textcolor2 hover:text-textcolor p-1"
                onclick={() => {
                    alertStore.set({ type: "none", msg: "" });
                }}
            >
                <XIcon />
            </button>
        </div>
        <div class="flex gap-1 px-4 pt-3 border-b border-darkborderc">
            {#each [["server", language.requestHistoryServerTab], ["tab", language.requestHistoryThisTab]] as const as [id, label]}
                <button
                    class="px-3 py-2 text-sm rounded-t-md border-b-2 transition-colors {tab === id
                        ? 'border-selected text-textcolor'
                        : 'border-transparent text-textcolor2 hover:text-textcolor'}"
                    onclick={() => (tab = id)}
                >
                    {label}
                </button>
            {/each}
        </div>
        <div class="flex-1 overflow-y-auto p-4">
            {#if tab === "server"}
                <ServerRequestHistory />
            {:else}
                <TabRequestLogs />
            {/if}
        </div>
    </div>
</div>
