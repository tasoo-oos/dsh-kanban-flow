import { describe, expect, it } from 'vitest'
import { BOARD_FILE, BoardUnavailableError, createBoardStore } from '../lib/board-store.js'
import { createItem, SCHEMA_VERSION } from '../lib/core.js'
import { fakeFs } from './helpers/fake-fs.js'

const WS = { id: 'ws-1', path: '/work/app', title: 'App' }
const BOARD_KEY = WS.path + '/' + BOARD_FILE

const once = (message) => Object.assign(new Error(message), { once: true })
const always = (message) => new Error(message)

function makeStore(fs, extra = {}) {
  return createBoardStore({
    getFs: () => fs,
    writePolicyFor: () => ({ mode: 'workspace-write' }),
    initialCode: () => 'APP',
    log: () => {},
    revalidateMs: 0,
    ...extra,
  })
}

const addItem = (name) => (board) => createItem(board, { name, actor: 'human' })
const fileBoard = (fs) => JSON.parse(fs.files.get(BOARD_KEY).text)

describe('board store: new and existing files', () => {
  it('starts an absent board empty and creates the file on the first mutation', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    const snap = await store.read(WS)
    expect(snap.board.items).toEqual([])
    expect(snap.persisted).toBe(true)
    expect(fs.files.has(BOARD_KEY)).toBe(false)
    const out = await store.mutate(WS, undefined, addItem('first'))
    expect(out.result.item.id).toBe('APP-1')
    expect(fileBoard(fs).items.map((i) => i.name)).toEqual(['first'])
    expect(fileBoard(fs).schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('loads an existing board file', async () => {
    const fs = fakeFs()
    await makeStore(fs).mutate(WS, undefined, addItem('kept'))
    const snap = await makeStore(fs).read(WS)
    expect(snap.board.items.map((i) => i.name)).toEqual(['kept'])
  })
})

describe('board store: failed loads never overwrite the file', () => {
  it('does not cache a failed lookup; the next access retries', async () => {
    const fs = fakeFs()
    await makeStore(fs).mutate(WS, undefined, addItem('kept'))
    const store = makeStore(fs)
    fs.fail.resolve = once('connection closed')
    await expect(store.read(WS)).rejects.toBeInstanceOf(BoardUnavailableError)
    const snap = await store.read(WS)
    expect(snap.board.items.map((i) => i.name)).toEqual(['kept'])
  })

  it('refuses mutations when the first read fails, leaving the file untouched', async () => {
    const fs = fakeFs()
    await makeStore(fs).mutate(WS, undefined, addItem('kept'))
    const before = fs.files.get(BOARD_KEY)
    const store = makeStore(fs)
    fs.fail.read = always('sftp channel closed')
    await expect(store.read(WS)).rejects.toThrow(/could not be read/)
    await expect(store.mutate(WS, undefined, addItem('lost'))).rejects.toBeInstanceOf(BoardUnavailableError)
    expect(fs.files.get(BOARD_KEY)).toBe(before)
    fs.fail.read = null
    const out = await store.mutate(WS, undefined, addItem('second'))
    expect(out.board.items.map((i) => i.name)).toEqual(['kept', 'second'])
  })

  it('serves the last good board as stale while the file is unreachable', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    await store.mutate(WS, undefined, addItem('kept'))
    fs.fail.stat = always('host unreachable')
    const snap = await store.read(WS)
    expect(snap.stale).toBe(true)
    expect(snap.board.items.map((i) => i.name)).toEqual(['kept'])
    expect(snap.warnings.join(' ')).toMatch(/unreachable/)
    const again = await store.read(WS)
    expect(again.stale).toBe(true)
    expect(again.warnings).toEqual([])
    await expect(store.mutate(WS, undefined, addItem('lost'))).rejects.toBeInstanceOf(BoardUnavailableError)
    expect(fileBoard(fs).items).toHaveLength(1)
  })

  it('keeps the previous board when a write fails', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    await store.mutate(WS, undefined, addItem('kept'))
    fs.fail.write = once('disk full')
    await expect(store.mutate(WS, undefined, addItem('lost'))).rejects.toThrow(/could not be saved/)
    const snap = await store.read(WS)
    expect(snap.board.items.map((i) => i.name)).toEqual(['kept'])
  })

  it('does not write when the mutation reports an error', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    await store.mutate(WS, undefined, addItem('kept'))
    const before = fs.files.get(BOARD_KEY)
    const out = await store.mutate(WS, undefined, () => ({ error: 'Item not found: X' }))
    expect(out.result.error).toMatch(/not found/)
    expect(fs.files.get(BOARD_KEY)).toBe(before)
  })
})

