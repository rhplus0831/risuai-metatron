<script lang="ts">
    import { language } from "src/lang";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { acceptHandoffs, preferHandoff, clientName } from "src/ts/network/handoff";

    // These stores belong to this browser, independent of the synced settings records.
</script>

<div class="flex flex-col gap-2 mt-4 text-textcolor">
    <CheckInput bind:check={$acceptHandoffs} name={language.serverJob.handoff.acceptHandoffs} />
    <p class="text-sm text-textcolor2">{language.serverJob.handoff.acceptHelp}</p>
    <CheckInput bind:check={$preferHandoff} name={language.serverJob.handoff.preferHandoff} />
    <p class="text-sm text-textcolor2">{language.serverJob.handoff.preferHelp}</p>
    <label class="flex flex-col gap-1">
        <span>{language.serverJob.handoff.clientName}</span>
        <input
            type="text"
            maxlength="64"
            bind:value={$clientName}
            class="bg-darkbg text-textcolor border border-darkborderc rounded-md px-3 py-2"
        />
    </label>
</div>
