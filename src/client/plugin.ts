/**
 * dsh-kanban-flow client plugin: slot registrations.
 *
 *  - conversation.view       "Board" tab — the in-app board for the session's
 *                            workspace (opened from the sidebar; see below)
 *  - settings.plugins.tab    Settings → Plugins → Kanban Flow panel (the
 *                            workspace-click toggle lives ONLY here)
 *  - sidebar.footer.action   invisible controllers: sidebar kanban icons,
 *                            workspace click mode, in-app board opener,
 *                            agent driver wiring
 */
import { createElement as h, useEffect, useSyncExternalStore } from "react"
import { KanbanBoard } from "./KanbanBoard"
import { SettingsTab } from "./SettingsPanel"
import { ArchiveSync, BoardDismiss, BoardOpener, BoardTabToggle, ClickMode, SidebarIcons, getBoardOverride, openBoardInApp, setBoardOverride, subscribeBoardOverride } from "./Controllers"
import { initAgentDriver } from "./lib/AgentDriver"
import { resolveBoardWorkspace } from "./lib/resolve"
import {
  sessionsFacade,
  workspacesFacade,
  type RawSessions,
  type RawUiWorkspace,
  type RawWorkspaces,
  type SessionsFacade,
  type WorkspacesFacade,
} from "./lib/host"

interface WorkspaceSnapshot {
  items: Array<{ workspaceId: string; title: string; sessionIds: string[] }>
  recentWorkspaceId?: string
}

type WorkspacesService = WorkspacesFacade
type SessionsServiceFull = SessionsFacade

interface ContextMenusService {
  register(contribution: {
    id: string
    target: string
    order: number
    resolve(target: { workspaceId?: string }, signal: AbortSignal): Array<{ id: string; label: string; run?: () => void }>
  }): () => void
}

function useWorkspaceSnapshot(workspaces: WorkspacesService | undefined): WorkspaceSnapshot {
  const fallback: WorkspaceSnapshot = { items: [] }
  if (!workspaces || !workspaces.list || typeof workspaces.list.getSnapshot !== "function") return fallback
  return useSyncExternalStore(
    (fn) => workspaces.list.subscribe(fn),
    () => workspaces.list.getSnapshot() as WorkspaceSnapshot,
  )
}

/**
 * The current session id from the sessions list (a primitive snapshot, so
 * useSyncExternalStore is safe). The conversation.view slot passes no session
 * identity in its props — this subscription is the reliable source.
 */
function useCurrentSession(sessions: SessionsServiceFull | undefined): string | undefined {
  if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return undefined
  return useSyncExternalStore(
    (fn) => sessions.list.subscribe(fn),
    () => (sessions.list.getSnapshot() as { current?: string }).current,
  )
}

/** Board tab inside a conversation (session-scoped props carry sessionId). */
function BoardTabView(props: { sessionId?: string; workspaces?: WorkspacesService; sessions?: SessionsServiceFull }) {
  const snap = useWorkspaceSnapshot(props.workspaces)
  const override = useSyncExternalStore(subscribeBoardOverride, getBoardOverride)
  const currentSessionId = useCurrentSession(props.sessions) ?? props.sessionId
  const resolved = resolveBoardWorkspace({
    override,
    currentSessionId,
    workspaceItems: Array.isArray(snap.items) ? snap.items : [],
    recentWorkspaceId: snap.recentWorkspaceId,
  })

  // Once a session of the override workspace is current, native resolution
  // takes over and the override becomes redundant — clear it.
  useEffect(() => {
    if (override && resolved.nativeWorkspaceId === override.workspaceId) setBoardOverride(null)
  }, [override, resolved.nativeWorkspaceId])

  const archiveSession = props.workspaces?.archiveSession
    ? (sessionId: string) => { void props.workspaces!.archiveSession!(sessionId) }
    : undefined
  return h(KanbanBoard, {
    workspaceId: resolved.workspaceId,
    workspaceTitle: resolved.pinned
      ? resolved.workspaceTitle || resolved.workspaceId
      : resolved.workspaceTitle,
    sessions: props.sessions,
    archiveSession,
  })
}

