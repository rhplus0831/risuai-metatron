<script lang="ts">
    import { language } from "src/lang";
    import { hypaV3ProgressStore, type MemoryProgressEntry } from "src/ts/stores.svelte";

    interface Props {
        /** The selected chat's memory run; without one, the legacy overlay's text. */
        entry?: MemoryProgressEntry | null;
    }

    let { entry = null }: Props = $props();

    let isExpanded = $state(false);

    const toggleExpand = () => {
        isExpanded = !isExpanded;
    };

    const phaseLabels = {
        blocking: () => language.hypaV3Progress.phaseBlocking,
        initial: () => language.hypaV3Progress.phaseInitial,
        selection: () => language.hypaV3Progress.phaseSelection,
    };
    const reasonLabels = {
        pluginModel: () => language.hypaV3Progress.reasonPluginModel,
        requestTrigger: () => language.hypaV3Progress.reasonRequestTrigger,
        gap: () => language.hypaV3Progress.reasonGap,
    };

    /** The summary counts, when the run reports them. */
    const counts = $derived(
        entry && entry.done !== undefined && entry.total !== undefined
            ? { done: entry.done, total: entry.total }
            : null,
    );
    /** The bar's filled share, 0 to 1; null shows the indeterminate bar. */
    const ratio = $derived(counts && counts.total > 0 ? Math.min(1, Math.max(0, counts.done / counts.total)) : null);

    const title = $derived(entry ? phaseLabels[entry.phase]() : $hypaV3ProgressStore.msg || "");
    const reason = $derived(entry?.reason ? reasonLabels[entry.reason]() : "");
    const detail = $derived(
        entry ? (counts ? `${counts.done}/${counts.total}` : (entry.text ?? "")) : $hypaV3ProgressStore.subMsg || "",
    );
    const mini = $derived(
        entry ? (counts ? `${counts.done}/${counts.total}` : "") : $hypaV3ProgressStore.miniMsg || "",
    );

    const stop = () => {
        if (!entry || entry.phase !== "initial" || entry.stop !== "idle") {
            return;
        }
        // The run the button was shown for, not whichever is shown when the request goes out.
        const { jobId, runId } = entry;
        void import("src/ts/network/jobChannel")
            .then(({ stopMemoryRun }) => stopMemoryRun(jobId, runId))
            .catch((error) => console.error("[HypaV3Progress]", error));
    };
</script>

{#if isExpanded}
    <div class="absolute w-full h-full z-40 flex justify-center items-center pointer-events-none">
        <div
            class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl max-h-full overflow-y-auto transition-opacity duration-300 pointer-events-auto"
        >
            <button
                class="flex flex-col"
                type="button"
                aria-expanded="true"
                title={language.hypaV3Progress.collapse}
                onclick={toggleExpand}
            >
                <span class="mb-6 text-left text-textcolor2 text-sm">{title}</span>
                {#if reason}
                    <span class="-mt-4 mb-6 text-left text-textcolor2 text-xs" data-memory-reason>{reason}</span>
                {/if}
            </button>
            {#if ratio !== null}
                <div
                    class="w-full min-w-64 md:min-w-138 h-2 bg-darkbg border border-darkborderc rounded-md"
                    role="progressbar"
                    aria-label={title}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(ratio * 100)}
                    aria-valuetext={detail}
                >
                    <div
                        class="h-full bg-linear-to-r from-primary-500 to-secondary-700 transition-[width]"
                        style:width="{ratio * 100}%"
                    ></div>
                </div>
            {:else}
                <div class="w-full min-w-64 md:min-w-138 h-2 bg-darkbg border border-darkborderc rounded-md">
                    <div
                        class="h-full bg-linear-to-r from-blue-500 to-purple-800 saving-animation transition-[width]"
                    ></div>
                </div>
            {/if}
            <span class="w-full mt-6 text-center text-textcolor2 text-sm">{detail}</span>
            {#if entry?.phase === "initial"}
                <button
                    class="mt-4 self-center px-4 py-2 rounded-md border border-darkborderc bg-darkbutton text-textcolor text-sm hover:bg-selected disabled:opacity-60 disabled:cursor-not-allowed"
                    type="button"
                    data-memory-stop
                    disabled={entry.stop !== "idle"}
                    onclick={stop}
                >
                    {entry.stop === "requested" ? language.hypaV3Progress.stopping : language.hypaV3Progress.stopButton}
                </button>
            {/if}
        </div>
    </div>
{:else}
    <button
        class="fixed top-4 right-4 z-40 bg-darkbg p-2 rounded-full shadow-lg transition-all duration-300 flex items-center justify-center"
        type="button"
        style="opacity: 0.8;"
        aria-expanded="false"
        aria-label={language.hypaV3Progress.expand}
        onclick={toggleExpand}
        onmouseenter={(e) => (e.currentTarget.style.opacity = "1")}
        onmouseleave={(e) => (e.currentTarget.style.opacity = "0.8")}
    >
        <div class="w-8 h-8 relative">
            <div class="absolute inset-0 border-t-2 border-red-500 rounded-full animate-spin"></div>
            <div class="absolute inset-1 flex items-center justify-center text-xs text-textcolor2">
                {mini}
            </div>
        </div>
    </button>
{/if}
