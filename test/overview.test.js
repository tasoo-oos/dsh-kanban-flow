import { describe, expect, it } from 'vitest'
import { boardOverview, mapLimited, OVERVIEW_DONE_LIMIT, withTimeout } from '../lib/overview.js'
import { createItem, emptyBoard, moveItem } from '../lib/core.js'
import { fakeFs } from './helpers/fake-fs.js'
import { bootHost } from './helpers/host.js'

const A = { id: 'ws-a', path: '/work/a', title: 'Alpha' }
const B = { id: 'ws-b', path: '/work/b', title: 'Beta' }

describe('boardOverview', () => {
  it('keeps open items, the latest Done items and each item’s last activity', () => {
    const board = emptyBoard('AL')
    createItem(board, { name: 'open', actor: 'human' })
    for (let i = 0; i < OVERVIEW_DONE_LIMIT + 2; i += 1) {
      const { item } = createItem(board, { name: 'done ' + i, actor: 'human' })
      moveItem(board, { id: item.id, toColumn: 'done', actor: 'human' })
    }
    const row = boardOverview(A, { board, stale: false })
    expect(row.ok).toBe(true)
    expect(row.counts.backlog).toBe(1)
    expect(row.counts.done).toBe(OVERVIEW_DONE_LIMIT + 2)
    expect(row.doneHidden).toBe(2)
    expect(row.items).toHaveLength(1 + OVERVIEW_DONE_LIMIT)
    expect(row.items[0].name).toBe('open')
    expect(row.items[1].lastActivity).toMatchObject({ type: 'item_moved', to: 'done', source: 'human' })
    expect(row).not.toHaveProperty('activities')
  })
})

describe('helpers', () => {
  it('mapLimited keeps order and bounds concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimited([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })

  it('withTimeout rejects a slow promise', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'too slow')).rejects.toThrow('too slow')
    await expect(withTimeout(Promise.resolve(1), 10, 'x')).resolves.toBe(1)
  })
})

describe('overview over HTTP', () => {
  it('aggregates every workspace and reports unreachable boards separately', async () => {
    const fs = fakeFs()
    const host = bootHost(fs, [A, B])
    await host.http({ method: 'createItem', args: { workspaceId: A.id, name: 'alpha task' } })
    await host.http({ method: 'createItem', args: { workspaceId: B.id, name: 'beta task' } })
    const fresh = bootHost(fs, [A, B])
    const realStat = fs.stat
    fs.stat = async (target) => {
      if (target.targetKey.startsWith(B.path)) throw new Error('ssh: connection refused')
      return realStat(target)
    }
    const r = await fresh.http({ method: 'overview', args: {} })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const [a, b] = r.body.workspaces
    expect(a).toMatchObject({ workspaceId: A.id, title: 'Alpha', ok: true })
    expect(a.items.map((i) => i.name)).toEqual(['alpha task'])
    expect(b).toMatchObject({ workspaceId: B.id, ok: false })
    expect(b.error).toMatch(/connection refused/)
  })

  it('moves an item of any workspace through the per-workspace route', async () => {
    const fs = fakeFs()
    const host = bootHost(fs, [A, B])
    await host.http({ method: 'createItem', args: { workspaceId: B.id, name: 'beta task' } })
    const moved = await host.http({ method: 'moveItem', args: { workspaceId: B.id, id: 'BETA-1', toColumn: 'todo' } })
    expect(moved.body.ok).toBe(true)
    const r = await host.http({ method: 'overview', args: {} })
    expect(r.body.workspaces[1].counts.todo).toBe(1)
  })
})
