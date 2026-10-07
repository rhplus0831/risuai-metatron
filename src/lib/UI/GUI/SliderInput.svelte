<script lang="ts">
    import { language } from "src/lang";
    import CheckInput from "./CheckInput.svelte";

    // A touch or pen moving this far decides whether it drags the slider or scrolls the page.
    const TOUCH_SLOP_PX = 8;

    let slider: HTMLDivElement = $state();
    // The value follows the pointer.
    let dragging = false;
    // Where a touch or pen landed, until its direction is known.
    let pendingTouch: { x: number; y: number } | null = null;
    // A touch or pen that may still end as a tap; the click it produces sets the value.
    let tapPending = false;
    interface Props {
        min?: number;
        max?: number;
        value: number;
        marginBottom?: boolean;
        step?: number;
        fixed?: number;
        multiple?: number;
        disableable?: boolean;
        customText?: string | undefined;
        onchange?: Function;
    }

    let {
        min = undefined,
        max = undefined,
        value = $bindable(),
        marginBottom = false,
        step = 1,
        fixed = 0,
        multiple = 1,
        disableable = false,
        customText = undefined,
        onchange,
    }: Props = $props();

    let isDisabledValue = $derived(value === -1000 || value === undefined);
    let sliderValue = $derived(isDisabledValue ? min : value);
    let sliderPercent = $derived(((sliderValue - min) / (max - min)) * 100);
    let displayText = $derived(
        customText === undefined
            ? isDisabledValue
                ? language.disabled
                : (value * multiple).toFixed(fixed)
            : customText,
    );

    function changeValue(event: MouseEvent) {
        const rect = slider.getBoundingClientRect();
        const x = event.clientX - rect.left;
        let newValue = (x / rect.width) * (max - min) + min;
        newValue = Math.round(newValue / step) * step;
        value = Math.min(Math.max(newValue, min), max);
    }

    function startDrag(event: PointerEvent) {
        dragging = true;
        slider.setPointerCapture(event.pointerId);
        changeValue(event);
    }

    function handlePointerDown(event: PointerEvent) {
        if (event.pointerType === "mouse") {
            tapPending = false;
            if (event.button === 0) {
                startDrag(event);
            }
            return;
        }
        // A touch may be the start of a page scroll, so it changes nothing yet.
        pendingTouch = { x: event.clientX, y: event.clientY };
        tapPending = true;
    }

    function handlePointerMove(event: PointerEvent) {
        if (dragging) {
            changeValue(event);
            return;
        }
        if (!pendingTouch) {
            return;
        }
        const dx = Math.abs(event.clientX - pendingTouch.x);
        const dy = Math.abs(event.clientY - pendingTouch.y);
        if (Math.max(dx, dy) < TOUCH_SLOP_PX) {
            return;
        }
        pendingTouch = null;
        tapPending = false;
        // Mostly vertical: a scroll, which touch-action leaves to the browser.
        if (dy > dx) {
            return;
        }
        startDrag(event);
    }

    function endPointer() {
        dragging = false;
        pendingTouch = null;
    }

    function handlePointerCancel() {
        endPointer();
        tapPending = false;
    }

    // The browser sends no click for a tap that stops a scroll fling, so a touch tap sets the value here.
    function handleClick(event: MouseEvent) {
        if (tapPending) {
            tapPending = false;
            changeValue(event);
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        let newValue = isDisabledValue ? min : value;

        switch (event.key) {
            case "ArrowLeft":
            case "ArrowDown":
                newValue -= step;
                break;
            case "ArrowRight":
            case "ArrowUp":
                newValue += step;
                break;
            case "Home":
                newValue = min;
                break;
            case "End":
                newValue = max;
                break;
            default:
                return;
        }

        event.preventDefault();
        value = Math.min(Math.max(newValue, min), max);
    }
</script>

<!-- <input
    class="text-textcolor bg-transparent input-text"
    class:mb-4={marginBottom}
    type="range"
    min={min}
    max={max}
    step={step}
    bind:value
    onchange
> -->

<div class="w-full flex" class:mb-4={marginBottom}>
    {#if disableable}
        <div
            class="relative h-8 border-darkborderc border rounded-full cursor-pointer rounded-r-none border-r-0 flex justify-center items-center pl-2"
        >
            <CheckInput
                check={value !== -1000 && value !== undefined}
                margin={false}
                onChange={(c) => {
                    onchange?.();
                    if (c) {
                        value = min;
                    } else {
                        value = -1000;
                    }
                }}
            ></CheckInput>
        </div>
    {/if}
    <div
        role="slider"
        tabindex="0"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={sliderValue}
        aria-valuetext={displayText}
        class="relative w-full h-8 border-darkborderc border rounded-full cursor-pointer"
        class:rounded-l-none={disableable}
        style:background={`linear-gradient(to right, var(--risu-theme-darkbutton) 0%, var(--risu-theme-darkbutton) ${sliderPercent}%, var(--risu-theme-darkbg) ${sliderPercent}%, var(--risu-theme-darkbg) 100%)`}
        style:touch-action="pan-y pinch-zoom"
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={endPointer}
        onpointercancel={handlePointerCancel}
        onlostpointercapture={endPointer}
        onclick={handleClick}
        onkeydown={handleKeydown}
        bind:this={slider}
    >
        <!-- <div 
      class="absolute top-0 left-0 h-8 rounded-full bg-borderc transition-width duration-200"
      style="width: {(value - min) / (max - min) * 100}%;"
    >
    </div> -->
        <span class="absolute top-0 left-4 h-8 rounded-full items-center justify-center flex text-textcolor text-sm">
            {displayText}
        </span>
    </div>
</div>
