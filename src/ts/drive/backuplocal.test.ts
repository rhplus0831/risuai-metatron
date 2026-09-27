import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Risu Account sync and cold storage were both removed. These tests pin the
// replacement behavior of `LoadLocalBackup`: an archive carrying `encryption.risudat`
// is rejected before any asset or database write happens, ordinary archives still
// restore in full, and legacy `coldstorage_<uuid>.json` records from older archives
// are skipped instead of being written into `assets/`.

const {
    alertError,
    alertNormal,
    alertWait,
    alertStoreSet,
    forageSetItem,
    setDatabaseLite,
    decodeRisuSave,
    requiresFullEncoderReload,
} = vi.hoisted(() => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertWait: vi.fn(),
    alertStoreSet: vi.fn(),
    forageSetItem: vi.fn(async (_key: string, _value: unknown) => undefined),
    setDatabaseLite: vi.fn(),
    decodeRisuSave: vi.fn(async (_data: Uint8Array) => ({ characters: [] })),
    requiresFullEncoderReload: { state: false },
}))

vi.mock('../alert', () => ({
    alertError,
    alertNormal,
    alertWait,
    alertMd: vi.fn(),
    alertConfirm: vi.fn(async () => true),
    alertStore: { set: alertStoreSet },
}))

vi.mock('../globalApi.svelte', () => ({
    LocalWriter: class {},
    forageStorage: {
        setItem: forageSetItem,
        getItem: vi.fn(async () => null),
    },
    requiresFullEncoderReload,
}))

vi.mock('../storage/risuSave', () => ({
    decodeRisuSave,
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: vi.fn(() => ({ characters: [] })),
    setDatabaseLite,
}))

vi.mock('../util', () => ({
    sleep: vi.fn(async () => undefined),
}))

vi.mock('src/lang', () => ({
    language: {},
}))

import { LoadLocalBackup } from './backuplocal'

const encoder = new TextEncoder()

/** Mirrors `LocalWriter.writeBackup`: u32 LE name length, utf8 name, u32 LE data length, bytes. */
function record(name: string, data: Uint8Array): Uint8Array {
    const encodedName = encoder.encode(name)
    const out = new Uint8Array(4 + encodedName.byteLength + 4 + data.byteLength)
    const view = new DataView(out.buffer)
    view.setUint32(0, encodedName.byteLength, true)
    out.set(encodedName, 4)
    view.setUint32(4 + encodedName.byteLength, data.byteLength, true)
    out.set(data, 4 + encodedName.byteLength + 4)
    return out
}

function archive(records: Uint8Array[]): File {
    const total = records.reduce((sum, r) => sum + r.byteLength, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const r of records) {
        out.set(r, offset)
        offset += r.byteLength
    }
    return new File([out], 'backup.bin')
}

/** Runs `LoadLocalBackup` against `file` by capturing the hidden file input it creates. */
async function loadBackup(file: File): Promise<void> {
    const realCreate = document.createElement.bind(document)
    let input: HTMLInputElement | null = null
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = realCreate(tag)
        if (tag === 'input') {
            input = el as HTMLInputElement
            el.click = () => {}
        }
        return el
    })

    LoadLocalBackup()

    expect(input).not.toBeNull()
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await input!.onchange!(new Event('change'))
}

const coldKey = '11111111-1111-1111-1111-111111111111'
const coldRecordName = `coldstorage_${coldKey}.json`
const dbBytes = new Uint8Array([9, 8, 7, 6])

