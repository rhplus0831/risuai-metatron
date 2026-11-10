import { vi } from "vitest";

/** Controls weak-reference death separately from finalizer delivery, without running a real GC. */
export function controlCollection() {
    const weakRefs = new Map<object, { value: object | undefined }[]>();
    const finalizers = new Map<object, (() => void)[]>();
    vi.stubGlobal(
        "WeakRef",
        class<T extends object> {
            private state: { value: object | undefined };
            constructor(target: T) {
                this.state = { value: target };
                weakRefs.set(target, [...(weakRefs.get(target) ?? []), this.state]);
            }
            deref(): T | undefined {
                return this.state.value as T | undefined;
            }
        },
    );
    vi.stubGlobal(
        "FinalizationRegistry",
        class<T> {
            constructor(private cleanup: (heldValue: T) => void) {}
            register(target: object, heldValue: T) {
                finalizers.set(target, [...(finalizers.get(target) ?? []), () => this.cleanup(heldValue)]);
            }
        },
    );
    return {
        collect(target: object) {
            const callbacks = finalizers.get(target);
            if (!callbacks) throw new Error("Target was not registered for finalization");
            for (const state of weakRefs.get(target) ?? []) state.value = undefined;
            weakRefs.delete(target);
            finalizers.delete(target);
            return () => callbacks.forEach((finalize) => finalize());
        },
    };
}
