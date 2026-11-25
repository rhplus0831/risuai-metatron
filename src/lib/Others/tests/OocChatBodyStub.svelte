<script lang="ts">
    import type { ComponentProps } from "svelte";
    import type ChatBody from "../../ChatScreens/ChatBody.svelte";

    let {
        msgDisplay,
        role,
        idx,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
    }: ComponentProps<typeof ChatBody> = $props();
</script>

<!-- Expose the real child's input boundary without loading the Markdown/translation pipeline. -->
<div data-chat-body data-msg-display={msgDisplay} data-role={role} data-idx={idx}>{msgDisplay}</div>
