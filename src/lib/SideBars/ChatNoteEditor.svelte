<script lang="ts">
    import { language } from "src/lang";
    import { findChat, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { tokenScopeKey, tokenizeAccurate } from "src/ts/tokenizer";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import { onDestroy, untrack } from "svelte";
    import { getAuthorNoteDefaultText } from "src/ts/util";
    import Help from "../Others/Help.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";

    interface Props {
        /** The chat this editor writes to; read once (the parent recreates the editor for another chat). */
        chat: ChatRef;
    }

    let { chat }: Props = $props();
    // Captured at creation, not read at write time: the field commits its value again on `change`,
    // which can fire while it is removed after the selection already moved to another character (a
    // character hotkey from the focused field), and must still land in this chat.
    // svelte-ignore state_referenced_locally
    const owner: ChatRef = { chaId: chat.chaId, chatId: chat.chatId };
    const note = $derived(findChat(owner)?.note ?? "");
    let noteTokens = $state(0);
    type NoteTokenCountInput = { text: string; scope: string } | { error: unknown };
    const tokenField = createTokenCountField<NoteTokenCountInput>({
        count: async (input, signal) => {
            if ("error" in input) throw input.error;
            return input.text === "" ? 0 : tokenizeAccurate(input.text, undefined, signal);
        },
        apply: (count) => (noteTokens = count),
        same: (a, b) => !("error" in a) && !("error" in b) && a.text === b.text && a.scope === b.scope,
        scheduleFirst: (run) => {
            if (untrack(() => note === "")) {
                run();
                return () => {};
            }
            // Let the chat's message bodies render before CBS expansion and the first count.
            if (typeof window.requestIdleCallback === "function") {
                const idleCallback = window.requestIdleCallback(run, { timeout: 2000 });
                return () => window.cancelIdleCallback(idleCallback);
            }
            const timer = setTimeout(run, 1000);
            return () => clearTimeout(timer);
        },
    });

    $effect(() => {
        const text = note;
        let input: NoteTokenCountInput;
        try {
            input = { text, scope: tokenScopeKey() };
        } catch (error) {
            input = { error };
        }
        tokenField.update(input);
        if (text === "") noteTokens = 0;
    });

    onDestroy(() => tokenField.dispose());
</script>

<span class="text-textcolor">{language.authorNote} <Help key="chatNote" /></span>
<TextAreaInput
    margin="both"
    autocomplete="off"
    bind:value={
        () => note,
        (value) => {
            // A chat removed or unloaded meanwhile takes no write (a late `change`).
            if (findChat(owner)) {
                setChatMeta(owner, { note: value });
            }
        }
    }
    highlight
    placeholder={getAuthorNoteDefaultText()}
/>
<span class="text-textcolor2 mb-6 text-sm">{noteTokens} {language.tokens}</span>
