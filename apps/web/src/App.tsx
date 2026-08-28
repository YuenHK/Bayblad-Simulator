import type { TopDesign } from "@steam-top/domain";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DesignerPage } from "./features/designer/DesignerPage";
import { loadDesignerDraft } from "./features/designer/designerDraft";
import { LobbyPage } from "./features/lobby/LobbyPage";
import { RoomPage } from "./features/room/RoomPage";
import { createRealtimeClient, type RealtimeClient } from "./realtime/socket-client";
import { createSafeStorage, type SafeStorage } from "./realtime/safe-storage";

const DESIGN_ID_KEY = "steam-top.design-id";
const browserStorage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

export function App({ client: suppliedClient, storage: suppliedStorage }: Readonly<{ client?: RealtimeClient; storage?: SafeStorage }>) {
  const storage = useMemo(() => suppliedStorage ?? createSafeStorage(browserStorage()), [suppliedStorage]);
  const client = useMemo(() => suppliedClient ?? createRealtimeClient(), [suppliedClient]);
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const [page, setPage] = useState<"designer" | "lobby" | "room">("designer");
  const [design, setDesign] = useState<TopDesign>(() => loadDesignerDraft());
  const [designId, setDesignId] = useState<string | null>(() => storage.get(DESIGN_ID_KEY));
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const actionController = useRef<AbortController | null>(null);

  useEffect(() => { client.start(); return () => { actionController.current?.abort(); client.stop(); }; }, [client]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  useEffect(() => { if (state.room) setPage("room"); }, [state.room]);
  useEffect(() => { if (page === "room" && !state.room) setPage("lobby"); }, [page, state.room]);
  useEffect(() => { if (state.sessionStatus === "replaced" || state.sessionStatus === "new") { actionController.current?.abort(); actionController.current = null; setBusy(false); setDesignId(null); storage.remove(DESIGN_ID_KEY); if (state.sessionStatus === "replaced") setPage("lobby"); } }, [state.sessionStatus, storage]);

  const useFromDesigner = async (next: TopDesign) => {
    if (busy) return;
    actionController.current?.abort(); const controller = new AbortController(); actionController.current = controller;
    setBusy(true); setActionError(null); setDesign(next);
    try {
      const id = await client.uploadDesign(next, controller.signal);
      setDesignId(id); storage.set(DESIGN_ID_KEY, id); setPage("lobby");
    } catch (error) { if (!(error instanceof Error && error.name === "AbortError")) setActionError(error instanceof Error ? error.message : "上載設計失敗。"); }
    finally { if (actionController.current === controller) { actionController.current = null; setBusy(false); } }
  };

  const ready = async () => {
    if (!state.room || state.room.viewer.role === "spectator" || busy) return;
    actionController.current?.abort(); const controller = new AbortController(); actionController.current = controller;
    setBusy(true); setActionError(null);
    try {
      const id = await client.readyWithDesign(state.room.roomId, design, controller.signal);
      setDesignId(id); storage.set(DESIGN_ID_KEY, id);
    } catch (error) { if (!(error instanceof Error && error.name === "AbortError")) setActionError(error instanceof Error ? error.message : "無法準備。"); }
    finally { if (actionController.current === controller) { actionController.current = null; setBusy(false); } }
  };

  const send = (command: Parameters<RealtimeClient["command"]>[0]) => { setActionError(null); try { client.command(command); } catch (error) { setActionError(error instanceof Error ? error.message : "操作失敗。"); } };

  const connectionLabel = state.status === "online" ? "已連線" : state.status === "reconnecting" ? "重新連線中……" : state.status === "connecting" ? "連線中……" : "離線";
  const phase = state.matchFinished || state.cancelledReason ? "result" : state.room?.phase ?? "waiting";
  return <>
    <nav className="app-nav" aria-label="主要導航"><div className="app-brand">STEAM 陀螺</div><div className="nav-actions"><button aria-current={page === "designer" ? "page" : undefined} onClick={() => setPage("designer")}>設計室</button><button aria-current={page === "lobby" ? "page" : undefined} onClick={() => setPage("lobby")}>對戰大廳</button></div><span className={`connection-status status-${state.status}`} aria-live="polite">{connectionLabel}</span></nav>
    {state.sessionStatus === "resumed" ? <p className="system-banner" role="status">已恢復上次的房間位置。</p> : null}
    {state.sessionStatus === "replaced" ? <p className="system-banner warning" role="status">舊連線已過期，已為你建立新訪客連線。</p> : null}
    {(actionError || state.lastError) ? <div className="system-banner error" role="alert"><span>{actionError ?? state.lastError}</span><button type="button" onClick={() => { setActionError(null); client.dismissError(); }} aria-label="關閉錯誤訊息">關閉</button></div> : null}
    {busy ? <p className="system-banner" role="status">正在處理……</p> : null}
    {page === "designer" ? <DesignerPage onUseDesign={useFromDesigner} /> : null}
    {page === "lobby" ? <LobbyPage rooms={state.lobbyRooms} disabled={busy || state.pendingActions > 0 || state.status !== "online"} onCommand={send} /> : null}
    {page === "room" && state.room ? <RoomPage snapshot={state.room} design={design} designId={designId} departurePending={state.departurePending} actionsDisabled={busy || state.pendingActions > 0 || state.status !== "online"} onUseDesign={ready} onCommand={send} onLeave={() => send({ type: "room.leave", roomId: state.room!.roomId })} reducedMotion={reducedMotion} battle={{
      phase, clockReady: state.clockReady && state.status === "online", clockSamples: state.clockSamples, clockQuality: state.clockQuality, schedule: state.schedule ? { ...state.schedule, serverTargetTimeMs: client.serverToClientTime(state.schedule.serverTargetTimeMs) } : undefined, privateGrade: state.privateGrade ?? undefined,
      spectatorGrades: state.spectatorGrades ?? undefined, started: state.battleStarted ?? undefined,
      frames: state.frames, roundWinner: state.roundFinished?.winner,
      matchFinished: state.matchFinished ?? undefined, cancelledReason: state.cancelledReason ?? undefined,
    }} /> : null}
  </>;
}