describe('LoadLocalBackup after Risu Account and cold storage removal', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        requiresFullEncoderReload.state = false
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network must not be used while restoring a local backup')
        }))
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('rejects an account-encrypted archive before writing any record', async () => {
        // The old writer emitted assets and cold payloads first, then encryption.risudat,
        // then the encrypted database. The preflight must catch the marker anyway.
        const file = archive([
            record('a1b2c3d4.png', new Uint8Array([1, 2, 3])),
            record(coldRecordName, encoder.encode(JSON.stringify({ message: [] }))),
            record('encryption.risudat', encoder.encode(JSON.stringify({ type: 'account', time: 123 }))),
            record('database.risudat', dbBytes),
        ])

        await loadBackup(file)

        expect(alertError).toHaveBeenCalledTimes(1)
        expect(alertError.mock.calls[0][0]).toMatch(/Risu Account/)
        expect(forageSetItem).not.toHaveBeenCalled()
        expect(setDatabaseLite).not.toHaveBeenCalled()
        expect(decodeRisuSave).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
        expect(requiresFullEncoderReload.state).toBe(false)
    })

    it('restores a plain archive and only scans record headers for the marker', async () => {
        // The marker string inside record *data* must not trigger the rejection.
        const assetData = encoder.encode('not a header: encryption.risudat')
        const file = archive([
            record('a1b2c3d4.png', assetData),
            record('database.risudat', dbBytes),
        ])

        await loadBackup(file)

        expect(alertError).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()

        expect(forageSetItem).toHaveBeenCalledWith('assets/a1b2c3d4.png', expect.any(Uint8Array))
        const assetCall = forageSetItem.mock.calls.find((c) => c[0] === 'assets/a1b2c3d4.png')!
        expect(Array.from(assetCall[1] as Uint8Array)).toEqual(Array.from(assetData))

        expect(decodeRisuSave).toHaveBeenCalledTimes(1)
        expect(Array.from(decodeRisuSave.mock.calls[0][0] as Uint8Array)).toEqual(Array.from(dbBytes))
        expect(setDatabaseLite).toHaveBeenCalledWith({ characters: [] })
        expect(forageSetItem).toHaveBeenCalledWith('database/database.bin', expect.any(Uint8Array))
        expect(requiresFullEncoderReload.state).toBe(true)
        expect(alertNormal).toHaveBeenCalledWith('Success')
    })

    it('skips legacy cold storage records and still writes every other record to assets/', async () => {
        // Older archives carry `coldstorage_<uuid>.json` payloads. Nothing reads them
        // anymore, so they must not be restored as assets. The skip is by name only:
        // any other `.json` record is an ordinary asset and is written as before.
        const assetData = encoder.encode('png bytes')
        const otherJson = encoder.encode('{"not":"cold"}')
        const file = archive([
            record(coldRecordName, encoder.encode(JSON.stringify({ message: [{ data: 'hello' }] }))),
            record('a1b2c3d4.png', assetData),
            record('notes.json', otherJson),
            record(`coldstorage_${coldKey.replace(/1/g, '2')}.json`, encoder.encode(JSON.stringify({ character: {} }))),
            record('database.risudat', dbBytes),
        ])

        await loadBackup(file)

        expect(alertError).not.toHaveBeenCalled()

        const writtenKeys = forageSetItem.mock.calls.map((c) => c[0] as string)
        expect(writtenKeys.filter((k) => k.startsWith('assets/')).sort()).toEqual([
            'assets/a1b2c3d4.png',
            'assets/notes.json',
        ])
        expect(writtenKeys.some((k) => k.includes('coldstorage_'))).toBe(false)
        const notesCall = forageSetItem.mock.calls.find((c) => c[0] === 'assets/notes.json')!
        expect(Array.from(notesCall[1] as Uint8Array)).toEqual(Array.from(otherJson))

        expect(decodeRisuSave).toHaveBeenCalledTimes(1)
        expect(setDatabaseLite).toHaveBeenCalledWith({ characters: [] })
        expect(forageSetItem).toHaveBeenCalledWith('database/database.bin', expect.any(Uint8Array))
        expect(alertNormal).toHaveBeenCalledWith('Success')
    })

    it('does not treat a truncated archive as encrypted and still reports the missing database', async () => {
        // A header that claims more bytes than the file holds ends the scan, then the
        // streaming loader reports the corruption as before.
        const bogus = record('a1b2c3d4.png', new Uint8Array([1, 2, 3]))
        new DataView(bogus.buffer).setUint32(4 + 'a1b2c3d4.png'.length, 1024, true)
        const file = archive([bogus])

        await loadBackup(file)

        expect(alertError).toHaveBeenCalledTimes(1)
        expect(alertError.mock.calls[0][0]).toBe('Failed, Is file corrupted?')
        expect(forageSetItem).not.toHaveBeenCalled()
        expect(setDatabaseLite).not.toHaveBeenCalled()
    })
})
