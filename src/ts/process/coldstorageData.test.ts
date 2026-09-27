import { describe, expect, it } from 'vitest'
import {
    coldStorageHeader,
    getColdStorageAffectedCharacters,
    getColdStorageBackupKey,
    getColdStorageBackupName,
    isColdStorageBackupData,
    listColdDataKeysFromDb,
} from './coldstorageData'

describe('coldstorageData', () => {
    it('collects unique character and chat cold storage keys from a database snapshot', () => {
        const characterKey = '11111111-1111-1111-1111-111111111111'
        const chatKey = '22222222-2222-2222-2222-222222222222'
        const nestedChatKey = '33333333-3333-3333-3333-333333333333'

        const keys = listColdDataKeysFromDb({
            characters: [
                {
                    coldstorage: characterKey,
                    coldStoragedChats: [chatKey, chatKey],
                    chats: [
                        {
                            message: [{
                                data: coldStorageHeader + nestedChatKey,
                            }],
                        },
                    ],
                },
                {
                    chats: [
                        {
                            message: [{
                                data: coldStorageHeader + chatKey,
                            }],
                        },
                    ],
                },
            ],
        } as any)

        expect(keys).toEqual([characterKey, chatKey, nestedChatKey])
    })

    it('maps unavailable cold storage keys to affected character names', () => {
        const characterKey = '11111111-1111-1111-1111-111111111111'
        const storedChatKey = '22222222-2222-2222-2222-222222222222'
        const activeChatKey = '33333333-3333-3333-3333-333333333333'
        const unknownKey = '44444444-4444-4444-4444-444444444444'

        const affected = getColdStorageAffectedCharacters({
            characters: [
                {
                    name: 'Stored Bot',
                    chaId: 'stored-bot',
                    coldstorage: characterKey,
                    coldStoragedChats: [storedChatKey],
                    chats: [],
                },
                {
                    name: 'Active Bot',
                    chaId: 'active-bot',
                    chats: [{
                        message: [{
                            data: coldStorageHeader + activeChatKey,
                        }],
                    }],
                },
                {
                    name: 'Healthy Bot',
                    chaId: 'healthy-bot',
                    chats: [],
                },
            ],
        } as any, [characterKey, storedChatKey, activeChatKey, unknownKey])

        expect(affected).toEqual({
            characterNames: ['Stored Bot', 'Active Bot'],
            unresolvedKeys: [unknownKey],
        })
    })

    it('uses the character id when an affected skeleton has no name', () => {
        const characterKey = '11111111-1111-1111-1111-111111111111'

        const affected = getColdStorageAffectedCharacters({
            characters: [{
                name: ' ',
                chaId: 'fallback-character-id',
                coldstorage: characterKey,
                chats: [],
            }],
        } as any, [characterKey])

        expect(affected.characterNames).toEqual(['fallback-character-id'])
        expect(affected.unresolvedKeys).toEqual([])
    })

    it('recognizes supported cold storage backup names', () => {
        const key = '11111111-1111-1111-1111-111111111111'

        expect(getColdStorageBackupName(key)).toBe(`coldstorage_${key}.json`)
        expect(getColdStorageBackupKey(`coldstorage_${key}.json`)).toBe(key)
        expect(getColdStorageBackupKey(`coldstorage/${key}.json`)).toBe(key)
        expect(getColdStorageBackupKey(`${key}.json`)).toBe(key)
        expect(getColdStorageBackupKey('assets/profile.png')).toBeNull()
    })

    it('accepts character, message, and legacy array cold storage payloads', () => {
        expect(isColdStorageBackupData({ character: {} })).toBe(true)
        expect(isColdStorageBackupData({ message: [] })).toBe(true)
        expect(isColdStorageBackupData([])).toBe(true)
        expect(isColdStorageBackupData({ nope: true })).toBe(false)
        expect(isColdStorageBackupData(null)).toBe(false)
    })
})