/** Settings tab: the single global preference (workspace-click behavior). */
function SettingsTabView() {
  return h(SettingsTab)
}

/** Invisible root controller host: sidebar icons, click mode, board opener. */
function RootControllers(props: { workspaces?: WorkspacesService; sessions?: SessionsServiceFull }) {
  useEffect(() => {
    const sessions = props.sessions
    if (!sessions) return
    initAgentDriver({
      createSession: (workspaceId) => sessions.create({ workspaceId }),
      renameSession: (sessionId, title) =>
        sessions.withSession(sessionId, async (session) => {
          const r = await session.rename(title)
          if (r && r.ok === false) console.warn("dsh-kanban-flow: rename failed", r.error)
        }),
      promptSession: (sessionId, text) =>
        sessions.withSession(sessionId, async (session) => {
          const r = await session.prompt([{ type: "text", text }], "queue")
          if (r && r.ok === false) throw new Error("prompt failed: " + (r.error && r.error.message))
        }),
      archiveSession: async (sessionId) => {
        const archive = props.workspaces?.archiveSession
        if (!archive) throw new Error("workspaces.archiveSession unavailable")
        await archive(sessionId)
      },
    })
  }, [props.sessions, props.workspaces])
  return h("div", { style: { display: "contents" } },
    h(BoardOpener, { workspaces: props.workspaces, sessions: props.sessions }),
    h(BoardDismiss, { workspaces: props.workspaces, sessions: props.sessions }),
    h(BoardTabToggle),
    h(ArchiveSync, { workspaces: props.workspaces }),
    h(SidebarIcons, { workspaces: props.workspaces }),
    h(ClickMode, { workspaces: props.workspaces }),
  )
}

export const KanbanFlowPlugin = {
  name: "dsh-kanban-flow",
  inject: ["slots", "workspaces", "sessions", "uiWorkspace", "contextMenus"],
  apply(ctx: any) {
    const slots = ctx.get("slots")
    if (slots === undefined) return
    const rawWorkspaces: RawWorkspaces | undefined = ctx.get("workspaces")
    const rawSessions: RawSessions | undefined = ctx.get("sessions")
    const uiWorkspace: RawUiWorkspace | undefined = ctx.get("uiWorkspace")
    const contextMenus: ContextMenusService | undefined = ctx.get("contextMenus")
    const workspaces = rawWorkspaces ? workspacesFacade(rawWorkspaces, uiWorkspace) : undefined
    const sessions = rawSessions ? sessionsFacade(rawSessions, uiWorkspace) : undefined

    // "Board" tab beside conversation views — the in-app board surface.
    slots.inject("conversation.view", () =>
      slots.register(
        { name: "conversation.view", id: "kanban-flow", order: 20, label: "Board" },
        (props: any) => h(BoardTabView, { ...props, workspaces, sessions }),
      ),
    )

    // Settings → Plugins → Kanban Flow.
    slots.inject("settings.plugins.tab", () =>
      slots.register(
        { name: "settings.plugins.tab", id: "dsh-kanban-flow", order: 10, label: "Kanban Flow" },
        () => h(SettingsTabView),
      ),
    )

    // Always-mounted controllers in the sidebar footer action area.
    slots.inject("sidebar.footer.action", () =>
      slots.register(
        { name: "sidebar.footer.action", id: "kanban-flow-controllers", order: 90 },
        () => h(RootControllers, { workspaces, sessions }),
      ),
    )

    // Workspace row menu (right click / "..." button): a supported entry
    // point that does not depend on the sidebar markup.
    if (contextMenus && typeof contextMenus.register === "function") {
      const register = () => contextMenus.register({
        id: "kanban-flow.workspace",
        target: "workspace",
        order: 150,
        resolve: (target) =>
          typeof target?.workspaceId === "string"
            ? [{ id: "open-board", label: "Open board", run: () => openBoardInApp(target.workspaceId!) }]
            : [],
      })
      if (typeof ctx.effect === "function") ctx.effect(register, "dsh-kanban-flow: workspace menu")
      else register()
    }
  },
}
