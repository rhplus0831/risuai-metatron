/**
 * Keeps the tab audible to Chrome with a quiet, looping tone. Chrome counts a tab as playing audio by its measured
 * output (silence below -72.25 dBFS), not by the element's `volume`, so the level (about -57 dBFS) is baked into the
 * samples and played at full volume. Chrome treats media of 5 s or less as transient (on Android: no media
 * notification, no foreground service), so the clip is longer than that.
 */

function createAudio() {
    const sampleRate = 8000;
    const seconds = 10;
    const frequency = 20;
    const amplitude = 0.002;
    const samples = sampleRate * seconds;
    const bytesPerSample = 2;
    const dataSize = samples * bytesPerSample;
    const view = new DataView(new ArrayBuffer(44 + dataSize));
    const writeString = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < samples; i++) {
        const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
        view.setInt16(44 + i * bytesPerSample, Math.round(value * 32767), true);
    }

    const audio = new Audio(URL.createObjectURL(new Blob([view.buffer], { type: "audio/wav" })));
    audio.loop = true;
    audio.volume = 1;
    return audio;
}

/**
 * The controller of "Keep Session Alive: Via Sound" (`src/App.svelte` holds one). The element is created at the first
 * `start()`. `start()` is a no-op while active; the element's `pause` event (for example the OS or another app took
 * audio focus) or a rejected `play()` makes it inactive, so the next `start()` plays the same element again. Each play
 * counts as an attempt, so a rejection of an earlier play cannot deactivate a later restart. Where the Media Session
 * API exists, `start()` sets `navigator.mediaSession.metadata` (title "Risuai") and `stop()` clears it.
 */
export function createKeepAliveAudio() {
    let audio: HTMLAudioElement | null = null;
    let active = false;
    let playAttempt = 0;

    return {
        get active() {
            return active;
        },
        start() {
            if (active) {
                return;
            }
            if (!audio) {
                audio = createAudio();
                audio.addEventListener("pause", () => {
                    active = false;
                    playAttempt++;
                });
            }

            active = true;
            const attempt = ++playAttempt;
            void audio.play().catch(() => {
                // An earlier play rejection must not deactivate a later restart.
                if (attempt === playAttempt) {
                    active = false;
                }
            });
            if (navigator.mediaSession && typeof MediaMetadata !== "undefined") {
                navigator.mediaSession.metadata = new MediaMetadata({ title: "Risuai" });
            }
        },
        stop() {
            if (!audio) {
                return;
            }
            active = false;
            playAttempt++;
            audio.pause();
            if (navigator.mediaSession) {
                navigator.mediaSession.metadata = null;
            }
        },
    };
}
