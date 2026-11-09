import { LLM_CALLBACK_TIMEOUT_MS } from "../../../shared/llm/request.ts";
import { type ClientCharacter, selectedCharacter } from "../storage/characterStore.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { auxFetch } from "../network/auxFetch";
import { isSecretSet } from "../storage/llmSecrets.svelte";
import { alertError } from "../alert";
import { type character } from "../storage/database.svelte";
import { runTranslator, translateVox } from "../translator/translator";
import { globalFetch, loadAsset } from "../globalApi.svelte";
import { language } from "src/lang";
import { runVITS } from "./transformers";
import {
    getTTSPreprocessors,
    getTTSPostprocessors,
    runHookPipeline,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
} from "./ttsHooks";

/**
 * Character TTS, dispatched by the literal `character.ttsMode` values. Each `sayTTS` run
 * registers its own AbortController in `activeSpeechControllers`; HTTP provider requests
 * receive its signal as `signal` for fetch/auxFetch and `abortSignal` for globalFetch.
 * `src/ts/globalApi.svelte.ts` returns `ok: false` on abort rather than throwing, so the
 * provider branches check cancellation after requests and body reads before alerts or
 * further work. Translation and the unabortable `loadAsset` and `runVITS` awaits also
 * have cancellation checks; an aborted run ends without a TTS alert.
 *
 * Each run captures the Stop generation at entry and carries it in `TTSPlaybackContext`,
 * so work finishing after `stopTTS` cannot start playback. Preprocessors run before the
 * provider request; audio postprocessors run in playback before decoding. Web Speech
 * and VITS bypass audio postprocessors, but still receive preprocessed text.
 */

type SpeechPlayback = { source: AudioBufferSourceNode; context: AudioContext };
type TTSPlaybackContext = { ttsMode: string; characterId: string; generation: number };
const activeSpeech = new Set<SpeechPlayback>();
/** Contexts still decoding: Stop closes them too, so none stays open after it. */
const pendingContexts = new Set<AudioContext>();
const activeSpeechControllers = new Set<AbortController>();
let stopGeneration = 0;

/** Waits before retrying, releasing the timer and listener on completion or cancellation. */
function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function closePending(context: AudioContext) {
    if (!pendingContexts.delete(context)) return;
    void context.close().catch(() => {});
}

function retireSpeech(playback: SpeechPlayback) {
    if (!activeSpeech.delete(playback)) return;
    playback.source.onended = null;
    void playback.context.close().catch(() => {});
}

/**
 * Both buffered playback paths share cancellation and context cleanup. `playAudio`,
 * the GPT-SoVITS gain path, and VITS all arrive here with their final bytes. VITS's
 * `runVITS` in `src/ts/process/transformers.ts` only synthesizes WAV bytes; no audio
 * hooks run on those bytes.
 *
 * The captured generation is checked before decoding and before starting a source.
 * Each playing source/context enters `activeSpeech` and is retired on `ended`.
 * A cancelled or failed decode closes its unused context; rejection after Stop closed
 * the decoding context is suppressed so cancellation produces no alert.
 */
async function playProcessedAudio(audio: ArrayBuffer, ctx: TTSPlaybackContext, volume = 1) {
    if (ctx.generation !== stopGeneration) return;
    const context = new AudioContext();
    pendingContexts.add(context);
    try {
        const decoded = await context.decodeAudioData(audio);
        const source = context.createBufferSource();
        source.buffer = decoded;
        if (volume !== 1) {
            const gain = context.createGain();
            gain.gain.value = volume;
            source.connect(gain);
            gain.connect(context.destination);
        } else {
            source.connect(context.destination);
        }
        // Stop may have run during a fetch, hook, or decode belonging to this speech.
        if (ctx.generation !== stopGeneration) {
            closePending(context);
            return;
        }
        const playback = { source, context };
        source.onended = () => retireSpeech(playback);
        source.start();
        pendingContexts.delete(context);
        activeSpeech.add(playback);
    } catch (error) {
        closePending(context);
        // Stop closes a decoding context, which may reject the decode.
        if (ctx.generation !== stopGeneration) return;
        throw error;
    }
}

