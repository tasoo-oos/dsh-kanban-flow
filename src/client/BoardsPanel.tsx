/**
 * Global Boards panel: every workspace's board on one five-column kanban.
 *
 * Opened from the sidebar panel list ("Boards"). Cards carry their
 * workspace; Review is ordered as a queue (longest waiting first) so the
 * items that need the human are worked one at a time. Dragging a card moves
 * it on its own workspace's board, with the same workflow (and agent pickup
 * on To Do) as the per-workspace board.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { callFlow } from "@/lib/api"
import { notifyBoard } from "@/lib/AgentDriver"
import { activityParts, relTime } from "@/lib/activity"
import { reviewCount, sortColumn, type OverviewItem, type OverviewStore, type WorkspaceOverview } from "@/lib/overview"
import { COLUMN_IDS, COLUMN_TITLES, type Activity, type Board, type ColumnId, type Item } from "@/lib/types"
import { CardDialog, type CardFormValues } from "./CardDialog"

export interface BoardsPanelSessions {
  open(sessionId: string): void
  list: { getSnapshot(): { byId?: Record<string, { running?: boolean }> }; subscribe(listener: () => void): () => void }
}

export interface BoardsPanelProps {
  store: OverviewStore
  sessions?: BoardsPanelSessions
  archiveSession?: (sessionId: string) => void
  /** Open one workspace's own board (Board tab). */
  openBoard?: (workspaceId: string) => void
}

interface Entry {
  key: string
  workspace: WorkspaceOverview
  item: OverviewItem
}

const keyOf = (workspaceId: string, itemId: string) => workspaceId + "\u0000" + itemId

const collision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args)
  if (pointer.length > 0) return pointer
  const rect = rectIntersection(args)
  return rect.length > 0 ? rect : closestCorners(args)
}

const noopSubscribe = () => () => {}
const emptyRows = () => undefined

function lastActivityParts(item: OverviewItem) {
  const a = item.lastActivity
  if (!a) return null
  const activity: Activity = { id: "", ts: a.ts, itemId: item.id, type: a.type, source: a.source, from: a.from, to: a.to }
  return activityParts(activity)
}

function GCard({ entry, running, onOpen }: { entry: Entry; running: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: entry.key })
  const { item, workspace } = entry
  const activity = lastActivityParts(item)
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={"kf-card kf-gcard" + (item.sessionId ? " kf-has-session" : "") + (isDragging ? " kf-dragging" : "")}
      style={{ ["--kf-card-accent" as string]: "var(--kf-accent, var(--dsw-alias-label-secondary))" }}
      onClick={onOpen}
      title={item.sessionId ? "Open the task session" : "Show item details"}
    >
      <div className="kf-gcard-workspace">
        <span className="kf-code-chip">{workspace.code || "?"}</span>
        <span className="kf-gcard-workspace-title">{workspace.title}</span>
        {workspace.stale && <span className="kf-gcard-offline">offline</span>}
      </div>
      <div className="kf-card-id">
        {item.id}
        {running && <span className="kf-gcard-running" title="The task session is running" />}
      </div>
      <div className="kf-card-name">{item.name}</div>
      {item.statusNote && (
        <div className="kf-gcard-status" title={item.statusNote}>
          {item.statusNote}
          {item.statusAt ? <span className="kf-card-activity-time"> · {relTime(item.statusAt)}</span> : null}
        </div>
      )}
      {activity && (
        <div className="kf-card-activity">
          <span className="kf-card-activity-phrase">{activity.phrase}</span>
          <span className="kf-card-activity-time">{activity.time}</span>
        </div>
      )}
    </div>
  )
}

function GColumn({ colId, entries, highlighted, runningOf, onOpen }: {
  colId: ColumnId
  entries: Entry[]
  highlighted: boolean
  runningOf: (sessionId: string | null) => boolean
  onOpen: (entry: Entry) => void
}) {
  const { setNodeRef } = useDroppable({ id: colId })
  return (
    <div className={"kf-column kf-" + colId + (highlighted ? " kf-over" : "")}>
      <div className="kf-column-head">
        <span className="kf-column-dot" />
        <span className="kf-column-title">{COLUMN_TITLES[colId]}</span>
        <span className="kf-gcolumn-count">{entries.length}</span>
      </div>
      <div className="kf-column-list" ref={setNodeRef}>
        {entries.length === 0 && <div className="kf-column-empty">No items</div>}
        {entries.map((entry) => (
          <GCard key={entry.key} entry={entry} running={runningOf(entry.item.sessionId)} onOpen={() => onOpen(entry)} />
        ))}
      </div>
    </div>
  )
}

