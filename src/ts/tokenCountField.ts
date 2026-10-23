import { untrack } from "svelte";

export const TOKEN_COUNT_DELAY_MS = 400;

/** Runs first immediately or via scheduleFirst, then after delayMs of quiet; aborts and ignores superseded runs, and keeps the last result on failure unless onError handles it. */
export function createTokenCountField<I, R = number>(options: {
    count: (input: I, signal: AbortSignal) => Promise<R>;
    apply: (result: R) => void;
    onError?: (error: unknown) => void;
    same?: (a: I, b: I) => boolean;
    delayMs?: number;
    scheduleFirst?: (run: () => void) => () => void;
}) {
    const same = options.same ?? Object.is;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelFirst: (() => void) | undefined;
    let controller: AbortController | undefined;
    let current: { input: I } | undefined;
    let applied: { input: I } | undefined;
    let generation = 0;
    let first = true;
    let disposed = false;

    function cancel() {
        ++generation;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        cancelFirst?.();
        cancelFirst = undefined;
        controller?.abort();
        controller = undefined;
        current = undefined;
    }

    function update(input: I) {
        if (disposed) return;
        const previous = current ?? applied;
        if (previous && same(previous.input, input)) return;

        cancel();
        const run = generation;
        current = { input };

        async function execute() {
            if (disposed || run !== generation) return;
            timer = undefined;
            cancelFirst = undefined;
            const active = new AbortController();
            controller = active;
            try {
                const result = await untrack(() => options.count(input, active.signal));
                if (disposed || run !== generation || active.signal.aborted) return;
                current = undefined;
                controller = undefined;
                applied = { input };
                options.apply(result);
            } catch (error) {
                if (disposed || run !== generation || active.signal.aborted) return;
                current = undefined;
                controller = undefined;
                options.onError?.(error);
            }
        }

        if (first) {
            first = false;
            if (options.scheduleFirst) {
                cancelFirst = options.scheduleFirst(() => void execute());
            } else {
                void execute();
            }
        } else {
            timer = setTimeout(() => void execute(), options.delayMs ?? TOKEN_COUNT_DELAY_MS);
        }
    }

    function reset() {
        cancel();
        applied = undefined;
        first = true;
    }

    function dispose() {
        disposed = true;
        reset();
    }

    return { update, reset, dispose };
}
