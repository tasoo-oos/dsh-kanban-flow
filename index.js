/**
 * dsh-kanban-flow — DSH bundle host plugin (standard Cordis function plugin).
 *
 * Mounted via package.json `dsh.bundle.patch` -> cordis.patch.yml, which inserts
 * this plugin's layer row into the profile composition; the loader resolves this
 * file by package name dsh-kanban-flow.
 *
 * Responsibilities:
 *  - One board per workspace, persisted to <workspace.path>/.dsh-kanban-flow.json
 *  - Model tools registered via ctx.tools.register (kanbanflow_*)
 *  - Browser data layer at /api/kanban-flow via ctx.get('webServer'), including
 *    the cross-workspace `overview` read behind the global Boards panel
 *  - Workflow state machine enforcement with actor tracking (human vs agent)
 *
 * Board schema lives in lib/core.js; file loading, revalidation and
 * conditional writes live in lib/board-store.js.
 */
import {
  COLUMN_IDS,
  COLUMN_TITLES,
  summarizeBoard,
  workflowRules,
  cloneBoard,
  createItem,
  updateItem,
  deleteItem,
  moveItem,
  setCode,
  setConfirmRequired,
  setStatus,
  deriveCode,
} from './lib/core.js'
import { BoardUnavailableError, createBoardStore } from './lib/board-store.js'
import { boardOverview, mapLimited, unavailableOverview, withTimeout } from './lib/overview.js'

export const name = 'dsh-kanban-flow'
export const inject = ['tools']

/** Boards loaded at once by the cross-workspace overview. */
const OVERVIEW_CONCURRENCY = 4
/** Per-workspace wait before the overview reports a board as unreachable. */
const OVERVIEW_TIMEOUT_MS = 8000

/** Read-only dispatch methods; everything else mutates through the store. */
const READ_METHODS = new Set(['get', 'getMeta', 'getItem'])

/**
 * Board mutations keyed by dispatch method. Each runs on a private copy of
 * the fresh board and may be replayed after a write conflict, so it must be
 * a pure function of (board, args, actor).
 */
const MUTATIONS = {
  createItem: (board, a, actor) => createItem(board, { name: a.name, description: a.description, columnId: a.columnId, actor }),
  updateItem: (board, a, actor) => updateItem(board, { id: a.id, name: a.name, description: a.description, actor }),
  deleteItem: (board, a, actor) => deleteItem(board, String(a.id || ''), actor),
  moveItem: (board, a, actor) => {
    const r = moveItem(board, { id: a.id, toColumn: a.toColumn, actor })
    if (!r.error && typeof a.sessionId === 'string' && a.sessionId) {
      const item = board.items.find((i) => i.id === a.id)
      if (item && !item.sessionId) item.sessionId = a.sessionId
    }
    return r
  },
  setSession: (board, a) => {
    const item = board.items.find((i) => i.id === String(a.id || ''))
    if (!item) return { error: 'Item not found: ' + String(a.id || '') }
    item.sessionId = String(a.sessionId || '') || null
    return { message: 'Session linked to ' + item.id }
  },
  setCode: (board, a) => setCode(board, String(a.code || ''), true),
  setStatus: (board, a, actor) => setStatus(board, { id: String(a.id || ''), note: a.note, actor }),
  setConfirmRequired: (board, a) => setConfirmRequired(board, a.value === true),
}

