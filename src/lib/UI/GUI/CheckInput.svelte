<script lang="ts">
    interface Props {
        check?: boolean;
        disabled?: boolean;
        indeterminate?: boolean;
        onChange?: (check: boolean) => any;
        margin?: boolean;
        name?: string;
        hiddenName?: boolean;
        reverse?: boolean;
        className?: string;
        grayText?: boolean;
        children?: import("svelte").Snippet;
    }

    let {
        check = $bindable(),
        disabled = false,
        indeterminate = false,
        onChange = (check: boolean) => {},
        margin = true,
        name = "",
        hiddenName = false,
        reverse = false,
        className = "",
        grayText = false,
        children,
    }: Props = $props();
</script>

<label
    class={"flex items-center gap-2" +
        (disabled ? " cursor-default opacity-60" : " cursor-pointer") +
        (className ? " " + className : "") +
        (grayText || disabled ? " text-textcolor2" : " text-textcolor")}
    class:mr-2={margin}
    aria-describedby="{name} {check ? 'abled' : 'disabled'}"
    aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
>
    {#if reverse}
        <span>{name} {@render children?.()}</span>
    {/if}
    <input
        class="hidden"
        type="checkbox"
        {disabled}
        {indeterminate}
        aria-checked={indeterminate ? "mixed" : check}
        alt={name}
        bind:checked={
            () => check,
            (next) => {
                if (!disabled) check = next;
            }
        }
        onchange={(event) => {
            if (!disabled) onChange(check);
            // A controlled checkbox may decline a change or wait for confirmation.
            event.currentTarget.checked = !!check;
            event.currentTarget.indeterminate = indeterminate;
        }}
        aria-describedby="{name} {check ? 'abled' : 'disabled'}"
        aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
    />
    <span
        class="w-5 h-5 min-w-5 min-h-5 rounded-md border-2 border-darkborderc flex justify-center items-center {check
            ? 'bg-darkborderc'
            : 'bg-darkbutton'} transition-colors duration-200"
        aria-hidden="true"
        aria-describedby="{name} {check ? 'abled' : 'disabled'}"
        aria-labelledby="{name} {check ? 'abled' : 'disabled'}"
    >
        {#if indeterminate}
            <span class="w-3 h-0.5 bg-textcolor"></span>
        {:else if check}
            <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="white"
                class="w-3 h-3"
                aria-hidden="true"
            >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
        {/if}
    </span>
    {#if !hiddenName && !reverse}
        <span>{name} {@render children?.()}</span>
    {/if}
</label>
