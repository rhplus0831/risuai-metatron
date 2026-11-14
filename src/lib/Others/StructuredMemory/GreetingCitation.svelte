<script lang="ts">
    import { language } from "src/lang";
    import { alertError } from "src/ts/alert";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import {
        editStructuredMemory,
        memoryGreetingChanged,
        type MemoryPanelTabProps,
    } from "src/ts/process/structuredMemory.svelte";
    import {
        memoryRerecordTarget,
        type MemoryGreetingSource,
        type StructuredMemoryCoverageEvent,
    } from "../../../../shared/structuredMemory.ts";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { pressMemoryRecord } from "./memoryRecordPress";
    import { memoryReadFailureText } from "./memoryText";

    /** A citation's changed label is display-only. Repairs name the revision and greeting shown here. */
    let {
        event,
        current,
        chatRef,
        revision,
        readOnly,
        jump,
        rebuild,
        refreshed,
    }: {
        event: StructuredMemoryCoverageEvent;
        current: MemoryGreetingSource | null | undefined;
        chatRef: ChatRef;
        revision: string;
        readOnly: boolean;
        jump: MemoryPanelTabProps["jump"];
        rebuild: MemoryPanelTabProps["rebuild"];
        refreshed: () => void | Promise<void>;
    } = $props();

    const text = language.structuredMemory.greeting;
    let sending = $state(false);
    const changed = $derived(current !== undefined && memoryGreetingChanged(event, current));
    const off = $derived(readOnly || sending || event.status === "retracted");
    const target = $derived(
        memoryRerecordTarget(event.sources, findChat(chatRef)?.message ?? [], event.greeting, current != null),
    );

    async function repair(kind: "keepGreeting" | "rerecord") {
        if (off || (kind === "keepGreeting" ? current == null : target === null)) return;
        const ref = chatRef;
        const shown = current;
        const through = target;
        const owner = characterList().find((entry) => entry?.chaId === ref.chaId);
        const sameChat = () => ref.chaId === chatRef.chaId && ref.chatId === chatRef.chatId;
        sending = true;
        try {
            const result =
                kind === "rerecord" && event.rerecord
                    ? { outcome: "ok" as const }
                    : await editStructuredMemory(
                          ref,
                          revision,
                          kind === "keepGreeting"
                              ? { kind: "event", eventId: event.id, repair: kind, greeting: shown! }
                              : { kind: "event", eventId: event.id, repair: kind },
                      );
            if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
                alertError(memoryReadFailureText(result));
            }
            if (!sameChat()) return;
            await refreshed();
            if (result.outcome === "ok" && kind === "rerecord" && through && owner && sameChat() && !readOnly) {
                await pressMemoryRecord(owner, ref, "messageId" in through ? through.messageId : undefined);
                if (sameChat()) await refreshed();
            }
        } finally {
            sending = false;
        }
    }
</script>

<div class="flex flex-col min-w-0 gap-1" data-memory-greeting-source={event.id}>
    <div class="flex flex-wrap items-baseline gap-1">
        <MemoryLinkButton label={text.source} onclick={() => jump({ greeting: true })} />
        {#if changed}
            <span class="px-1.5 rounded-sm bg-darkbutton text-secondary-500" data-memory-greeting-changed
                >{text.changed}</span
            >
        {/if}
    </div>
    {#if changed}
        <p class="text-textcolor2">{text.help}</p>
        <div class="flex flex-wrap gap-2">
            <Button size="sm" styled="outlined" disabled={off || target === null} onclick={() => repair("rerecord")}>
                {language.structuredMemory.timeline.repairs.rerecord}
            </Button>
            <Button size="sm" styled="outlined" disabled={off || !rebuild} onclick={() => rebuild?.()}>
                {language.structuredMemory.rebuild.rebuild}
            </Button>
            <Button
                size="sm"
                styled="outlined"
                disabled={off || current == null}
                onclick={() => repair("keepGreeting")}
            >
                {text.keep}
            </Button>
        </div>
    {/if}
</div>
