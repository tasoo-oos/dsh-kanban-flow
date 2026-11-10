import { Readable } from 'node:stream'
import { apply } from '../../index.js'

export const WS = { id: 'ws-1', path: '/work/app', title: 'App' }

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