export function apply(ctx) {
  const getFs = () => ctx.get('fs')
  const getPolicy = () => ctx.get('sandboxPolicy')
  const getWorkspaceRegistry = () => ctx.get('workspaceRegistry')

  const writePolicyFor = (workspace, session) => {
    const policy = getPolicy()
    const resolved =
      policy && typeof policy.resolve === 'function'
        ? policy.resolve(session ? { session } : {})
        : { mode: (policy && policy.defaultMode) || 'workspace-write' }
    return { ...resolved, workspaceRoot: workspace.path }
  }

  const store = createBoardStore({
    getFs,
    writePolicyFor,
    initialCode: (workspace) => deriveCode(workspace.title || workspace.path || ''),
  })

  // ---- shared dispatch: tools (agent) and HTTP (human) ----
  const dispatch = async (workspace, method, args, source, session) => {
    const a = args || {}
    const actor = source === 'agent' ? 'agent' : 'human'
    // An unavailable board answers without a `board` field: clients keep
    // showing what they had instead of an empty placeholder.
    const unavailable = (err) => ({ ok: false, unavailable: true, error: err.message, warnings: [] })

    if (READ_METHODS.has(method)) {
      let snap
      try {
        snap = await store.read(workspace, session)
      } catch (err) {
        if (err instanceof BoardUnavailableError) return unavailable(err)
        throw err
      }
      const board = snap.board
      const ok = (extra) => ({ ok: true, board: cloneBoard(board), persisted: snap.persisted, stale: snap.stale, warnings: snap.warnings, ...extra })
      const fail = (error) => ({ ok: false, error, board: cloneBoard(board), stale: snap.stale, warnings: snap.warnings })
      switch (method) {
        case 'get':
          return ok({ message: 'Board loaded', summary: summarizeBoard(board) })
        case 'getMeta':
          return ok({
            message: 'Meta loaded',
            meta: { code: board.code, codeConfirmed: board.codeConfirmed === true, confirmRequired: !!(board.settings && board.settings.confirmRequired), derived: deriveCode(workspace.title || String(workspace.id || workspace.path)) },
          })
        case 'getItem': {
          const item = board.items.find((i) => i.id === String(a.id || ''))
          if (!item) return fail('Item not found: ' + String(a.id || ''))
          return ok({ item, message: 'Item ' + item.id })
        }
      }
    }

    const mutation = MUTATIONS[method]
    if (!mutation) return { ok: false, error: 'Unknown kanban-flow method: ' + method, warnings: [] }

    // Actor-based guards live HERE (the single choke point every caller goes
    // through — tool wrapper, HTTP route, future callers alike).
    if (actor === 'agent' && method === 'createItem' && a.columnId === 'todo') {
      return { ok: false, error: 'Move rejected: agents never place items into To Do. Create in Backlog and let the human triage.', warnings: [] }
    }

    let out
    try {
      out = await store.mutate(workspace, session, (board) => mutation(board, a, actor))
    } catch (err) {
      if (err instanceof BoardUnavailableError) return unavailable(err)
      throw err
    }
    const r = out.result || {}
    if (r.error) return { ok: false, error: r.error, board: cloneBoard(out.board), warnings: out.warnings }
    return {
      ok: true,
      board: cloneBoard(out.board),
      persisted: out.persisted,
      warnings: out.warnings,
      message: r.message,
      ...(r.item ? { item: r.item } : {}),
    }
  }

  // ---- cross-workspace overview (global Boards panel) ----
  const overview = async () => {
    const registry = getWorkspaceRegistry()
    const list = registry && typeof registry.list === 'function' ? registry.list() : []
    const workspaces = await mapLimited(list, OVERVIEW_CONCURRENCY, async (workspace) => {
      try {
        const snap = await withTimeout(
          store.read(workspace),
          OVERVIEW_TIMEOUT_MS,
          'Board file did not answer within ' + OVERVIEW_TIMEOUT_MS / 1000 + 's',
        )
        return boardOverview(workspace, snap)
      } catch (err) {
        return unavailableOverview(workspace, (err && err.message) || err)
      }
    })
    return { ok: true, generatedAt: new Date().toISOString(), workspaces }
  }

  // ---- tool execution context -> workspace ----
  const workspaceOfExec = async (exec) => {
    const agent = exec && exec.agent
    const session = agent && agent.session
    const cwd = session && session.header && session.header.cwd
    if (typeof cwd !== 'string' || !cwd) return null
    const registry = getWorkspaceRegistry()
    if (registry) {
      try {
        const workspace = await registry.resolveByPath(cwd)
        if (workspace) return workspace
      } catch (err) {
        console.log('dsh-kanban-flow: workspace resolve failed: ' + ((err && err.message) || err))
      }
    }
    return { id: 'cwd:' + cwd, path: cwd, title: cwd }
  }
  const workspaceOfId = (id) => {
    const registry = getWorkspaceRegistry()
    return registry && typeof registry.get === 'function' ? registry.get(id) : undefined
  }

  const runTool = async (method, args, exec) => {
    const workspace = await workspaceOfExec(exec)
    if (!workspace) {
      return { ok: false, message: 'Cannot determine the current workspace from the tool execution context', warnings: [] }
    }
    const session = exec && exec.agent && exec.agent.session
    const r = await dispatch(workspace, method, args, 'agent', session)
    // NOTE: never include undefined-valued keys — DSH's tool-output snapshotter
    // rejects values that don't survive a JSON round-trip losslessly.
    const out = {
      ok: r.ok !== false,
      message: r.error || r.message || 'Done',
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
    }
    if (r.summary) out.summary = r.summary
    if (r.item) out.item = r.item
    else if (r.ok !== false) out.board = summarizeBoard(r.board)
    return out
  }

  const output = (render) => ({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        summary: { type: 'object' },
        item: { type: 'object' },
        board: { type: 'object' },
        rules: { type: 'string' },
      },
      required: ['ok', 'message'],
      additionalProperties: false,
    },
    render,
  })

  const renderSummary = (value) => {
    const lines = []
    if (Array.isArray(value && value.warnings)) for (const w of value.warnings) lines.push('⚠ ' + w)
    lines.push(String((value && value.message) || ''))
    const b = value && (value.summary || value.board)
    if (b && Array.isArray(b.columns)) {
      for (const col of b.columns) {
        lines.push('')
        lines.push(col.title + ' (' + col.count + '):')
        if (!col.items.length) lines.push('  (empty)')
        for (const it of col.items) lines.push('  ' + it.id + ' — ' + it.name)
      }
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const tools = [
    {
      name: 'kanbanflow_get',
      description: 'Read the kanban board of the current workspace: columns, items, ids, settings and the mandatory workflow rules. Call this before touching any item.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output(renderSummary),
      async execute(args, exec) {
        const workspace = await workspaceOfExec(exec)
        if (!workspace) return { ok: false, message: 'Cannot determine the current workspace from the tool execution context', warnings: [] }
        const session = exec && exec.agent && exec.agent.session
        const r = await dispatch(workspace, 'get', args, 'agent', session)
        if (r.ok === false) return { ok: false, message: r.error || 'Board unavailable', warnings: Array.isArray(r.warnings) ? r.warnings : [] }
        return {
          ok: true,
          message: r.message + ' (code ' + r.board.code + ')' + (r.stale ? ' [stale: the board file is unreachable; changes are disabled]' : ''),
          summary: r.summary,
          rules: workflowRules(r.board),
          warnings: Array.isArray(r.warnings) ? r.warnings : [],
        }
      },
    },
    {
      name: 'kanbanflow_get_item',
      description: 'Read one kanban item: name, description, column and its task-session link.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Item id, e.g. KANBAN-1' } }, required: ['id'], additionalProperties: false },
      output: output((args, value) => {
        const lines = []
        if (Array.isArray(value && value.warnings)) for (const w of value.warnings) lines.push('⚠ ' + w)
        lines.push(String((value && value.message) || ''))
        const it = value && value.item
        if (it) {
          lines.push('Column: ' + COLUMN_TITLES[it.columnId])
          lines.push('Name: ' + it.name)
          if (it.description) lines.push('Description: ' + it.description)
          if (it.statusNote) lines.push('Status: ' + it.statusNote + (it.statusAt ? ' (' + it.statusAt + ')' : ''))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }),
      async execute(args, exec) { return runTool('getItem', args, exec) },
    },
    {
      name: 'kanbanflow_create_item',
      description: 'Create a kanban item on the current workspace board. Items are created in Backlog by default and wait for the human to move them to To Do.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short, actionable item name' },
          description: { type: 'string', description: 'Background, acceptance criteria or breakdown (optional)' },
          columnId: { type: 'string', enum: COLUMN_IDS, description: 'Target column; defaults to backlog. Agents must not use todo.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: output(renderSummary),
      async execute(args, exec) {
        if (args && args.columnId === 'todo') {
          return { ok: false, message: 'Move rejected: agents never place items into To Do. Create in Backlog and let the human triage.', warnings: [] }
        }
        return runTool('createItem', args, exec)
      },
    },
    {
      name: 'kanbanflow_update_item',
      description: "Update an item's name or description.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id' },
          name: { type: 'string', description: 'New name (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: output(renderSummary),
      async execute(args, exec) { return runTool('updateItem', args, exec) },
    },
    {
      name: 'kanbanflow_delete_item',
      description: 'Delete an item from the board (permanent). Its task session is archived automatically. Only delete when the human asks.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Item id' } }, required: ['id'], additionalProperties: false },
      output: output(renderSummary),
      async execute(args, exec) { return runTool('deleteItem', args, exec) },
    },
    {
      name: 'kanbanflow_move_item',
      description: 'Move an item between columns. Agent transitions are enforced: To Do -> In Progress (confirm pickup), In Progress -> Review, In Progress -> Done (only when completion confirmation is off), Review -> In Progress (after human feedback), Done -> In Progress (human replied on a finished item). Agents never move anything into To Do or Done-from-Review.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id' },
          toColumn: { type: 'string', enum: COLUMN_IDS, description: 'Target column id' },
        },
        required: ['id', 'toColumn'],
        additionalProperties: false,
      },
      output: output(renderSummary),
      async execute(args, exec) { return runTool('moveItem', args, exec) },
    },
    {
      name: 'kanbanflow_set_status',
      description: "Set the item's short status note (shown to the human on the board card on hover). Call this at the end of every turn: max 2 sentences — what is done, what is next or what you need from the human.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id' },
          note: { type: 'string', description: 'Short status text (max ~400 chars); empty string clears it' },
        },
        required: ['id', 'note'],
        additionalProperties: false,
      },
      output: output(renderSummary),
      async execute(args, exec) { return runTool('setStatus', args, exec) },
    },
    {
      name: 'kanbanflow_set_code',
      description: 'Change the board code (2-6 chars A-Z0-9) that prefixes item ids, e.g. API-3. Existing item ids are kept stable.',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'New board code' } }, required: ['code'], additionalProperties: false },
      output: output(renderSummary),
      async execute(args, exec) { return runTool('setCode', args, exec) },
    },
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // ---- browser data layer: /api/kanban-flow ----
  const httpHandler = async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : {}
      const method = typeof body.method === 'string' ? body.method : 'get'
      const args = body.args || {}
      if (method === 'overview') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(await overview()))
        return
      }
      const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId : ''
      const workspace = workspaceId ? workspaceOfId(workspaceId) : undefined
      if (!workspace) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Unknown workspace: ' + (workspaceId || '(missing)') }))
        return
      }
      const result = await dispatch(workspace, method, args, 'human')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
    }
  }

  const routeState = { registered: false, timer: null, attempts: 0 }
  const registerRoute = () => {
    if (routeState.registered) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    try {
      webServer.register({ kind: 'prefix', path: '/api/kanban-flow', handler: httpHandler })
      routeState.registered = true
      console.log('dsh-kanban-flow: /api/kanban-flow route registered')
    } catch (err) {
      console.log('dsh-kanban-flow: route registration failed: ' + ((err && err.message) || err))
    }
  }
  registerRoute()
  if (!routeState.registered) {
    routeState.timer = setInterval(() => {
      routeState.attempts += 1
      registerRoute()
      if (routeState.registered || routeState.attempts >= 30) clearInterval(routeState.timer)
    }, 2000)
  }
}