/**
 * Run every registered TTS postprocessor hook against the audio bytes, honoring
 * replacement audio / mimeType / skip semantics. Before each hook invocation a
 * fresh slice of the current base audio is handed to the hook as its disposable
 * copy — the plugin sandbox postMessage layer transfers that buffer into the
 * iframe and neuters it on the host side, so reusing a single slice across
 * multiple hooks would leave all hooks after the first with a detached buffer.
 *
 * Returns the final audio bytes (possibly replaced by a hook), the final
 * mimeType, and whether a hook requested a skip. Hooks run sequentially; a thrown
 * error or a timeout at the shared callback allowance is logged and the next hook runs.
 * Timed-out hooks may finish, but their results are ignored.
 */
async function runPostprocessorPipeline(
    audio: ArrayBuffer,
    mimeType: string,
    ctx: { ttsMode: string; characterId: string },
): Promise<{ audio: ArrayBuffer; mimeType: string; skip: boolean }> {
    const hooks = getTTSPostprocessors();
    if (hooks.length === 0) return { audio, mimeType, skip: false };

    let currentAudio = audio;
    let currentMime = mimeType;

    for (const hook of hooks) {
        const disposable = currentAudio.slice(0); // fresh clone per hook
        let result: AfterTTSResult | void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            result = await Promise.race([
                Promise.resolve().then(() =>
                    hook({
                        audio: disposable,
                        mimeType: currentMime,
                        ttsMode: ctx.ttsMode,
                        characterId: ctx.characterId,
                    }),
                ),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("TTS hook timed out")), LLM_CALLBACK_TIMEOUT_MS);
                }),
            ]);
        } catch (err) {
            console.error("[TTS postprocessor] threw, continuing with next hook:", err);
            continue;
        } finally {
            clearTimeout(timer);
        }

        if (!result) continue;
        if (result.skip) return { audio: currentAudio, mimeType: currentMime, skip: true };
        if (result.audio && result.audio.byteLength > 0) currentAudio = result.audio;
        if (typeof result.mimeType === "string" && result.mimeType) currentMime = result.mimeType;
    }

    return { audio: currentAudio, mimeType: currentMime, skip: false };
}

async function playAudio(audio: ArrayBuffer, mimeType: string, ctx: TTSPlaybackContext): Promise<void> {
    const processed = await runPostprocessorPipeline(audio, mimeType, ctx);
    if (processed.skip) return;

    await playProcessedAudio(processed.audio, ctx);
}

/**
 * Speaks through webspeech, elevenlab, VOICEVOX, openai, novelai, huggingface, vits,
 * gptsovits, or fishspeech, selected by `character.ttsMode`; null uses the selected
 * non-group character. Hooks use the shared callback timeout and ignore late results.
 *
 * VOICEVOX and Hugging Face pass the run's signal to their translators in
 * `src/ts/translator/translator.ts`, suppressing translator alerts after cancellation.
 * When `character.hfTTS.language !== "en"`, Hugging Face calls `runTranslator` once
 * before the retry loop and reuses its result. A JSON 503 `estimated_time` waits with
 * `retryDelay` on the same signal before retrying.
 * GPT-SoVITS with non-default gain runs `runPostprocessorPipeline` explicitly before
 * `playProcessedAudio`, preserving audio hooks while adding its GainNode.
 */