function NewItemBar({ workspaces, onCreate, onCancel }: {
  workspaces: WorkspaceOverview[]
  onCreate: (workspaceId: string, name: string, description: string) => void
  onCancel: () => void
}) {
  const writable = workspaces.filter((w) => w.ok && !w.stale)
  const [workspaceId, setWorkspaceId] = useState(writable[0]?.workspaceId ?? "")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const submit = () => {
    if (workspaceId && name.trim()) onCreate(workspaceId, name, description)
  }
  return (
    <div className="kf-newitem kf-gnewitem">
      <select className="kf-input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Workspace">
        {writable.map((w) => (
          <option key={w.workspaceId} value={w.workspaceId}>{(w.code ? w.code + " · " : "") + w.title}</option>
        ))}
      </select>
      <input
        className="kf-input"
        autoFocus
        placeholder="Item name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
          if (e.key === "Escape") onCancel()
        }}
      />
      <textarea className="kf-textarea" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="kf-newitem-row">
        <button type="button" className="kf-btn kf-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="kf-btn kf-primary" disabled={!workspaceId || !name.trim()} onClick={submit}>Add to Backlog</button>
      </div>
    </div>
  )
}

export function BoardsPanel({ store, sessions, archiveSession, openBoard }: BoardsPanelProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // Session running flags (re-render on session list changes).
  const sessionRows = useSyncExternalStore(
    sessions ? sessions.list.subscribe : noopSubscribe,
    sessions ? () => sessions.list.getSnapshot()?.byId : emptyRows,
  )
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState("")
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<ColumnId | null>(null)
  const [details, setDetails] = useState<{ workspaceId: string; itemId: string; board: Board } | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  useEffect(() => store.activate(), [store])

  const { reachable, unreachable, withItems } = useMemo(() => {
    const all = snap.workspaces ?? []
    const ok = all.filter((w) => w.ok)
    return { reachable: ok, unreachable: all.filter((w) => !w.ok), withItems: ok.filter((w) => w.items.length > 0) }
  }, [snap.workspaces])

  const entries = useMemo(() => {
    const out: Entry[] = []
    for (const w of reachable) {
      if (hidden.has(w.workspaceId)) continue
      for (const item of w.items) out.push({ key: keyOf(w.workspaceId, item.id), workspace: w, item })
    }
    return out
  }, [reachable, hidden])

  const byColumn = useMemo(() => {
    const cols = new Map<ColumnId, Entry[]>(COLUMN_IDS.map((id) => [id, []]))
    for (const e of entries) cols.get(e.item.columnId)?.push(e)
    for (const id of COLUMN_IDS) cols.set(id, sortColumn(id, cols.get(id)!) as Entry[])
    return cols
  }, [entries])

  const runningOf = useCallback(
    (sessionId: string | null) => !!(sessionId && sessionRows && sessionRows[sessionId]?.running),
    [sessionRows],
  )

  // Feed the agent driver the board before and after a human change, so a
  // move to To Do starts the pickup exactly as on the per-workspace board.
  const act = useCallback(
    async (workspaceId: string, method: string, args: Record<string, unknown>) => {
      const before = await callFlow("get", {}, workspaceId)
      if (before.board) notifyBoard(workspaceId, before.board)
      const res = await callFlow(method, args, workspaceId)
      if (res.board) notifyBoard(workspaceId, res.board)
      setError(res.ok === false && res.error ? res.error : "")
      await store.refresh()
      return res
    },
    [store],
  )

  const onDragStart = (e: DragStartEvent) => setDragKey(String(e.active.id))
  const onDragOver = (e: { over: { id: string | number } | null }) => {
    const id = e.over ? String(e.over.id) : null
    setOverColumn(COLUMN_IDS.includes(id as ColumnId) ? (id as ColumnId) : null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    setDragKey(null)
    setOverColumn(null)
    if (!e.over) return
    const entry = entries.find((x) => x.key === String(e.active.id))
    if (!entry) return
    const overId = String(e.over.id)
    const target = COLUMN_IDS.includes(overId as ColumnId)
      ? (overId as ColumnId)
      : entries.find((x) => x.key === overId)?.item.columnId
    if (!target || target === entry.item.columnId) return
    void act(entry.workspace.workspaceId, "moveItem", { id: entry.item.id, toColumn: target })
  }

  const openEntry = async (entry: Entry) => {
    if (entry.item.sessionId && sessions) {
      sessions.open(entry.item.sessionId)
      return
    }
    const res = await callFlow("get", {}, entry.workspace.workspaceId)
    if (res.board) setDetails({ workspaceId: entry.workspace.workspaceId, itemId: entry.item.id, board: res.board })
    else if (res.error) setError(res.error)
  }

  const detailsItem: Item | null = details ? details.board.items.find((i) => i.id === details.itemId) ?? null : null
  const dragEntry = dragKey ? entries.find((x) => x.key === dragKey) : undefined
  const review = reviewCount(snap.workspaces)

  return (
    <div className="kf-root kf-global">
      <div className="kf-header">
        <span className="kf-header-title">Boards</span>
        <span className={"kf-count-chip" + (review > 0 ? " kf-gneeds" : "")}>{review} need you</span>
        <span className="kf-count-chip">{byColumn.get("in_progress")!.length} in progress</span>
        <button type="button" className="kf-btn kf-primary kf-new-item-btn" disabled={reachable.length === 0} onClick={() => setAdding(true)}>
          New item
        </button>
        <span className="kf-spacer" />
        {snap.updatedAt !== null && <span className="kf-muted">updated {relTime(new Date(snap.updatedAt).toISOString())}</span>}
        <button type="button" className="kf-iconbtn" title="Refresh" aria-label="Refresh boards" onClick={() => void store.refresh()}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
        </button>
      </div>
      {withItems.length > 1 && (
        <div className="kf-gfilters" role="group" aria-label="Workspaces">
          {withItems.map((w) => {
            const on = !hidden.has(w.workspaceId)
            return (
              <button
                key={w.workspaceId}
                type="button"
                className={"kf-gfilter" + (on ? " kf-on" : "")}
                aria-pressed={on}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev)
                    if (next.has(w.workspaceId)) next.delete(w.workspaceId)
                    else next.add(w.workspaceId)
                    return next
                  })
                }
                onDoubleClick={() => openBoard?.(w.workspaceId)}
                title={w.path + (openBoard ? " — double-click to open its board" : "")}
              >
                <span className="kf-code-chip">{w.code}</span>
                {w.title}
              </button>
            )
          })}
        </div>
      )}
      {unreachable.length > 0 && (
        <details className="kf-warning kf-gunreachable">
          <summary>{unreachable.length} workspace board{unreachable.length === 1 ? "" : "s"} unreachable</summary>
          {unreachable.map((w) => (
            <div key={w.workspaceId}>
              <strong>{w.title}</strong>: {w.error}
            </div>
          ))}
        </details>
      )}
      {snap.error && <div className="kf-error kf-loading">{snap.error}</div>}
      {error && <div className="kf-error">{error}</div>}
      {adding && (
        <NewItemBar
          workspaces={reachable}
          onCancel={() => setAdding(false)}
          onCreate={(workspaceId, name, description) => {
            setAdding(false)
            void act(workspaceId, "createItem", { name, description, columnId: "backlog" })
          }}
        />
      )}
      {snap.workspaces === null ? (
        !snap.error && <div className="kf-loading">Loading boards…</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver as any} onDragEnd={onDragEnd}>
          <div className="kf-body">
            <div className="kf-columns">
              {COLUMN_IDS.map((colId) => (
                <GColumn
                  key={colId}
                  colId={colId}
                  entries={byColumn.get(colId)!}
                  highlighted={overColumn === colId && dragKey !== null}
                  runningOf={runningOf}
                  onOpen={(entry) => void openEntry(entry)}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
            {dragEntry ? (
              <div className="kf-card kf-drag-ghost" style={{ width: 240 }}>
                <div className="kf-card-id">{dragEntry.item.id}</div>
                <div className="kf-card-name">{dragEntry.item.name}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
      {details && detailsItem && (
        <CardDialog
          item={detailsItem}
          board={details.board}
          onOpenChange={(open) => { if (!open) setDetails(null) }}
          onSave={(values: CardFormValues) => {
            const { workspaceId, itemId } = details
            setDetails(null)
            void act(workspaceId, "updateItem", { id: itemId, name: values.name, description: values.description })
          }}
          onDelete={(id) => {
            const { workspaceId } = details
            setDetails(null)
            void act(workspaceId, "deleteItem", { id })
            if (detailsItem.sessionId && archiveSession) archiveSession(detailsItem.sessionId)
          }}
          onOpenSession={(item) => {
            setDetails(null)
            if (item.sessionId && sessions) sessions.open(item.sessionId)
          }}
        />
      )}
    </div>
  )
}

/** Sidebar panel icon with the count of items waiting in Review. */
export function BoardsIcon({ size, store }: { size?: number; store: OverviewStore }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const review = reviewCount(snap.workspaces)
  const edge = size ?? 16
  return (
    <span className="kf-gicon" style={{ width: edge, height: edge }}>
      <svg viewBox="0 0 16 16" width={edge} height={edge} fill="none" aria-hidden="true">
        <rect x="1.5" y="2" width="4" height="12" rx="1.4" fill="currentColor" />
        <rect x="6" y="2" width="4" height="8" rx="1.4" fill="currentColor" />
        <rect x="10.5" y="2" width="4" height="5" rx="1.4" fill="currentColor" />
      </svg>
      {review > 0 && <span className="kf-gicon-badge" aria-label={review + " items need you"}>{review > 99 ? "99+" : review}</span>}
    </span>
  )
}
