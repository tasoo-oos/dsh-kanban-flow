/**
 * Cross-workspace overview: wire types of the host `overview` method and a
 * polling store shared by the sidebar Boards icon (badge) and the Boards
 * panel. Polling runs only while someone subscribes; the panel asks for the
 * faster interval while it is open.
 */
import { callFlow } from "./api"
import type { ColumnId } from "./types"

export interface OverviewActivity {
  type: string
  source: "human" | "agent"
  from: string | null
  to: string | null
  ts: string
}

export interface OverviewItem {
  id: string
  columnId: ColumnId
  name: string
  description: string
  sessionId: string | null
  createdAt: string | null
  createdBy: "human" | "agent"
  statusNote: string | null
  statusAt: string | null
  lastActivity: OverviewActivity | null
}

export interface WorkspaceOverview {
  workspaceId: string
  title: string
  path: string
  ok: boolean
  error?: string
  stale?: boolean
  code?: string
  confirmRequired?: boolean
  counts?: Record<ColumnId, number>
  doneHidden?: number
  items: OverviewItem[]
}

export interface OverviewSnapshot {
  /** Last successful overview; null before the first one. */
  workspaces: WorkspaceOverview[] | null
  /** Error of the last request, cleared by the next success. */
  error: string | null
  loading: boolean
  updatedAt: number | null
}

/** Background interval (sidebar badge only). */
export const IDLE_POLL_MS = 20000
/** Interval while the Boards panel is open. */
export const ACTIVE_POLL_MS = 5000

export interface OverviewStore {
  getSnapshot(): OverviewSnapshot
  subscribe(listener: () => void): () => void
  /** Request an immediate refresh (coalesced with one in flight). */
  refresh(): Promise<void>
  /** Mark the panel open (fast polling) until the returned function runs. */
  activate(): () => void
}

type Fetch = () => Promise<{ ok?: boolean; error?: string; workspaces?: WorkspaceOverview[] }>

export function createOverviewStore(fetchOverview: Fetch = () => callFlow("overview", {}, "") as any): OverviewStore {
  let snapshot: OverviewSnapshot = { workspaces: null, error: null, loading: false, updatedAt: null }
  const listeners = new Set<() => void>()
  let active = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const publish = (next: Partial<OverviewSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const l of Array.from(listeners)) l()
  }

  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (listeners.size === 0) return
    timer = setTimeout(() => {
      void refresh()
    }, active > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS)
  }

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight
    publish({ loading: true })
    inFlight = fetchOverview()
      .then((res) => {
        if (res && res.ok !== false && Array.isArray(res.workspaces)) {
          publish({ workspaces: res.workspaces, error: null, loading: false, updatedAt: Date.now() })
        } else {
          publish({ error: (res && res.error) || "Overview unavailable", loading: false })
        }
      })
      .catch((err) => publish({ error: String((err && err.message) || err), loading: false }))
      .finally(() => {
        inFlight = null
        schedule()
      })
    return inFlight
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) void refresh()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
    },
    refresh,
    activate() {
      active += 1
      void refresh()
      let done = false
      return () => {
        if (done) return
        done = true
        active -= 1
        schedule()
      }
    },
  }
}

/** Items waiting on the human: Review across all reachable boards. */
export function reviewCount(workspaces: WorkspaceOverview[] | null): number {
  if (!workspaces) return 0
  let n = 0
  for (const w of workspaces) if (w.ok) for (const i of w.items) if (i.columnId === "review") n += 1
  return n
}

/** Epoch ms of an item's last activity (0 when unknown). */
export function activityTime(item: OverviewItem): number {
  const t = item.lastActivity ? Date.parse(item.lastActivity.ts) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * Column order for the global board: Review is a queue (longest waiting
 * first); every other column shows the most recently active first.
 */
export function sortColumn(columnId: ColumnId, items: Array<{ item: OverviewItem }>): Array<{ item: OverviewItem }> {
  const sign = columnId === "review" ? 1 : -1
  return [...items].sort((a, b) => sign * (activityTime(a.item) - activityTime(b.item)))
}
