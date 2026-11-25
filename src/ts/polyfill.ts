import { ReadableStream, WritableStream, TransformStream } from "web-streams-polyfill";
import { Buffer as BufferPolyfill } from "buffer";
import { polyfill as dragPolyfill } from "mobile-drag-drop";
import { scrollBehaviourDragImageTranslateOverride } from "mobile-drag-drop/scroll-behaviour";
import rfdc from "rfdc";
import { isIOS } from "./platform";

/**
 * The globals the app assumes, installed by this module's side effects: `safeStructuredClone`, `Buffer` (replaced
 * unconditionally), and the `WritableStream`, `ReadableStream`, and `TransformStream` ponyfills (only where the global
 * is nullish). On iOS, or without native drag and drop, it also sets `globalThis.polyfilledDragDrop` and then applies
 * the `mobile-drag-drop` polyfill; an error in the detection or the installation is ignored, and a partial effect is
 * not rolled back. `src/main.ts` imports this module first, so the app graph loads with the globals in place; this
 * module's own dependencies evaluate before the assignments. `src/vite-env.d.ts` declares `Buffer` and
 * `safeStructuredClone`.
 */

const rfdcClone = rfdc({
    circles: false,
});
/**
 * A deep clone that also takes what `structuredClone` refuses (for example a function, or a proxy such as a `$state`
 * value); that fallback (`rfdc`) does not support circular references.
 */
export function safeStructuredClone<T>(data: T): T {
    try {
        return structuredClone(data);
    } catch (error) {
        return rfdcClone(data);
    }
}

try {
    const testDom = document.createElement("div");
    const supports = "draggable" in testDom || ("ondragstart" in testDom && "ondrop" in testDom);
    testDom.remove();

    if (!supports || isIOS()) {
        globalThis.polyfilledDragDrop = true;
        dragPolyfill({
            // use this to make use of the scroll behaviour
            dragImageTranslateOverride: scrollBehaviourDragImageTranslateOverride,
            holdToDrag: 400,
            forceApply: true,
        });
    }
} catch (error) {}

globalThis.safeStructuredClone = safeStructuredClone;

globalThis.Buffer = BufferPolyfill;
globalThis.WritableStream = globalThis.WritableStream ?? WritableStream;
//@ts-expect-error ponyfill ReadableStream type is incompatible with globalThis.ReadableStream
globalThis.ReadableStream = globalThis.ReadableStream ?? ReadableStream;
//@ts-expect-error ponyfill TransformStream type is incompatible with globalThis.TransformStream
globalThis.TransformStream = globalThis.TransformStream ?? TransformStream;
