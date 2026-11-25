<script lang="ts">
    import { language } from "src/lang";
    import { clientName } from "src/ts/network/handoff";

    // One name per browser: the feed registers it for both job handoff and remote host mode, and a
    // sending device remembers its host by this name.
</script>

<label class="flex flex-col gap-1 mt-4 text-textcolor">
    <span>{language.deviceLink.name}</span>
    <input
        type="text"
        maxlength="64"
        bind:value={$clientName}
        class="bg-darkbg text-textcolor border border-darkborderc rounded-md px-3 py-2"
    />
    <span class="text-sm text-textcolor2">{language.deviceLink.nameHelp}</span>
</label>
