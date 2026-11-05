<script lang="ts">
    import { language } from "src/lang";
    import { handoffWork } from "src/ts/network/handoff";
</script>

<!-- Worker progress stays non-modal and independent of job dialogs and transient toasts. -->
{#if $handoffWork.size > 0}
    <div
        class="fixed bottom-2 right-2 z-40 max-w-[calc(100%-1rem)] pointer-events-none bg-darkbg text-textcolor2 border border-darkborderc rounded-md px-3 py-2 text-sm"
        role="status"
        aria-live="polite"
    >
        {#each [...$handoffWork.values()] as job (job.jobId)}
            <p>{language.serverJob.handoff[job.phase].replace("{character}", () => job.characterName)}</p>
        {/each}
    </div>
{/if}
