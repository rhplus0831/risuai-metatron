/**
 * Keep the tab audible to Chrome with a quiet, looping 20 Hz tone.
 * Chrome measures the output signal against -72.25 dBFS, so the roughly -57 dBFS
 * level is baked into the PCM waveform and played at full volume. The 10-second
 * clip also exceeds the 5-second transient-media limit for persistent media
 * and Android's media notification.
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
