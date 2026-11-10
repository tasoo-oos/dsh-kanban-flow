import { describe, expect, it, vi } from 'vitest'
import { currentSessionId, sessionsFacade, workspaceIdFromRowKey, workspacesFacade } from '../src/client/lib/host'
import { KanbanFlowPlugin } from '../src/client/plugin'

const store = (value) => {
  let snapshot = value
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set: (next) => {
      snapshot = next
      for (const fn of listeners) fn()
    },
  }
}

describe('currentSessionId', () => {
  it('reads the legacy current field', () => {
    expect(currentSessionId({ current: 's1', ids: [], byId: {} })).toBe('s1')
  })

  it('derives the main-view Session on dsh 0.2.x', () => {
    const snap = {
      ids: ['a', 'b'],
      byId: { a: { retainedBy: { gateway: 1 } }, b: { retainedBy: { mainView: 1 } } },
    }
    expect(currentSessionId(snap)).toBe('b')
    expect(currentSessionId({ ids: ['a'], byId: { a: { retainedBy: {} } } })).toBeUndefined()
  })
})

describe('sessionsFacade', () => {
  it('adds a stable current field to the list snapshot', () => {
    const list = store({ ids: ['a'], byId: { a: { retainedBy: { mainView: 1 } } } })
    const facade = sessionsFacade({ list, create: async () => 'x', binding: () => undefined }, undefined)
    const first = facade.list.getSnapshot()
    expect(first.current).toBe('a')
    expect(facade.list.getSnapshot()).toBe(first)
    list.set({ ids: ['a'], byId: { a: { retainedBy: {} } } })
    expect(facade.list.getSnapshot().current).toBeUndefined()
  })

  it('opens Sessions through uiWorkspace when available', () => {
    const openSession = vi.fn()
    const open = vi.fn()
    const facade = sessionsFacade({ list: store({}), open, create: async () => 'x', binding: () => undefined }, { openSession })
    facade.open('s1')
    expect(openSession).toHaveBeenCalledWith('s1')
    expect(open).not.toHaveBeenCalled()
  })

  it('retains a Session around an operation with sessions.using', async () => {
    const session = { prompt: vi.fn(async () => ({ ok: true })), rename: vi.fn() }
    const using = vi.fn(async (id, options, operation) => operation({ binding: { session } }))
    const facade = sessionsFacade({ list: store({}), create: async () => 'x', binding: () => undefined, using }, undefined)
    await facade.withSession('s1', (s) => s.prompt([{ type: 'text', text: 'hi' }], 'queue'))
    expect(using).toHaveBeenCalledWith('s1', { source: 'kanbanFlow' }, expect.any(Function))
    expect(session.prompt).toHaveBeenCalled()
  })

  it('falls back to an existing binding on older clients', async () => {
    const session = { prompt: vi.fn(async () => ({ ok: true })), rename: vi.fn() }
    const facade = sessionsFacade({ list: store({}), create: async () => 'x', binding: (id) => (id === 's1' ? { session } : undefined) }, undefined)
    await facade.withSession('s1', (s) => s.rename('t'))
    expect(session.rename).toHaveBeenCalledWith('t')
    await expect(facade.withSession('s2', () => 1)).rejects.toThrow(/binding unavailable/)
  })
})

describe('workspacesFacade', () => {
  it('starts Sessions through uiWorkspace and archives through workspaces', async () => {
    const startSession = vi.fn()
    const archiveSession = vi.fn(async () => {})
    const facade = workspacesFacade({ list: store({ items: [] }), archiveSession }, { startSession })
    facade.startSession('w1')
    expect(startSession).toHaveBeenCalledWith('w1')
    await facade.archiveSession('s1')
    expect(archiveSession).toHaveBeenCalledWith('s1')
  })
})

describe('workspaceIdFromRowKey', () => {
  it('maps workspace row keys and ignores other rows', () => {
    expect(workspaceIdFromRowKey('workspace:ws-1')).toBe('ws-1')
    expect(workspaceIdFromRowKey('workspace:')).toBeNull()
    expect(workspaceIdFromRowKey('session:abc')).toBeNull()
    expect(workspaceIdFromRowKey(null)).toBeNull()
  })
})

describe('workspace context menu', () => {
  it('registers an Open board action for workspace rows', () => {
    const contributions = []
    const services = {
      slots: { inject: () => {}, register: () => () => null },
      workspaces: { list: store({ items: [] }) },
      sessions: { list: store({}), create: async () => 'x', binding: () => undefined },
      uiWorkspace: {},
      contextMenus: { register: (c) => { contributions.push(c); return () => {} } },
    }
    KanbanFlowPlugin.apply({ get: (name) => services[name], effect: (fn) => fn() })
    expect(contributions).toHaveLength(1)
    expect(contributions[0].target).toBe('workspace')
    const actions = contributions[0].resolve({ workspaceId: 'w1', path: '/p', displayTitle: 'P' }, new AbortController().signal)
    expect(actions.map((a) => a.label)).toEqual(['Open board'])
  })
})