export async function sayTTS(character: ClientCharacter, text: string) {
    const generation = stopGeneration;
    const controller = new AbortController();
    const signal = controller.signal;
    activeSpeechControllers.add(controller);
    try {
        if (!character) {
            const v = selectedCharacter();
            if (v.type === "group") {
                return;
            }
            character = v;
        }

        if (!text) {
            return;
        }

        text = text.replace(/\*/g, "");

        if (character.ttsReadOnlyQuoted) {
            const matches = text.match(/["「](.*?)["」]/g);
            if (matches && matches.length > 0) {
                text = matches.map((match) => match.slice(1, -1)).join("");
            } else {
                text = "";
            }
        }

        const beforeResult = await runHookPipeline<BeforeTTSContext, BeforeTTSResult>(
            getTTSPreprocessors(),
            {
                text,
                ttsMode: character.ttsMode ?? "",
                characterId: character.chaId,
            },
            LLM_CALLBACK_TIMEOUT_MS,
        );
        if (beforeResult.skip || generation !== stopGeneration) {
            return;
        }
        text = beforeResult.ctx.text;
        const hookCtx = { ttsMode: character.ttsMode ?? "", characterId: character.chaId, generation };

        switch (character.ttsMode) {
            case "webspeech": {
                if (speechSynthesis && SpeechSynthesisUtterance) {
                    const utterThis = new SpeechSynthesisUtterance(text);
                    const voices = speechSynthesis.getVoices();
                    let voiceIndex = 0;
                    for (let i = 0; i < voices.length; i++) {
                        if (voices[i].name === character.ttsSpeech) {
                            voiceIndex = i;
                        }
                    }
                    utterThis.voice = voices[voiceIndex];
                    const speak = speechSynthesis.speak(utterThis);
                }
                break;
            }
            case "elevenlab": {
                const da = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${character.ttsSpeech}`, {
                    signal,
                    body: JSON.stringify({
                        text: text,
                        model_id: "eleven_multilingual_v2",
                    }),
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "xi-api-key": settings.secrets.elevenLabKey || undefined,
                    },
                });
                signal.throwIfAborted();
                if (da.status >= 200 && da.status < 300) {
                    const buffer = await da.arrayBuffer();
                    signal.throwIfAborted();
                    const mimeType = da.headers.get("content-type") || "audio/mpeg";
                    await playAudio(buffer, mimeType, hookCtx);
                } else {
                    const errorText = await da.text();
                    signal.throwIfAborted();
                    alertError(errorText);
                }
                break;
            }
            case "VOICEVOX": {
                const jpText = await translateVox(text, signal);
                signal.throwIfAborted();
                const base = settings.memoryTranslateMedia.voicevoxUrl.replace(/\/+$/, "");
                const queryUrl = new URL(base + "/audio_query");
                queryUrl.searchParams.set("text", jpText);
                queryUrl.searchParams.set("speaker", String(character.ttsSpeech));
                const query = await fetch(queryUrl, {
                    signal,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                });
                signal.throwIfAborted();
                if (query.status == 200) {
                    const queryJson = await query.json();
                    signal.throwIfAborted();
                    const bodyData = {
                        accent_phrases: queryJson.accent_phrases,
                        speedScale: character.voicevoxConfig.SPEED_SCALE,
                        pitchScale: character.voicevoxConfig.PITCH_SCALE,
                        volumeScale: character.voicevoxConfig.VOLUME_SCALE,
                        intonationScale: character.voicevoxConfig.INTONATION_SCALE,
                        prePhonemeLength: queryJson.prePhonemeLength,
                        postPhonemeLength: queryJson.postPhonemeLength,
                        outputSamplingRate: queryJson.outputSamplingRate,
                        outputStereo: queryJson.outputStereo,
                        kana: queryJson.kana,
                    };
                    const synthesisUrl = new URL(base + "/synthesis");
                    synthesisUrl.searchParams.set("speaker", String(character.ttsSpeech));
                    const getVoice = await fetch(synthesisUrl, {
                        signal,
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(bodyData),
                    });
                    signal.throwIfAborted();
                    if (getVoice.status == 200 && getVoice.headers.get("content-type") === "audio/wav") {
                        const buffer = await getVoice.arrayBuffer();
                        signal.throwIfAborted();
                        await playAudio(buffer, "audio/wav", hookCtx);
                    }
                }
                break;
            }
            case "openai": {
                const cfg = character.oaiTTSConfig?.enabled ? character.oaiTTSConfig : null;
                const baseURL = (cfg?.baseURL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
                // The per-character key is the character's; the stored OpenAI key is write-only and
                // only reaches api.openai.com, through the server.
                const ownKey = (cfg?.apiKey || "").trim();
                const official = baseURL === "https://api.openai.com/v1";
                const storedKey = isSecretSet({ kind: "flat", field: "openAIKey" });
                const model = cfg?.model || "tts-1";
                const voice = cfg?.voice || character.oaiVoice || "alloy";
                const format = cfg?.format || "mp3";
                const body = {
                    model,
                    input: text,
                    voice,
                    response_format: format,
                };

                let res: { ok: boolean; data: any };
                if (!ownKey && official && storedKey) {
                    const response = await auxFetch("openai-tts", `${baseURL}/audio/speech`, {
                        signal,
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    });
                    res = { ok: response.ok, data: new Uint8Array(await response.arrayBuffer()) };
                } else if (!ownKey && !official && storedKey) {
                    alertError(language.ttsCustomUrlNeedsKey);
                    break;
                } else {
                    res = await globalFetch(`${baseURL}/audio/speech`, {
                        abortSignal: signal,
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            ...(ownKey ? { Authorization: "Bearer " + ownKey } : {}),
                        },
                        body,
                        rawResponse: true,
                    });
                }
                signal.throwIfAborted();
                const dat = res.data;

                if (res.ok) {
                    try {
                        const audio = Buffer.from(dat).buffer;
                        await playAudio(audio, "audio/mpeg", hookCtx);
                    } catch (error) {
                        alertError(language.errors.httpError + `${error}`);
                    }
                } else {
                    if (dat.error && dat.error.message) {
                        alertError(language.errors.httpError + `${dat.error.message}`);
                    } else {
                        alertError(language.errors.httpError + `${Buffer.from(res.data).toString()}`);
                    }
                }
                break;
            }
            case "novelai": {
                if (text === "") {
                    break;
                }
                const encodedText = encodeURIComponent(text);
                const encodedSeed = encodeURIComponent(character.naittsConfig.voice);

                const url = `https://api.novelai.net/ai/generate-voice?text=${encodedText}&voice=-1&seed=${encodedSeed}&opus=false&version=${character.naittsConfig.version}`;

                const response = await globalFetch(url, {
                    abortSignal: signal,
                    method: "GET",
                    headers: {
                        Authorization: "Bearer " + settings.secrets.NAIApiKey,
                    },
                    rawResponse: true,
                });
                signal.throwIfAborted();

                if (response.ok) {
                    await playAudio(response.data.buffer, "audio/wav", hookCtx);
                } else {
                    alertError("Error fetching or decoding audio data");
                }
                break;
            }
            case "huggingface": {
                signal.throwIfAborted();
                if (character.hfTTS.language !== "en") {
                    text = await runTranslator(text, false, "en", character.hfTTS.language, { signal });
                }
                while (true) {
                    signal.throwIfAborted();
                    const response = await fetch(
                        `https://api-inference.huggingface.co/models/${character.hfTTS.model}`,
                        {
                            signal,
                            method: "POST",
                            headers: {
                                Authorization: "Bearer " + settings.secrets.huggingfaceKey,
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                inputs: text,
                            }),
                        },
                    );
                    signal.throwIfAborted();

                    if (response.status === 503 && response.headers.get("content-type") === "application/json") {
                        const json = await response.json();
                        signal.throwIfAborted();
                        if (json.estimated_time) {
                            await retryDelay(json.estimated_time * 1000, signal);
                            continue;
                        }
                    } else if (response.status >= 400) {
                        const errorText = await response.text();
                        signal.throwIfAborted();
                        alertError(language.errors.httpError + `${errorText}`);
                        return;
                    } else if (response.status === 200) {
                        const buffer = await response.arrayBuffer();
                        signal.throwIfAborted();
                        const mimeType = response.headers.get("content-type") || "audio/wav";
                        await playAudio(buffer, mimeType, hookCtx);
                    } else {
                        alertError("Error fetching or decoding audio data");
                    }
                    return;
                }
            }
            case "vits": {
                const audio = await runVITS(text, character.vits);
                signal.throwIfAborted();
                // VITS bypasses the postprocessor hooks but shares the Stop registry.
                if (audio) await playProcessedAudio(audio, hookCtx);
                break;
            }
            case "gptsovits": {
                const audio: Uint8Array = await loadAsset(character.gptSoVitsConfig.ref_audio_data.assetId);
                signal.throwIfAborted();
                const base64Audio = btoa(
                    new Uint8Array(audio).reduce((data, byte) => data + String.fromCharCode(byte), ""),
                );

                const body = {
                    text: text,
                    text_lang: character.gptSoVitsConfig.text_lang,
                    ref_audio_path: undefined,
                    ref_audio_name: character.gptSoVitsConfig.ref_audio_data.fileName,
                    ref_audio_data: base64Audio,
                    prompt_text: undefined,
                    prompt_lang: character.gptSoVitsConfig.prompt_lang,
                    top_p: character.gptSoVitsConfig.top_p,
                    temperature: character.gptSoVitsConfig.temperature,
                    speed_factor: character.gptSoVitsConfig.speed,
                    top_k: character.gptSoVitsConfig.top_k,
                    text_split_method: character.gptSoVitsConfig.text_split_method,
                    parallel_infer: true,
                    // media_type: character.gptSoVitsConfig.ref_audio_data.fileName.split('.')[1],
                    ref_free: character.gptSoVitsConfig.use_long_audio || !character.gptSoVitsConfig.use_prompt,
                };

                if (character.gptSoVitsConfig.use_prompt) {
                    body.prompt_text = character.gptSoVitsConfig.prompt;
                }

                if (character.gptSoVitsConfig.use_auto_path) {
                    console.log("auto");
                    const path = await globalFetch(`${character.gptSoVitsConfig.url}/get_path`, {
                        abortSignal: signal,
                        method: "GET",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        rawResponse: false,
                        plainFetchDeforce: true,
                    });
                    signal.throwIfAborted();
                    console.log(path);
                    if (path.ok) {
                        body.ref_audio_path =
                            path.data.message + "/public/audio/" + character.gptSoVitsConfig.ref_audio_data.fileName;
                    } else {
                        throw new Error("Failed to Auto get path");
                    }
                } else {
                    body.ref_audio_path =
                        character.gptSoVitsConfig.ref_audio_path +
                        "/public/audio/" +
                        character.gptSoVitsConfig.ref_audio_data.fileName;
                }
                console.log(body);

                const response = await globalFetch(`${character.gptSoVitsConfig.url}/tts`, {
                    abortSignal: signal,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: body,
                    rawResponse: true,
                });
                signal.throwIfAborted();
                console.log(response);

                if (response.ok) {
                    const mimeType = "audio/wav";
                    const volume = character.gptSoVitsConfig.volume;
                    if (volume !== undefined && volume !== 1.0) {
                        // Volume != 1.0 requires a GainNode in the graph, so we can't
                        // route through playAudio directly. Run the postprocessor
                        // pipeline first to honor plugin hooks consistently, then
                        // build the gain-enabled graph with the final bytes.
                        const processed = await runPostprocessorPipeline(response.data.buffer, mimeType, hookCtx);
                        if (!processed.skip) {
                            await playProcessedAudio(processed.audio, hookCtx, volume);
                        }
                    } else {
                        await playAudio(response.data.buffer, mimeType, hookCtx);
                    }
                } else {
                    const textBuffer: Uint8Array = response.data.buffer;
                    const text = Buffer.from(textBuffer).toString("utf-8");
                    throw new Error(text);
                }
                break;
            }
            case "fishspeech": {
                if (character.fishSpeechConfig.model._id === "") {
                    throw new Error("FishSpeech Model is not selected");
                }

                const body = {
                    text: text,
                    reference_id: character.fishSpeechConfig.model._id,
                    chunk_length: character.fishSpeechConfig.chunk_length,
                    normalize: character.fishSpeechConfig.normalize,
                    format: "mp3",
                    mp3_bitrate: 192,
                };

                console.log(body);

                const response = await globalFetch(`https://api.fish.audio/v1/tts`, {
                    abortSignal: signal,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${settings.secrets.fishSpeechKey}`,
                    },
                    body: body,
                    rawResponse: true,
                });
                signal.throwIfAborted();
                console.log(response);

                if (response.ok) {
                    await playAudio(response.data.buffer, "audio/mpeg", hookCtx);
                } else {
                    const textBuffer: Uint8Array = response.data.buffer;
                    const text = Buffer.from(textBuffer).toString("utf-8");
                    throw new Error(text);
                }
                break;
            }
        }
    } catch (error) {
        if (signal.aborted) return;
        alertError(`TTS Error: ${error}`);
    } finally {
        activeSpeechControllers.delete(controller);
    }
}

/** OpenAI voice ids for the voice picker in `src/lib/SideBars/CharConfig.svelte`. */
export const oaiVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

/**
 * Advances the playback generation and aborts every registered speech run, including
 * pending provider requests and Hugging Face retry waits; this does not cancel the
 * provider's remote job. Stops and retires every `activeSpeech` source, closes their
 * contexts and all still-decoding `pendingContexts`, then cancels Web Speech.
 */
export function stopTTS() {
    stopGeneration++;
    for (const controller of activeSpeechControllers) controller.abort();
    activeSpeechControllers.clear();
    for (const playback of activeSpeech) {
        try {
            playback.source.stop();
        } catch {
            // A source that already ended still needs its context retired.
        }
        retireSpeech(playback);
    }
    for (const context of pendingContexts) closePending(context);
    if (speechSynthesis && SpeechSynthesisUtterance) {
        speechSynthesis.cancel();
    }
}

/** Returns browser voice names for `src/lib/SideBars/CharConfig.svelte`. */
export function getWebSpeechTTSVoices() {
    return speechSynthesis.getVoices().map((v) => {
        return v.name;
    });
}

/** Returns ElevenLabs voice records for `src/lib/SideBars/CharConfig.svelte`. */
export async function getElevenTTSVoices() {
    const data = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: {
            "xi-api-key": settings.secrets.elevenLabKey || undefined,
        },
    });
    const res = await data.json();

    console.log(res);
    return res.voices;
}

/** Returns VOICEVOX speakers with JSON style lists and a None entry for `src/lib/SideBars/CharConfig.svelte`. */
export async function getVOICEVOXVoices() {
    const base = settings.memoryTranslateMedia.voicevoxUrl.replace(/\/+$/, "");
    const speakerData = await fetch(new URL(base + "/speakers"));
    const speakerList = await speakerData.json();
    const speakersInfo = speakerList.map((speaker) => {
        const styles = speaker.styles.map((style) => {
            return { name: style.name, id: `${style.id}` };
        });
        return { name: speaker.name, list: JSON.stringify(styles) };
    });
    speakersInfo.unshift({ name: "None", list: null });
    return speakersInfo;
}

/** Returns built-in NovelAI voice seeds grouped by gender for `src/lib/SideBars/CharConfig.svelte`. */
export function getNovelAIVoices() {
    return [
        {
            gender: "UNISEX",
            voices: ["Anananan"],
        },
        {
            gender: "FEMALE",
            voices: ["Aini", "Orea", "Claea", "Lim", "Aurae", "Naia"],
        },
        {
            gender: "MALE",
            voices: ["Aulon", "Elei", "Ogma", "Raid", "Pega", "Lam"],
        },
    ];
}

/** Fills an undefined NovelAI TTS config with voice/version defaults and returns the character; has no callers. */
export function FixNAITTS(data: character) {
    if (data.naittsConfig === undefined) {
        // Mirror the defaults used by CharConfig.svelte's $effect.pre
        // initializer so that the NovelAI request URL — which templates
        // in `version` and branches on `customvoice` — gets valid values
        // instead of the literal string "undefined".
        data.naittsConfig = {
            customvoice: false,
            voice: "Anananan",
            version: "v2",
        };
    }

    return data;
}
