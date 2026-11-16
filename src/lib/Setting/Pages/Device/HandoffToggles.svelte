<script lang="ts">
    import { language } from "src/lang";
    import Alert from "src/lib/UI/GUI/Alert.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { acceptHandoffs, preferHandoff } from "src/ts/network/handoff";

    // These stores belong to this browser, independent of the synced settings records.
</script>

<div class="flex flex-col gap-2 mt-4 text-textcolor">
    <Alert status="warning" role="note">{language.deviceLink.handoffWarning}</Alert>
    <CheckInput bind:check={$acceptHandoffs} name={language.serverJob.handoff.acceptHandoffs} />
    <p class="text-sm text-textcolor2">{language.serverJob.handoff.acceptHelp}</p>
    <CheckInput bind:check={$preferHandoff} name={language.serverJob.handoff.preferHandoff} />
    <p class="text-sm text-textcolor2">{language.serverJob.handoff.preferHelp}</p>
</div>
