<!-- Test-only: provides a `ChatStyleRegistry` to its `ChatBody` rows and hosts its container after them,
     as `DefaultChatScreen` does for the chat rows (heap plan C2). Rows are laid out in the order given. -->
<script lang="ts">
    import { ChatStyleRegistry, setChatStyleRegistry } from "src/ts/parser/chatStyles";
    import ChatBody from "../ChatBody.svelte";

    interface Body {
        id: string;
        idx: number;
        msgDisplay: string;
    }

    interface Props {
        registry: ChatStyleRegistry;
        bodies: readonly Body[];
    }

    const { registry, bodies }: Props = $props();
    // The registry is set once, at initialization, as `DefaultChatScreen` does.
    // svelte-ignore state_referenced_locally
    setChatStyleRegistry(registry);
</script>

<div data-rows>
    {#each bodies as body (body.id)}
        <div class="chattext" data-body={body.id}>
            <ChatBody
                msgDisplay={body.msgDisplay}
                idx={body.idx}
                role="char"
                translated={false}
                translating={false}
                retranslate={false}
                modelShortName=""
            />
        </div>
    {/each}
</div>
<div hidden {@attach (host) => registry.attach(host)}></div>
