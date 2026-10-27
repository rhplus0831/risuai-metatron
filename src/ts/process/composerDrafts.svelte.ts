export type ComposerDraft = { input: string; translate: string; files: string[] };
/** A chat's live composer while shown, or its stashed draft otherwise. */
export type ComposerView = ComposerDraft;

class ComposerState implements ComposerDraft {
    input = $state("");
    translate = $state("");
    files: string[] = $state([]);
}

/** Keeps each chat's composer in memory for this screen's lifetime. */
export function createComposer() {
    const live = new ComposerState();
    const drafts = new Map<string, ComposerDraft>();
    let shown: string | null = null;

    /** Stashes the previous chat's nonempty draft and loads the next chat's composer. */
    function switchTo(key: string | null): void {
        if (key === shown) return;
        if (shown !== null) {
            if (live.input === "" && live.translate === "" && live.files.length === 0) {
                drafts.delete(shown);
            } else {
                drafts.set(shown, { input: live.input, translate: live.translate, files: live.files });
            }
        }
        const draft = key === null ? undefined : drafts.get(key);
        shown = key;
        if (key !== null) drafts.delete(key);
        live.input = draft?.input ?? "";
        live.translate = draft?.translate ?? "";
        live.files = draft?.files ?? [];
    }

    /** Routes reads and writes to this chat even after the shown chat changes. */
    function at(key: string): ComposerView {
        const read = () => (key === shown ? live : drafts.get(key));
        const write = () => {
            let draft = read();
            if (!draft) {
                draft = { input: "", translate: "", files: [] };
                drafts.set(key, draft);
            }
            return draft;
        };
        return {
            get input() {
                return read()?.input ?? "";
            },
            set input(value: string) {
                write().input = value;
            },
            get translate() {
                return read()?.translate ?? "";
            },
            set translate(value: string) {
                write().translate = value;
            },
            get files() {
                return write().files;
            },
            set files(value: string[]) {
                write().files = value;
            },
        };
    }

    return Object.assign(live, { switchTo, at });
}
