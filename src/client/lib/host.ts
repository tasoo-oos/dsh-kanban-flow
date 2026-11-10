/**
 * Adapters from the dsh Web Client services to the shapes the board UI uses.
 *
 * dsh 0.2.x changed three things the board relied on:
 *  - `sessions.list` no longer carries `current`; the shown Session is the row
 *    retained by the main view (`byId[id].retainedBy.mainView > 0`).
 *  - `sessions.open` and `workspaces.startSession` moved to the `uiWorkspace`
 *    navigation service (`openSession`, `startSession`).
 *  - `sessions.binding(id)` only borrows an already-retained Session; callers
 *    retain it first (`sessions.using`).
 *
 * The facades below keep the older members (`list.getSnapshot().current`,
 * `open`, `startSession`) available on both generations, so the controllers
 * and the board view stay generation-neutral.
 */

/** Minimal observable store shape shared by the dsh client services. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface SessionRow {
  blank?: boolean
  retainedBy?: Record<string, number | undefined>
}

export interface SessionListSnapshot {
  current?: string
  ids?: string[]
  byId?: Record<string, SessionRow>
}

interface SessionFace {
  rename(title: string): Promise<any>
  prompt(content: Array<{ type: string; text: string }>, mode: "queue" | "steer"): Promise<any>
}

export interface RawSessions {
  list: Observable<SessionListSnapshot>
  open?(sessionId: string): void
  create(opts?: { workspaceId?: string }): Promise<string>
  binding(id: string): { session: SessionFace } | undefined
  using?<T>(id: string, options: { source: string }, operation: (reference: { binding: { session: SessionFace } }) => T | Promise<T>): Promise<T>
}

export interface RawWorkspaces {
  list: Observable<any>
  startSession?(workspaceId?: string): void
  archiveSession?(sessionId: string): Promise<void>
}

export interface RawUiWorkspace {
  openSession?(sessionId: string): void
  startSession?(workspaceId?: string): void
  archiveSession?(sessionId: string): Promise<void>
}

/** The Session shown in the main view, on either client generation. */
export function currentSessionId(snapshot: SessionListSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined
  if (typeof snapshot.current === "string") return snapshot.current
  const byId = snapshot.byId ?? {}
  for (const id of snapshot.ids ?? Object.keys(byId)) {
    const mainView = byId[id]?.retainedBy?.mainView
    if (typeof mainView === "number" && mainView > 0) return id
  }
  return undefined
}

/** Reference source label for Sessions the board retains to prompt or rename. */
export const RETAIN_SOURCE = "kanbanFlow"

/** Board-facing Session service: older member names on any client generation. */
export interface SessionsFacade {
  list: Observable<SessionListSnapshot>
  open(sessionId: string): void
  create(opts?: { workspaceId?: string }): Promise<string>
  /** Borrow the main view's binding (only for the Session already shown). */
  binding(id: string): { session: SessionFace } | undefined
  /** Run `operation` with the Session retained for its duration. */
  withSession<T>(id: string, operation: (session: SessionFace) => T | Promise<T>): Promise<T>
}

export interface WorkspacesFacade {
  list: Observable<any>
  startSession(workspaceId?: string): void
  archiveSession?(sessionId: string): Promise<void>
}

/** Memoize a derived snapshot per source snapshot (stable identity between changes). */
function derived<S, D>(source: Observable<S>, derive: (s: S) => D): Observable<D> {
  let lastSource: S | undefined
  let lastDerived: D | undefined
  let primed = false
  return {
    getSnapshot() {
      const s = source.getSnapshot()
      if (!primed || s !== lastSource) {
        lastSource = s
        lastDerived = derive(s)
        primed = true
      }
      return lastDerived as D
    },
    subscribe: (listener) => source.subscribe(listener),
  }
}

export function sessionsFacade(sessions: RawSessions, ui: RawUiWorkspace | undefined): SessionsFacade {
  const list = derived(sessions.list, (s) => (s && typeof s.current === "string" ? s : { ...s, current: currentSessionId(s) }))
  return {
    list,
    open(sessionId) {
      if (ui && typeof ui.openSession === "function") ui.openSession(sessionId)
      else if (typeof sessions.open === "function") sessions.open(sessionId)
    },
    create: (opts) => sessions.create(opts),
    binding: (id) => sessions.binding(id),
    async withSession(id, operation) {
      if (typeof sessions.using === "function") {
        return sessions.using(id, { source: RETAIN_SOURCE }, (reference) => operation(reference.binding.session))
      }
      const binding = sessions.binding(id)
      if (!binding) throw new Error("session binding unavailable: " + id)
      return operation(binding.session)
    },
  }
}

export function workspacesFacade(workspaces: RawWorkspaces, ui: RawUiWorkspace | undefined): WorkspacesFacade {
  return {
    list: workspaces.list,
    startSession(workspaceId) {
      if (ui && typeof ui.startSession === "function") ui.startSession(workspaceId)
      else if (typeof workspaces.startSession === "function") workspaces.startSession(workspaceId)
    },
    archiveSession:
      typeof workspaces.archiveSession === "function"
        ? (sessionId) => workspaces.archiveSession!(sessionId)
        : ui && typeof ui.archiveSession === "function"
          ? (sessionId) => ui.archiveSession!(sessionId)
          : undefined,
  }
}

/** Workspace id of a sidebar workspace row from its stable row key (dsh 0.2.x). */
export function workspaceIdFromRowKey(rowKey: string | null | undefined): string | null {
  if (typeof rowKey !== "string" || !rowKey.startsWith("workspace:")) return null
  const id = rowKey.slice("workspace:".length)
  return id === "" ? null : id
}
