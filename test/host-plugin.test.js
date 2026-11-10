import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { apply } from '../index.js'
import { BOARD_FILE } from '../lib/board-store.js'
import { fakeFs } from './helpers/fake-fs.js'

const WS = { id: 'ws-1', path: '/work/app', title: 'App' }
const BOARD_KEY = WS.path + '/' + BOARD_FILE

/** Boot the host plugin against a fake fs, registry, tool registry and web server. */
export function bootHost(fs, workspaces = [WS]) {
  const tools = new Map()
  let handler = null
  const services = {
    fs,
    workspaceRegistry: {
      get: (id) => workspaces.find((w) => w.id === id),
      list: () => workspaces,
      resolveByPath: async (path) => workspaces.find((w) => w.path === path),
    },
    webServer: { register: (route) => { handler = route.handler } },
  }
  const ctx = {
    get: (name) => services[name],
    tools: { register: (tool) => tools.set(tool.name, tool) },
  }
  apply(ctx)
  const http = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    let status = 0
    let text = ''
    const res = { writeHead: (s) => { status = s }, end: (t) => { text = t } }
    await handler(req, res)
    return { status, body: JSON.parse(text) }
  }
  const tool = (name, args, cwd = WS.path) =>
    tools.get(name).execute(args, { agent: { session: { header: { cwd } } } })
  return { http, tool, tools }
}

describe('host plugin over the board store', () => {
  it('creates and reads items through HTTP and tools', async () => {
    const fs = fakeFs()
    const host = bootHost(fs)
    const created = await host.http({ method: 'createItem', args: { workspaceId: WS.id, name: 'Write docs' } })
    expect(created.body.ok).toBe(true)
    expect(created.body.persisted).toBe(true)
    const got = await host.tool('kanbanflow_get', {})
    expect(got.ok).toBe(true)
    expect(got.rules).toMatch(/Kanban workflow rules/)
    expect(got.summary.columns[0].items.map((i) => i.name)).toEqual(['Write docs'])
    expect(JSON.parse(fs.files.get(BOARD_KEY).text).items).toHaveLength(1)
  })

  it('answers an unreadable board without a placeholder board and never writes it', async () => {
    const fs = fakeFs()
    await bootHost(fs).http({ method: 'createItem', args: { workspaceId: WS.id, name: 'kept' } })
    const before = fs.files.get(BOARD_KEY)
    const host = bootHost(fs)
    fs.fail.read = new Error('sftp channel closed')
    const got = await host.http({ method: 'get', args: { workspaceId: WS.id } })
    expect(got.body.ok).toBe(false)
    expect(got.body.unavailable).toBe(true)
    expect(got.body.board).toBeUndefined()
    const moved = await host.tool('kanbanflow_create_item', { name: 'lost' })
    expect(moved.ok).toBe(false)
    expect(moved.message).toMatch(/could not be read/)
    expect(fs.files.get(BOARD_KEY)).toBe(before)
  })

  it('keeps enforcing agent workflow guards', async () => {
    const host = bootHost(fakeFs())
    const r = await host.tool('kanbanflow_create_item', { name: 'x', columnId: 'todo' })
    expect(r.ok).toBe(false)
    await host.http({ method: 'createItem', args: { workspaceId: WS.id, name: 'item' } })
    const move = await host.tool('kanbanflow_move_item', { id: 'APP-1', toColumn: 'done' })
    expect(move.ok).toBe(false)
    expect(move.message).toMatch(/Backlog/)
  })

  it('rejects unknown workspaces over HTTP', async () => {
    const host = bootHost(fakeFs())
    const r = await host.http({ method: 'get', args: { workspaceId: 'nope' } })
    expect(r.status).toBe(400)
  })
})
