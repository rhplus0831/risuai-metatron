<script module lang="ts">
    import type { ComponentProps } from "svelte";
    import type Chats from "../Chats.svelte";

    type ChatsProps = ComponentProps<typeof Chats>;
    export interface ChatsControl {
        followsLatest: (props: ChatsProps) => boolean;
        scrollToLatestMessage: (props: ChatsProps) => void;
        readProps: (() => ChatsProps) | null;
        setHolding: ((holding: boolean) => void) | null;
    }

    let control: ChatsControl;
    export function setChatsControl(next: ChatsControl) {
        control = next;
    }
</script>

<script lang="ts">
    let { holding = $bindable(false), ...props }: ChatsProps = $props();

    const readProps = () => ({ ...props, holding });
    control.readProps = readProps;
    control.setHolding = (held) => {
        holding = held;
    };

    export function followsLatest() {
        return control.followsLatest(readProps());
    }

    export function scrollToLatestMessage() {
        control.scrollToLatestMessage(readProps());
    }
</script>

<!-- The transcript's reply controls invoke the callbacks supplied by the real screen. -->
<button class="button-icon-unreroll" onclick={props.unReroll}>Undo Reroll</button>
<button class="button-icon-reroll" onclick={props.onReroll}>Reroll</button>
