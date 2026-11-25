import subprocess, sys
from pathlib import Path
cases = [
    ("ownership", "src/ts/storage/draftJournal.ts", "if (!lock || closed) {", "if (closed) {", "src/ts/storage/tests/draftJournal.test.ts"),
    ("replay-id", "src/ts/storage/journalRecovery.ts", "groupId: resend.groupId,", 'groupId: "review-broken-fresh-group",', "src/ts/bootstrap.journalRecovery.test.ts"),
    ("split-commit", "src/ts/storage/chatStore.svelte.ts", "if (resend.unconfirmed) continue;", "if (false) continue;", "src/ts/storage/tests/resourceSyncJournal.test.ts"),
    ("apply-id", "src/ts/storage/journalRecovery.ts", "createChat(ref.chaId, { ...snapshot, id: entry.id })", 'createChat(ref.chaId, { ...snapshot, id: "" })', "src/lib/Others/RecoveryDrafts.test.ts"),
    ("composer-id", "src/ts/process/composerDrafts.svelte.ts", "? { requestId: value.requestId }", "? {}", "src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts"),
]
name, product, old, new, test = cases[int(sys.argv[1])-1]
path = Path(product)
original = path.read_text()
assert original.count(old) == 1, (name, original.count(old))
assert not subprocess.check_output(["git", "diff", "--", product])
path.write_text(original.replace(old, new))
try:
    with open(f"scratch-review/break-{name}.log", "w") as log:
        result = subprocess.run(["pnpm", "--silent", "test:agent", test], stdout=log, stderr=subprocess.STDOUT)
    print(name, "test exit", result.returncode)
finally:
    subprocess.run(["git", "checkout", "--", product], check=True)
    assert path.read_text() == original
    print(product, "restored immediately")
