<script lang="ts">
    import { language } from "src/lang";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { hostMode } from "src/ts/network/remoteHost";
</script>

<div class="flex flex-col gap-2 mt-4 text-textcolor">
    <CheckInput bind:check={$hostMode} name={language.serverJob.remoteHost.label} />
    <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.help}</p>
</div>