describe('board store: external changes', () => {
  it('re-reads the file when it changes outside dsh', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    await store.mutate(WS, undefined, addItem('mine'))
    const edited = fileBoard(fs)
    edited.items[0].name = 'edited by git pull'
    fs.put(BOARD_KEY, JSON.stringify(edited))
    const snap = await store.read(WS)
    expect(snap.board.items.map((i) => i.name)).toEqual(['edited by git pull'])
  })

  it('replays a mutation on the fresh board after a concurrent write', async () => {
    const fs = fakeFs()
    const a = makeStore(fs)
    const b = makeStore(fs)
    await a.read(WS)
    await b.mutate(WS, undefined, addItem('from b'))
    // a still caches the absent-file state; its createIfAbsent write conflicts and replays.
    const out = await a.mutate(WS, undefined, addItem('from a'))
    expect(out.board.items.map((i) => i.id + ':' + i.name)).toEqual(['APP-1:from b', 'APP-2:from a'])
    expect(fileBoard(fs).items).toHaveLength(2)
  })

  it('resets the board when the file is deleted outside dsh', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    await store.mutate(WS, undefined, addItem('gone'))
    fs.files.delete(BOARD_KEY)
    const snap = await store.read(WS)
    expect(snap.board.items).toEqual([])
  })

  it('serializes concurrent mutations of one workspace', async () => {
    const fs = fakeFs()
    const store = makeStore(fs)
    await Promise.all([1, 2, 3, 4].map((n) => store.mutate(WS, undefined, addItem('n' + n))))
    expect(fileBoard(fs).items.map((i) => i.id).sort()).toEqual(['APP-1', 'APP-2', 'APP-3', 'APP-4'])
  })
})

describe('board store: damaged and legacy files', () => {
  it('backs up a corrupt file before it may be replaced', async () => {
    const fs = fakeFs()
    fs.put(BOARD_KEY, '{ not json')
    const store = makeStore(fs)
    const snap = await store.read(WS)
    expect(snap.board.items).toEqual([])
    expect(snap.warnings.join(' ')).toMatch(/not valid JSON/)
    const backups = [...fs.files.keys()].filter((k) => k.startsWith(BOARD_KEY + '.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(fs.files.get(backups[0]).text).toBe('{ not json')
    await store.mutate(WS, undefined, addItem('fresh'))
    expect(fileBoard(fs).items.map((i) => i.name)).toEqual(['fresh'])
  })

  it('keeps a corrupt file read-only when its backup fails', async () => {
    const fs = fakeFs()
    fs.put(BOARD_KEY, '{ not json')
    fs.fail.writeMatch = /\.corrupt-/
    fs.fail.write = always('permission denied')
    const store = makeStore(fs)
    const snap = await store.read(WS)
    expect(snap.warnings.join(' ')).toMatch(/read-only/)
    await expect(store.mutate(WS, undefined, addItem('lost'))).rejects.toThrow(/read-only/)
    expect(fs.files.get(BOARD_KEY).text).toBe('{ not json')
  })

  it('backs up and upgrades a legacy schema file', async () => {
    const fs = fakeFs()
    const legacy = JSON.stringify({ schemaVersion: 1, code: 'OLD', seq: 1, items: [{ id: 'OLD-1', name: 'legacy', columnId: 'todo' }], activities: [] })
    fs.put(BOARD_KEY, legacy)
    const snap = await makeStore(fs).read(WS)
    expect(snap.board.items.map((i) => i.id)).toEqual(['OLD-1'])
    expect(fs.files.get(BOARD_KEY + '.bak-v1').text).toBe(legacy)
    expect(fileBoard(fs).schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe('board store: memory-only mode', () => {
  it('works without a filesystem service and reports the board as not persisted', async () => {
    const store = createBoardStore({ getFs: () => undefined, writePolicyFor: () => ({}), initialCode: () => 'MEM', log: () => {} })
    const out = await store.mutate(WS, undefined, addItem('volatile'))
    expect(out.persisted).toBe(false)
    const snap = await store.read(WS)
    expect(snap.persisted).toBe(false)
    expect(snap.board.items.map((i) => i.id)).toEqual(['MEM-1'])
  })
})
