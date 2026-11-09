/**
 * Plugin TTS hook registry. `src/ts/plugins/apiV3/v3.svelte.ts` registers preprocessors
 * and postprocessors and unregisters them on plugin unload. `src/ts/process/tts.ts`
 * consumes registry snapshots before synthesis and during buffered audio playback.
 * Registration order is execution order; list readers receive copies so registration
 * or removal during an awaited hook cannot change the current iteration.
 */

/** Text before synthesis, with the literal provider mode and character id for plugin preprocessing. */
export interface BeforeTTSContext {
    text: string;
    ttsMode: string;
    characterId: string;
}

/** Optional replacement text; `skip` ends preprocessing and suppresses this speech run. */
export interface BeforeTTSResult {
    text?: string;
    skip?: boolean;
}

/** Synthesized audio bytes and MIME type, with provider mode and character id, before playback decoding. */
export interface AfterTTSContext {
    audio: ArrayBuffer;
    mimeType: string;
    ttsMode: string;
    characterId: string;
}

/** Optional replacement audio/MIME type; `skip` suppresses playback of this speech run. */
export interface AfterTTSResult {
    audio?: ArrayBuffer;
    mimeType?: string;
    skip?: boolean;
}

/**
 * A synchronous or asynchronous hook. Returning void contributes no replacement fields;
 * `runHookPipeline` does not prevent or roll back direct mutation of its context copy.
 */
export type TTSHookFn<Ctx, Res> = (ctx: Ctx) => Promise<Res | void> | Res | void;

const preprocessors: TTSHookFn<BeforeTTSContext, BeforeTTSResult>[] = [];
const postprocessors: TTSHookFn<AfterTTSContext, AfterTTSResult>[] = [];

export function registerTTSPreprocessor(fn: TTSHookFn<BeforeTTSContext, BeforeTTSResult>): void {
    preprocessors.push(fn);
}

export function unregisterTTSPreprocessor(fn: TTSHookFn<BeforeTTSContext, BeforeTTSResult>): void {
    const idx = preprocessors.indexOf(fn);
    if (idx !== -1) preprocessors.splice(idx, 1);
}

export function registerTTSPostprocessor(fn: TTSHookFn<AfterTTSContext, AfterTTSResult>): void {
    postprocessors.push(fn);
}

export function unregisterTTSPostprocessor(fn: TTSHookFn<AfterTTSContext, AfterTTSResult>): void {
    const idx = postprocessors.indexOf(fn);
    if (idx !== -1) postprocessors.splice(idx, 1);
}

/** Returns a snapshot of preprocessors in registration order for `src/ts/process/tts.ts`. */
export function getTTSPreprocessors(): ReadonlyArray<TTSHookFn<BeforeTTSContext, BeforeTTSResult>> {
    // Defensive copy: callers iterate over this while hooks may be registered
    // or unregistered mid-flight (e.g. a plugin unloading). Handing out the
    // backing array would let such mutations skip or duplicate iterations.
    return preprocessors.slice();
}

/** Returns a snapshot of postprocessors in registration order for `src/ts/process/tts.ts`. */
export function getTTSPostprocessors(): ReadonlyArray<TTSHookFn<AfterTTSContext, AfterTTSResult>> {
    return postprocessors.slice();
}

/**
 * Runs hooks sequentially on a shallow copy, merging defined result fields for the
 * next hook. `skip` ends the pipeline immediately without merging that result.
 * Thrown/rejected errors are logged and ignored. A positive `timeoutMs` logs and
 * ignores a timed-out result without cancelling the hook; absent or non-positive
 * timeouts wait indefinitely. `src/ts/process/tts.ts` supplies the shared callback timeout and
 * uses its own disposable-buffer pipeline with the same timeout for audio postprocessors.
 */
export async function runHookPipeline<Ctx extends object, Res extends { skip?: boolean }>(
    hooks: ReadonlyArray<TTSHookFn<Ctx, Res>>,
    ctx: Ctx,
    timeoutMs?: number,
): Promise<{ ctx: Ctx; skip: boolean }> {
    const TIMEOUT = Symbol("TIMEOUT");
    let current: Ctx = { ...ctx };

    for (const hook of hooks) {
        let result: Res | void | typeof TIMEOUT;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const hookPromise = Promise.resolve().then(() => hook(current));
            if (timeoutMs !== undefined && timeoutMs > 0) {
                result = await Promise.race<Res | void | typeof TIMEOUT>([
                    hookPromise,
                    new Promise<typeof TIMEOUT>((resolve) => {
                        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
                    }),
                ]);
            } else {
                result = await hookPromise;
            }
        } catch (err) {
            console.error("[TTS hook] threw, continuing with next hook:", err);
            continue;
        } finally {
            clearTimeout(timer);
        }

        if (result === TIMEOUT) {
            console.error("[TTS hook] timed out, continuing with next hook");
            continue;
        }

        if (!result) continue;

        if (result.skip) {
            return { ctx: current, skip: true };
        }

        for (const key of Object.keys(result) as (keyof Res)[]) {
            if (key === "skip") continue;
            const v = (result as any)[key];
            if (v !== undefined) (current as any)[key] = v;
        }
    }

    return { ctx: current, skip: false };
}
