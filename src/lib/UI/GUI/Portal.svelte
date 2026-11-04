<script lang="ts">
    import { getAllContexts, mount, unmount } from "svelte";
    import PortalConsumer from "./PortalConsumer.svelte";

    /**
     * Mounts its children as a separate root in `target` (default `document.body`) with the caller's contexts. A
     * target outside an isolated ancestor, such as the default, lets the content escape that stacking context (the
     * chat screen's `isolate`, `src/lib/ChatScreens/ChatScreen.svelte`) while it still reads the caller's contexts.
     */

    interface Props {
        target?: HTMLElement;
        children: any;
    }

    const { target: target = document.body, children }: Props = $props();

    const context = getAllContexts();

    let instance;

    $effect(() => {
        instance = mount(PortalConsumer, { target, props: { children }, context });

        return () => {
            unmount(instance);
        };
    });
</script>
