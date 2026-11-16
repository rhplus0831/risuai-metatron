<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { hostMode } from "src/ts/network/remoteHost";

    // Host mode is entered, not toggled: its lock screen replaces this page at once and holds the
    // only control that leaves it. The home screen offers the same action.
</script>

<div class="flex flex-col items-start gap-2 mt-4 text-textcolor">
    <Button onclick={() => hostMode.set(true)}>{language.serverJob.remoteHost.start}</Button>
    <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.help}</p>
</div>
