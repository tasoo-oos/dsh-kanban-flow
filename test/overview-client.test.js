import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_POLL_MS, IDLE_POLL_MS, createOverviewStore, reviewCount, sortColumn } from '../src/client/lib/overview'

const item = (id, columnId, ts) => ({ id, columnId, name: id, lastActivity: ts ? { type: 'item_moved', source: 'agent', from: null, to: columnId, ts } : null })

describe('overview ordering', () => {
  it('orders Review oldest-waiting first and other columns newest first', () => {
    const a = { item: item('A', 'review', '2026-11-10T01:00:00Z') }
    const b = { item: item('B', 'review', '2026-11-10T02:00:00Z') }
    expect(sortColumn('review', [b, a]).map((e) => e.item.id)).toEqual(['A', 'B'])
    expect(sortColumn('in_progress', [a, b]).map((e) => e.item.id)).toEqual(['B', 'A'])
  })

  it('counts Review items of reachable boards only', () => {
    expect(reviewCount(null)).toBe(0)
    expect(reviewCount([
      { ok: true, items: [item('A', 'review'), item('B', 'todo')] },
      { ok: false, items: [item('C', 'review')] },
    ])).toBe(1)
  })
})

describe('overview store', () => {
  afterEach(() => vi.useRealTimers())

  it('polls only while subscribed and faster while the panel is active', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => ({ ok: true, workspaces: [] }))
    const store = createOverviewStore(fetch)
    expect(fetch).not.toHaveBeenCalled()
    const unsubscribe = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().workspaces).toEqual([])
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    const deactivate = store.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(4)
    deactivate()
    unsubscribe()
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('keeps the last overview when a request fails', async () => {
    const results = [{ ok: true, workspaces: [{ workspaceId: 'w', ok: true, items: [] }] }, { ok: false, error: 'boom' }]
    const store = createOverviewStore(async () => results.shift())
    await store.refresh()
    await store.refresh()
    expect(store.getSnapshot().workspaces).toHaveLength(1)
    expect(store.getSnapshot().error).toBe('boom')
  })
})
