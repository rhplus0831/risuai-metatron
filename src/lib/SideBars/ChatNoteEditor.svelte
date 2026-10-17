<script lang="ts">
    import { language } from "src/lang";
    import { findChat, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { tokenizeAccurate } from "src/ts/tokenizer";
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
    let tokenRun = 0;

    $effect(() => {
        const text = note;
        const run = ++tokenRun;
        let idleCallback: number | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const countTokens = () => {
            if (run !== tokenRun) return;
            tokenizeAccurate(text).then((count) => {
                if (run === tokenRun) {
                    noteTokens = count;
                }
            });
        };

        if (text === "") {
            noteTokens = 0;
        } else if (run === 1) {
            // Let the chat's message bodies render before starting the first tokenizer load.
            if (typeof window.requestIdleCallback === "function") {
                idleCallback = window.requestIdleCallback(countTokens, { timeout: 2000 });
            } else {
                timer = setTimeout(countTokens, 1000);
            }
        } else {
            timer = setTimeout(countTokens, 300);
        }

        return () => {
            ++tokenRun;
            if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback);
            if (timer !== undefined) clearTimeout(timer);
        };
    });
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
