import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeepAliveAudio } from "./keepAliveAudio";

const created: AudioStub[] = [];
const blobs: Blob[] = [];
let playResult: Promise<void>;

class AudioStub extends EventTarget {
    src: string;
    loop = false;
    volume = 1;
    paused = true;

    constructor(src: string) {
        super();
        this.src = src;
        created.push(this);
    }

    play = vi.fn(() => {
        this.paused = false;
        return playResult;
    });

    pause = vi.fn(() => {
        this.paused = true;
    });
}

class MediaMetadataStub {
    title: string;

    constructor(init: MediaMetadataInit) {
        this.title = init.title ?? "";
    }
}

const mediaSession: { metadata: MediaMetadataStub | null } = { metadata: null };

beforeEach(() => {
    created.length = 0;
    blobs.length = 0;
    playResult = Promise.resolve();
    mediaSession.metadata = null;
    vi.stubGlobal("Audio", AudioStub);
    vi.stubGlobal("MediaMetadata", MediaMetadataStub);
    vi.stubGlobal("navigator", { mediaSession });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        expect(blob).toBeInstanceOf(Blob);
        blobs.push(blob as Blob);
        return "blob:keep-alive-tone";
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("createKeepAliveAudio", () => {
    it("starts one looping element at full volume with Risuai metadata", async () => {
        const controller = createKeepAliveAudio();
        expect(controller.active).toBe(false);

        controller.start();
        controller.start();
        await Promise.resolve();
        controller.start();

        expect(controller.active).toBe(true);
        expect(created).toHaveLength(1);
        expect(blobs).toHaveLength(1);
        expect(created[0].src).toBe("blob:keep-alive-tone");
        expect(created[0].play).toHaveBeenCalledTimes(1);
        expect(created[0].paused).toBe(false);
        expect(created[0].loop).toBe(true);
        expect(created[0].volume).toBe(1);
        expect(mediaSession.metadata).toBeInstanceOf(MediaMetadataStub);
        expect(mediaSession.metadata?.title).toBe("Risuai");
    });

    it("generates a ten-second mono PCM WAV containing a quiet 20 Hz tone", async () => {
        createKeepAliveAudio().start();
        expect(blobs).toHaveLength(1);
        expect(created[0].src).toBe("blob:keep-alive-tone");

        const buffer = await blobs[0].arrayBuffer();
        const view = new DataView(buffer);
        const tag = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
        expect(tag(0)).toBe("RIFF");
        expect(tag(8)).toBe("WAVE");
        expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);

        // Read RIFF chunks so optional WAV chunks or a different ordering remain valid.
        let format: {
            encoding: number;
            channels: number;
            sampleRate: number;
            byteRate: number;
            blockAlign: number;
            bitsPerSample: number;
        };
        let dataOffset: number;
        let dataSize: number;
        for (let offset = 12; offset + 8 <= buffer.byteLength;) {
            const size = view.getUint32(offset + 4, true);
            const body = offset + 8;
            expect(body + size).toBeLessThanOrEqual(buffer.byteLength);
            if (tag(offset) === "fmt ") {
                format = {
                    encoding: view.getUint16(body, true),
                    channels: view.getUint16(body + 2, true),
                    sampleRate: view.getUint32(body + 4, true),
                    byteRate: view.getUint32(body + 8, true),
                    blockAlign: view.getUint16(body + 12, true),
                    bitsPerSample: view.getUint16(body + 14, true),
                };
            }
            if (tag(offset) === "data") {
                dataOffset = body;
                dataSize = size;
            }
            offset = body + size + (size % 2);
        }

        expect(format).toEqual({
            encoding: 1,
            channels: 1,
            sampleRate: 8000,
            byteRate: 16000,
            blockAlign: 2,
            bitsPerSample: 16,
        });
        expect(dataOffset).toBeDefined();
        expect(dataSize).toBe(10 * 8000 * 2);

        const sampleCount = dataSize / format.blockAlign;
        const duration = sampleCount / format.sampleRate;
        expect(duration).toBe(10);
        expect(duration).toBeGreaterThan(5);

        const fullScale = 2 ** 15;
        let peak = 0;
        let sumSquares = 0;
        let previous = 0;
        const risingCrossings: number[] = [];
        for (let i = 0; i < sampleCount; i++) {
            const sample = view.getInt16(dataOffset + i * 2, true) / fullScale;
            peak = Math.max(peak, Math.abs(sample));
            sumSquares += sample ** 2;
            if (previous <= 0 && sample > 0) {
                risingCrossings.push(i);
            }
            previous = sample;
        }

        // Allow one 16-bit quantization step around the Goal's amplitude.
        const rms = Math.sqrt(sumSquares / sampleCount);
        expect(Math.abs(peak - 0.002)).toBeLessThanOrEqual(1 / fullScale);
        expect(Math.abs(rms - 0.002 / Math.SQRT2)).toBeLessThanOrEqual(1 / fullScale);
        expect(20 * Math.log10(peak)).toBeCloseTo(-54, 0);
        expect(20 * Math.log10(rms)).toBeCloseTo(-57, 0);
        expect(20 * Math.log10(rms)).toBeGreaterThan(-72.25);
        expect(peak).toBeLessThan(0.01);

        expect(Math.abs(risingCrossings.length - 20 * duration)).toBeLessThanOrEqual(1);
        const frequency =
            ((risingCrossings.length - 1) * format.sampleRate) / (risingCrossings.at(-1) - risingCrossings[0]);
        expect(frequency).toBeCloseTo(20, 1);
    });

    it("resumes the same element after an outside pause", async () => {
        const controller = createKeepAliveAudio();
        controller.start();
        await Promise.resolve();
        const audio = created[0];

        audio.pause();
        audio.dispatchEvent(new Event("pause"));
        expect(controller.active).toBe(false);
        controller.start();
        await Promise.resolve();

        expect(controller.active).toBe(true);
        expect(created).toEqual([audio]);
        expect(blobs).toHaveLength(1);
        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(audio.paused).toBe(false);
        expect(audio.loop).toBe(true);
        expect(audio.volume).toBe(1);
    });

    it("handles a rejected play and retries the same element on the next start", async () => {
        let rejectPlay: (reason: unknown) => void;
        playResult = new Promise<void>((_resolve, reject) => {
            rejectPlay = reject;
        });
        const controller = createKeepAliveAudio();
        controller.start();
        const audio = created[0];

        // Only production handles this rejection; an unhandled one also fails Vitest.
        rejectPlay(new DOMException("User activation required", "NotAllowedError"));
        await Promise.resolve();
        expect(controller.active).toBe(false);

        playResult = Promise.resolve();
        controller.start();
        await Promise.resolve();

        expect(controller.active).toBe(true);
        expect(created).toEqual([audio]);
        expect(blobs).toHaveLength(1);
        expect(audio.play).toHaveBeenCalledTimes(2);
        expect(audio.paused).toBe(false);
    });

    it("stops playback and clears metadata only after starting", async () => {
        const controller = createKeepAliveAudio();
        const previousMetadata = new MediaMetadataStub({ title: "Other audio" });
        mediaSession.metadata = previousMetadata;
        controller.stop();
        expect(controller.active).toBe(false);
        expect(created).toHaveLength(0);
        expect(blobs).toHaveLength(0);
        expect(mediaSession.metadata).toBe(previousMetadata);

        controller.start();
        await Promise.resolve();
        const audio = created[0];
        expect(controller.active).toBe(true);
        expect(mediaSession.metadata?.title).toBe("Risuai");

        controller.stop();

        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(audio.paused).toBe(true);
        expect(controller.active).toBe(false);
        expect(mediaSession.metadata).toBeNull();
    });
});
