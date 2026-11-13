<script lang="ts">
    interface Props {
        min?: number;
        max?: number;
        size?: "sm" | "md" | "lg";
        value: number;
        id?: string;
        padding?: boolean;
        marginBottom?: boolean;
        fullwidth?: boolean;
        fullh?: boolean;
        onChange?: (
            event: Event & {
                currentTarget: EventTarget & HTMLInputElement;
            },
        ) => any;
        className?: string;
        disabled?: boolean;
        placeholder?: string;
    }

    let {
        min = undefined,
        max = undefined,
        size = "sm",
        value = $bindable(),
        id = undefined,
        padding = true,
        marginBottom = false,
        fullwidth = false,
        fullh = false,
        onChange = () => {},
        className = "",
        disabled = false,
        placeholder,
    }: Props = $props();

    // A function binding's setter may refuse an entry (a cleared box, a value out of range) and keep
    // the stored value; Svelte would then rewrite the box with it on the same keystroke, so a last
    // digit could never be deleted. While the box is being edited it shows what was typed instead;
    // a commit (`change`) or leaving the box shows the bound value again, as does an outside change
    // made while the box is not being edited.
    let editing = $state(false);
    let typed: number | null | undefined = $state();
</script>

<input
    class={"border border-darkborderc focus:border-borderc rounded-md shadow-xs bg-transparent numinput focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200" +
        (className ? " " + className : "")}
    class:text-sm={size === "sm"}
    class:text-md={size === "md"}
    class:text-lg={size === "lg"}
    class:text-textcolor={!disabled}
    class:text-textcolor2={disabled}
    class:px-4={size === "md" && padding}
    class:py-2={size === "md" && padding}
    class:px-2={size === "sm" && padding}
    class:py-1={size === "sm" && padding}
    class:px-6={size === "lg" && padding}
    class:py-3={size === "lg" && padding}
    class:mb-4={marginBottom}
    class:w-full={fullwidth}
    class:h-full={fullh}
    type="number"
    {min}
    {max}
    {id}
    {disabled}
    bind:value={
        () => (editing ? typed : value),
        (next) => {
            typed = next;
            value = next;
        }
    }
    onfocus={() => {
        typed = value;
        editing = true;
    }}
    onblur={() => (editing = false)}
    onchange={(event) => {
        onChange(event);
        typed = value;
    }}
    {placeholder}
/>

<style>
    .numinput::-webkit-outer-spin-button,
    .numinput::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }

    /* Firefox */
    .numinput {
        -moz-appearance: textfield;
        appearance: textfield;
    }
</style>
