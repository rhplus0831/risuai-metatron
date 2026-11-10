import type TextAreaInput from "../GUI/TextAreaInput.svelte";
import type { ComponentProps } from "svelte";

type Props = ComponentProps<typeof TextAreaInput>;
type ChangeEvent = Parameters<NonNullable<Props["onchange"]>>[0];

/** Observe the callbacks supplied by a row while still mounting the real input and invoking its consumers. */
export function observeTextAreaCallbacks(
    component: typeof TextAreaInput,
    callbacks: { input: () => void; change: (event: ChangeEvent) => void },
): typeof TextAreaInput {
    return (anchor, props) =>
        component(
            anchor,
            new Proxy(props, {
                get(target, key, receiver) {
                    if (key === "onInput")
                        return (...args: unknown[]) => {
                            callbacks.input();
                            return target.onInput?.(...args);
                        };
                    if (key === "onchange")
                        return (event: ChangeEvent) => {
                            callbacks.change(event);
                            return target.onchange?.(event);
                        };
                    return Reflect.get(target, key, receiver);
                },
            }),
        );
}
