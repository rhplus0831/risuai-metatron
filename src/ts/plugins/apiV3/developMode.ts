import { alertError } from "src/ts/alert";
import { importPlugin } from "../plugins.svelte";
import { sleep } from "src/ts/util";

/**
 * Guest-only diagnostics for database reads. Results remain cloneable plain objects with
 * accessors; synchronous API serialization is excluded from reads. Logs contain key names
 * and counts only, once after two quiet seconds and again only for newly observed accesses.
 */
export function databaseAccessRecorderScript(pluginName: string): string {
    return `(() => {
    const pluginName = ${JSON.stringify(pluginName)};
    let serializing = 0;
    let callNumber = 0;
    const wrappers = new WeakMap();

    function record(result, includeOnly, number) {
        const keys = new Set();
        const characters = new Set();
        const wrappedCharacters = new WeakSet();
        let logged = false;
        let timer;
        function schedule() {
            clearTimeout(timer);
            timer = setTimeout(() => {
                console.log('[RisuAI Plugin: ' + pluginName + '] getDatabase #' + number +
                    (logged ? ' update' : '') + ': includeOnly=' + JSON.stringify(includeOnly) +
                    '; keys=' + JSON.stringify([...keys]) +
                    '; characters[i].chats touched=' + (characters.size > 0) +
                    '; characters=' + characters.size);
                logged = true;
            }, 2000);
        }
        function touched(set, key) {
            if (serializing || set.has(key)) return;
            set.add(key);
            schedule();
        }
        function accessor(object, key, read, replace = () => {}) {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor || !descriptor.configurable || !('value' in descriptor)) return;
            let value = descriptor.value;
            replace(value);
            Object.defineProperty(object, key, {
                enumerable: descriptor.enumerable,
                configurable: true,
                get() { read(); return value; },
                set(next) { value = next; replace(next); },
            });
        }
        function wrapCharacters(value) {
            if (!Array.isArray(value)) return;
            for (const character of value) {
                if (!character || typeof character !== 'object' || wrappedCharacters.has(character)) continue;
                wrappedCharacters.add(character);
                accessor(character, 'chats', () => touched(characters, character));
            }
        }
        if (result && typeof result === 'object') {
            for (const key of Object.keys(result)) {
                accessor(result, key, () => touched(keys, key), key === 'characters' ? wrapCharacters : undefined);
            }
        }
        schedule();
        return result;
    }

    function wrap(value) {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
        if (wrappers.has(value)) return wrappers.get(value);
        const proxy = new Proxy(value, {
            get(target, key, receiver) {
                const member = Reflect.get(target, key, receiver);
                if (typeof member === 'function') {
                    return (...args) => {
                        const number = key === 'getDatabase' ? ++callNumber : 0;
                        // The bridge serializes and posts inside the Promise executor, before returning.
                        serializing++;
                        let answer;
                        try { answer = Reflect.apply(member, target, args); }
                        finally { serializing--; }
                        if (!number) return answer;
                        const includeOnly = args[0] === undefined ? 'all' :
                            Array.isArray(args[0]) ? args[0].filter(key => typeof key === 'string') : 'invalid';
                        return Promise.resolve(answer).then(result => record(result, includeOnly, number));
                    };
                }
                // Alias objects contain bridge functions; constants pass through unchanged.
                if (member && Object.getPrototypeOf(member) === Object.prototype &&
                    Object.values(member).some(item => typeof item === 'function')) return wrap(member);
                return member;
            },
        });
        wrappers.set(value, proxy);
        return proxy;
    }
    window.risuai = wrap(window.risuai);
    window.Risuai = window.risuai;
})();`;
}

export async function hotReloadPluginFiles() {
    const observerSupported = !("FileSystemObserver" in window);

    if (!("showOpenFilePicker" in window)) {
        alertError(
            "Your browser does not support the File System Access API, which is required for hot-reloading plugin files.",
        );
        return;
    }

    let fileHandle: FileSystemFileHandle;
    try {
        [fileHandle] = await window.showOpenFilePicker({
            types: [
                {
                    description: "JavaScript or TypeScript Plugin File",
                    accept: {
                        "text/typescript": [".ts"],
                        "application/javascript": [".js"],
                    },
                },
            ],
        });
    } catch (error) {
        return;
    }

    let lastModified = 0;
    const callback = async () => {
        try {
            const file = await fileHandle.getFile();
            if (file.lastModified === lastModified) {
                return;
            }
            console.log("Detected change in plugin file, reloading...");
            lastModified = file.lastModified;
            const content = await file.text();
            await importPlugin(content, {
                isHotReload: true,
                isUpdate: true,
                isTypescript: file.name.endsWith(".ts"),
            });
        } catch (e) {
            console.error("Error reading file:", e);
        }
    };

    while (true) {
        await callback();
        await sleep(500);
    }
}
