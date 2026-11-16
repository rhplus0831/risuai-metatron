<script lang="ts">
    import { language } from "src/lang";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { acceptHandoffs, preferHandoff } from "src/ts/network/handoff";

    // These stores belong to this browser, independent of the synced settings records.
</script>

<div class="flex flex-col gap-2 mt-4 text-textcolor">
    <p class="rounded-md border border-draculared/50 p-2 text-sm text-draculared" role="note">
        {language.deviceLink.handoffWarning}
    </p>
    <CheckInput bind:check={$acceptHandoffs} name={language.serverJob.handoff.acceptHandoffs} />
    <p class="text-sm text-textcolor2">{language.serverJob.handoff.acceptHelp}</p>
    <CheckInput bind:check={$preferHandoff} name={language.serverJob.handoff.preferHandoff} />
    <p class="text-sm text-textcolor2">{language.serverJob.handoff.preferHelp}</p>
</div>
