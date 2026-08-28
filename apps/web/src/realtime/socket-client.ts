import type { TopDesign } from "@steam-top/domain";
import {
  PROTOCOL_VERSION,
  protocolUnsupportedEventSchema,
  serverEventSchema,
  type BattleFrameEvent,
  type BattleStartedEvent,
  type LaunchGrade,
  type LaunchScheduleEvent,
  type LobbyRoom,
  type MatchFinishedEvent,
  type RoomSnapshotEvent,
  type ServerEvent,
  type V1CommandEvent,
} from "@steam-top/protocol";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import { createSafeStorage, type SafeStorage } from "./safe-storage";

export type StorageAdapter = SafeStorage;

export interface RealtimeTransport {
  auth: Record<string, unknown>;
  connected: boolean;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, value: unknown): unknown;
}

type RoundView = Readonly<{ winner: "player1" | "player2" | "draw" }>;
export type ClientClockSample = Readonly<{
  clientSentAtMs: number; serverReceivedAtMs: number; serverSentAtMs: number; clientReceivedAtMs: number;
}>;

export class ClientClockEstimator {
  #samples: ClientClockSample[] = [];
  get sampleCount(): number { return this.#samples.length; }
  get offsetMs(): number {
    if (!this.#samples.length) return 0;
    const values = this.#samples.map((sample) => ((sample.serverReceivedAtMs - sample.clientSentAtMs) + (sample.serverSentAtMs - sample.clientReceivedAtMs)) / 2).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  }
  get rttMs(): number {
    if (!this.#samples.length) return 0;
    const values = this.#samples.map((sample) => sample.clientReceivedAtMs - sample.clientSentAtMs - (sample.serverSentAtMs - sample.serverReceivedAtMs)).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
  }
  add(sample: ClientClockSample): void {
    const rtt = sample.clientReceivedAtMs - sample.clientSentAtMs - (sample.serverSentAtMs - sample.serverReceivedAtMs);
    if (![sample.clientSentAtMs, sample.serverReceivedAtMs, sample.serverSentAtMs, sample.clientReceivedAtMs].every(Number.isSafeInteger) || rtt < 0 || rtt > 400) return;
    this.#samples.push({ ...sample });
    if (this.#samples.length > 9) this.#samples.shift();
  }
  clear(): void { this.#samples = []; }
  serverToClientTime(serverTimeMs: number): number { return serverTimeMs - this.offsetMs; }
}

export type RealtimeState = Readonly<{
  status: "offline" | "connecting" | "online" | "reconnecting";
  sessionStatus: "new" | "resumed" | "replaced" | null;
  lobbyRooms: readonly LobbyRoom[];
  room: RoomSnapshotEvent | null;
  battleStarted: BattleStartedEvent | null;
  schedule: LaunchScheduleEvent | null;
  privateGrade: LaunchGrade | null;
  spectatorGrades: Readonly<{ player1: LaunchGrade; player2: LaunchGrade }> | null;
  frames: readonly BattleFrameEvent[];
  roundFinished: RoundView | null;
  matchFinished: MatchFinishedEvent | null;
  cancelledReason: "attempt-limit" | "server-error" | null;
  attempt: number;
  currentRoundId: string | null;
  departurePending: boolean;
  clockOffsetMs: number;
  clockRttMs: number;
  clockReady: boolean;
  clockSamples: number;
  lastError: string | null;
  pendingActions: number;
}>;

const SESSION_KEY = "steam-top.session-token";
const DESIGN_CACHE_KEY = "steam-top.design-cache";
const designUploadResponseSchema = z.object({ designId: z.uuid() }).strict();
const designCacheSchema = z.object({
  sessionToken: z.string().min(32).max(256), fingerprint: z.string(), designId: z.uuid(),
}).strict();
const initialState: RealtimeState = {
  status: "offline", sessionStatus: null, lobbyRooms: [], room: null,
  battleStarted: null, schedule: null, privateGrade: null, spectatorGrades: null,
  frames: [], roundFinished: null, matchFinished: null, cancelledReason: null,
  attempt: 0, currentRoundId: null, departurePending: false,
  clockOffsetMs: 0, clockRttMs: 0, clockReady: false, clockSamples: 0,
  lastError: null,
  pendingActions: 0,
};

function defaultStorage(): StorageAdapter {
  let candidate: Storage | null = null;
  try { candidate = localStorage; } catch { /* unavailable */ }
  return createSafeStorage(candidate);
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("操作已取消", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("操作已取消", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function updateRoomFromDelta(room: RoomSnapshotEvent, event: Extract<ReturnType<typeof serverEventSchema.parse>, { type: "room.delta" }>): RoomSnapshotEvent | null {
  if (room.roomId !== event.roomId || room.revision !== event.baseRevision) return null;
  const left = new Set(event.leftParticipantIds);
  let spectators = room.spectators.filter(({ participantId }) => !left.has(participantId));
  for (const person of event.joined) {
    if (!spectators.some(({ participantId }) => participantId === person.participantId)) spectators = [...spectators, person];
  }
  const next = {
    ...room, ...event.patch, spectators, revision: event.revision,
    serverEventId: event.serverEventId,
  };
  const id = room.viewer.participantId;
  const role = next.player1?.participantId === id ? "player1" : next.player2?.participantId === id ? "player2" : "spectator";
  return { ...next, viewer: { participantId: id, role, isOwner: next.ownerParticipantId === id } } as RoomSnapshotEvent;
}

export type CommandInput =
  | Readonly<{ type: "room.create"; name: string }>
  | Readonly<{ type: "room.join"; roomId: string; role: "player" | "spectator" }>
  | Readonly<{ type: "room.move"; roomId: string; target: "player1" | "player2" | "spectator"; subjectParticipantId?: string }>
  | Readonly<{ type: "player.ready"; roomId: string; designId: string }>
  | Readonly<{ type: "launch.tap"; roomId: string; roundId: string; nonce: string; clientTimeMs: number }>
  | Readonly<{ type: "room.leave"; roomId: string }>
  | Readonly<{ type: "room.close"; roomId: string }>;

export class RealtimeClient {
  readonly #transport: RealtimeTransport;
  readonly #storage: StorageAdapter;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #clock = new ClientClockEstimator();
  readonly #listeners = new Set<() => void>();
  readonly #bound = new Map<string, (...args: unknown[]) => void>();
  readonly #pendingPings = new Map<string, number>();
  readonly #seenServerEvents = new Set<string>();
  readonly #seenRoundIds = new Set<string>();
  readonly #pendingActions = new Map<string, Readonly<{ timer: ReturnType<typeof setTimeout>; commandType: CommandInput["type"] }>>();
  readonly #actionWaiters = new Map<string, Readonly<{ commandType: CommandInput["type"]; resolve(): void; reject(error: Error & { code?: string }): void }>>();
  #state: RealtimeState = initialState;
  #token: string | null;
  #started = false;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #pendingDepartureEventId: string | null = null;
  #lastErrorEventId: string | null = null;

  constructor(options: Readonly<{ transport: RealtimeTransport; storage?: StorageAdapter; apiBase?: string; fetcher?: typeof fetch; now?: () => number }>) {
    this.#transport = options.transport;
    this.#storage = options.storage ?? defaultStorage();
    this.#apiBase = (options.apiBase ?? "").replace(/\/$/u, "");
    this.#fetch = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#token = this.#storage.get(SESSION_KEY);
    this.#transport.auth.sessionToken = this.#token ?? undefined;
  }

  getState = (): RealtimeState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#listen("connect", () => {
      this.#resetClock();
      this.#set({ status: "connecting", lastError: null });
      this.#transport.emit("client.event", { type: "protocol.hello", eventId: crypto.randomUUID(), supportedVersions: [PROTOCOL_VERSION] });
    });
    this.#listen("disconnect", () => this.#set({ status: "reconnecting" }));
    this.#listen("connect_error", () => this.#set({ status: "reconnecting", lastError: "連線失敗，正在重試。" }));
    this.#listen("server.event", (raw) => this.#receive(raw));
    this.#set({ status: "connecting" });
    this.#transport.connect();
  }

  stop(): void {
    if (!this.#started) return;
    for (const [event, listener] of this.#bound) this.#transport.off(event, listener);
    this.#bound.clear();
    this.#transport.disconnect();
    if (this.#clockTimer) clearInterval(this.#clockTimer);
    this.#clearPendingActions(true);
    this.#pendingDepartureEventId = null;
    this.#clockTimer = null;
    this.#started = false;
    this.#set({ status: "offline", departurePending: false });
  }

  command(input: CommandInput): string {
    if (this.#state.status !== "online" || !this.#transport.connected) throw new Error("目前離線，請重新連線後再試。");
    const eventId = crypto.randomUUID();
    this.#transport.emit("client.event", { ...input, protocolVersion: PROTOCOL_VERSION, eventId } satisfies V1CommandEvent);
    if (input.type === "room.leave" || input.type === "room.close") {
      this.#pendingDepartureEventId = eventId;
      this.#set({ departurePending: true, lastError: null });
    }
    const timer = setTimeout(() => { this.#pendingActions.delete(eventId); this.#actionWaiters.get(eventId)?.reject(new Error("操作逾時，請重試。")); this.#actionWaiters.delete(eventId); this.#lastErrorEventId = eventId; this.#set({ pendingActions: this.#pendingActions.size, lastError: "操作逾時，請重試。" }); }, 8_000);
    this.#pendingActions.set(eventId, { timer, commandType: input.type });
    this.#set({ pendingActions: this.#pendingActions.size });
    return eventId;
  }

  async uploadDesign(design: TopDesign, externalSignal?: AbortSignal): Promise<string> {
    if (!this.#token) throw new Error("尚未連線，請稍後再試。");
    const requestToken = this.#token;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new DOMException("上載設計逾時", "TimeoutError")); }, 10_000);
    const abort = () => controller.abort(externalSignal?.reason ?? new DOMException("操作已取消", "AbortError"));
    if (externalSignal?.aborted) abort(); else externalSignal?.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await awaitWithAbort(this.#fetch(`${this.#apiBase}/api/designs`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${requestToken}` }, body: JSON.stringify(design), signal: controller.signal,
        }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error("未能連接設計伺服器，請重試。");
      }
      let raw: unknown;
      try { raw = await awaitWithAbort(response.json() as Promise<unknown>, controller.signal); }
      catch (error) { if (controller.signal.aborted) throw error; throw new Error("伺服器回應格式錯誤，請重試。"); }
      if (!response.ok) throw new Error(`上載設計失敗（HTTP ${response.status}）。`);
      const parsed = designUploadResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error("伺服器回應格式錯誤，請重試。");
      if (this.#token !== requestToken) throw new DOMException("連線已更新", "AbortError");
      this.#storage.set(DESIGN_CACHE_KEY, JSON.stringify({ sessionToken: requestToken, fingerprint: JSON.stringify(design), designId: parsed.data.designId }));
      return parsed.data.designId;
    } catch (error) {
      if (timedOut) throw new Error("上載設計逾時，請重試。");
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new DOMException("操作已取消", "AbortError");
      throw error;
    } finally {
      clearTimeout(timeout); externalSignal?.removeEventListener("abort", abort);
    }
  }

  serverToClientTime(serverTimeMs: number): number { return this.#clock.serverToClientTime(serverTimeMs); }

  #listen(event: string, listener: (...args: unknown[]) => void): void { this.#bound.set(event, listener); this.#transport.on(event, listener); }
  #set(patch: Partial<RealtimeState>): void { this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener(); }
  #receive(raw: unknown): void {
    const parsed = serverEventSchema.safeParse(raw);
    if (!parsed.success) {
      const unsupported = protocolUnsupportedEventSchema.safeParse(raw);
      this.#set({ lastError: unsupported.success ? unsupported.data.reason : "伺服器資料格式無效，已安全忽略。" });
      return;
    }
    const event = parsed.data;
    if (this.#seenServerEvents.has(event.serverEventId)) {
      if (event.type === "room.departed") this.#ackDeparture(event.departureId);
      return;
    }
    this.#seenServerEvents.add(event.serverEventId);
    if (this.#seenServerEvents.size > 1_024) this.#seenServerEvents.delete(this.#seenServerEvents.values().next().value!);
    switch (event.type) {
      case "protocol.welcome":
        if (event.sessionToken) { this.#token = event.sessionToken; this.#storage.set(SESSION_KEY, event.sessionToken); this.#transport.auth.sessionToken = event.sessionToken; }
        if ((event.sessionStatus ?? "new") !== "resumed") { this.#storage.remove(DESIGN_CACHE_KEY); this.#clearAllServerState(); }
        this.#set({ status: "online", sessionStatus: event.sessionStatus ?? "new", lastError: null });
        this.#sendClockPing();
        if (this.#clockTimer) clearInterval(this.#clockTimer);
        this.#clockTimer = setInterval(() => this.#sendClockPing(), 15_000);
        break;
      case "lobby.snapshot": this.#set({ lobbyRooms: event.rooms }); break;
      case "room.snapshot": {
        const changedRoom = this.#state.room !== null && this.#state.room.roomId !== event.roomId;
        this.#set({ room: event, departurePending: false, ...(changedRoom ? this.#clearedBattleState() : {}) }); break;
      }
      case "room.delta": {
        if (!this.#state.room || event.roomId !== this.#state.room.roomId) break;
        const room = updateRoomFromDelta(this.#state.room, event);
        this.#set(room ? { room } : { lastError: "房間資料需要同步，請重新進入。" }); break;
      }
      case "battle.started":
        if (event.roomId !== this.#state.room?.roomId) break;
        if (this.#state.battleStarted && this.#state.battleStarted.matchId !== event.matchId && !this.#state.matchFinished && !this.#state.cancelledReason) break;
        if (this.#state.battleStarted?.matchId !== event.matchId) this.#seenRoundIds.clear();
        this.#set({ battleStarted: event, attempt: 0, currentRoundId: null, frames: [], roundFinished: null, matchFinished: null, cancelledReason: null }); break;
      case "battle.checkpoint": {
        if (!this.#sameMatch(event) || event.attempt < this.#state.attempt) break;
        if (event.attempt === this.#state.attempt && this.#state.currentRoundId && event.roundId !== this.#state.currentRoundId) break;
        const newer = event.attempt > this.#state.attempt || this.#state.currentRoundId === null;
        this.#seenRoundIds.add(event.roundId);
        this.#set({ attempt: event.attempt, currentRoundId: event.roundId, ...(newer ? { frames: [], roundFinished: null } : {}) }); break;
      }
      case "launch.schedule": {
        if (!this.#sameMatch(event)) break;
        const changedRound = this.#state.currentRoundId !== null && event.roundId !== this.#state.currentRoundId;
        if (changedRound && this.#seenRoundIds.has(event.roundId)) break;
        const attempt = this.#state.currentRoundId === null ? Math.max(1, this.#state.attempt) : changedRound ? this.#state.attempt + 1 : this.#state.attempt;
        this.#seenRoundIds.add(event.roundId);
        this.#set({ schedule: event, attempt, currentRoundId: event.roundId, privateGrade: null, spectatorGrades: null, frames: [], roundFinished: null }); break;
      }
      case "launch.result.private": if (this.#sameRound(event)) this.#set({ privateGrade: event.grade }); break;
      case "launch.result.spectator": if (this.#sameRound(event)) this.#set({ spectatorGrades: { player1: event.player1.grade, player2: event.player2.grade } }); break;
      case "battle.frame": {
        if (!this.#sameRound(event) || event.sequence <= (this.#state.frames.at(-1)?.sequence ?? -1)) break;
        this.#set({ frames: [...this.#state.frames.slice(-29), event] }); break;
      }
      case "round.finished": if (this.#sameRound(event)) this.#set({ roundFinished: { winner: event.winner } }); break;
      case "match.finished": if (this.#sameMatch(event)) this.#set({ matchFinished: event, schedule: null }); break;
      case "match.cancelled": if (this.#sameMatch(event)) this.#set({ cancelledReason: event.reason, schedule: null }); break;
      case "room.departed":
        if (this.#pendingDepartureEventId) {
          this.#actionWaiters.get(this.#pendingDepartureEventId)?.resolve();
          this.#actionWaiters.delete(this.#pendingDepartureEventId);
          this.#clearPendingAction(this.#pendingDepartureEventId);
        }
        if (event.roomId === this.#state.room?.roomId) {
          this.#pendingDepartureEventId = null;
          this.#set({ room: null, departurePending: false, ...this.#clearedBattleState() });
        }
        this.#ackDeparture(event.departureId);
        break;
      case "clock.pong": this.#acceptClockPong(event); break;
      case "error":
        if (event.causedByEventId) { const waiter = this.#actionWaiters.get(event.causedByEventId); const error = Object.assign(new Error(event.message), { code: event.code }); waiter?.reject(error); this.#actionWaiters.delete(event.causedByEventId); this.#clearPendingAction(event.causedByEventId); this.#lastErrorEventId = event.causedByEventId; }
        if (event.causedByEventId && event.causedByEventId === this.#pendingDepartureEventId) {
          this.#pendingDepartureEventId = null;
          this.#set({ departurePending: false, lastError: event.message });
        } else { this.#lastErrorEventId = event.causedByEventId ?? null; this.#set({ lastError: event.message }); }
        break;
      case "command.ack": {
        const pending = this.#pendingActions.get(event.causedByEventId);
        if (!pending || pending.commandType !== event.commandType) break;
        const waiter = this.#actionWaiters.get(event.causedByEventId);
        if (waiter?.commandType === event.commandType) waiter.resolve();
        this.#actionWaiters.delete(event.causedByEventId);
        this.#clearPendingAction(event.causedByEventId);
        if (this.#lastErrorEventId === event.causedByEventId) { this.#lastErrorEventId = null; this.#set({ lastError: null }); }
        break;
      }
    }
  }

  #sameMatch(event: Readonly<{ roomId: string; matchId: string }>): boolean {
    return event.roomId === this.#state.room?.roomId && event.matchId === this.#state.battleStarted?.matchId;
  }
  #sameRound(event: Readonly<{ roomId: string; matchId: string; roundId: string }>): boolean {
    return this.#sameMatch(event) && event.roundId === this.#state.currentRoundId;
  }
  #resetClock(): void {
    this.#clock.clear(); this.#pendingPings.clear();
    this.#set({ clockOffsetMs: 0, clockRttMs: 0, clockReady: false, clockSamples: 0 });
  }
  #sendClockPing(): void {
    if (this.#state.status !== "online") return;
    const pingId = crypto.randomUUID();
    const clientSentAtMs = this.#now();
    this.#pendingPings.set(pingId, clientSentAtMs);
    this.#transport.emit("client.event", {
      type: "clock.ping", pingId, clientSentAtMs,
      protocolVersion: PROTOCOL_VERSION, eventId: crypto.randomUUID(),
    } satisfies V1CommandEvent);
  }
  #acceptClockPong(event: Extract<ServerEvent, { type: "clock.pong" }>): void {
    const sent = this.#pendingPings.get(event.pingId);
    if (sent === undefined || sent !== event.clientSentAtMs) return;
    this.#pendingPings.delete(event.pingId);
    const sample = { clientSentAtMs: sent, serverReceivedAtMs: event.serverReceiveTimeMs, serverSentAtMs: event.serverSendTimeMs, clientReceivedAtMs: this.#now() };
    this.#clock.add(sample);
    this.#transport.emit("client.event", { type: "clock.ack", pingId: event.pingId, protocolVersion: PROTOCOL_VERSION, eventId: crypto.randomUUID() } satisfies V1CommandEvent);
    this.#set({ clockOffsetMs: this.#clock.offsetMs, clockRttMs: this.#clock.rttMs, clockReady: this.#clock.sampleCount >= 3, clockSamples: this.#clock.sampleCount });
    if (this.#clock.sampleCount < 3) this.#sendClockPing();
  }

  #clearedBattleState(): Pick<RealtimeState, "battleStarted" | "schedule" | "privateGrade" | "spectatorGrades" | "frames" | "roundFinished" | "matchFinished" | "cancelledReason" | "attempt" | "currentRoundId"> {
    this.#seenRoundIds.clear();
    return { battleStarted: null, schedule: null, privateGrade: null, spectatorGrades: null, frames: [], roundFinished: null, matchFinished: null, cancelledReason: null, attempt: 0, currentRoundId: null };
  }
  #ackDeparture(departureId: string): void {
    this.#transport.emit("client.event", { type: "room.departed.ack", departureId, protocolVersion: PROTOCOL_VERSION, eventId: crypto.randomUUID() } satisfies V1CommandEvent);
  }
  #clearPendingAction(eventId: string): void { const pending = this.#pendingActions.get(eventId); if (pending) clearTimeout(pending.timer); this.#pendingActions.delete(eventId); this.#set({ pendingActions: this.#pendingActions.size }); }
  #clearPendingActions(reject = false): void { for (const pending of this.#pendingActions.values()) clearTimeout(pending.timer); for (const waiter of this.#actionWaiters.values()) reject ? waiter.reject(new Error("操作已由最新伺服器狀態取代。")) : waiter.resolve(); this.#actionWaiters.clear(); this.#pendingActions.clear(); this.#set({ pendingActions: 0 }); }
  #clearAllServerState(): void {
    this.#seenServerEvents.clear(); this.#seenRoundIds.clear(); this.#pendingDepartureEventId = null; this.#lastErrorEventId = null; this.#clearPendingActions(true);
    this.#set({ room: null, lobbyRooms: [], departurePending: false, ...this.#clearedBattleState() });
  }

  commandAsync(input: CommandInput): Promise<void> {
    const eventId = this.command(input);
    return new Promise<void>((resolve, reject) => this.#actionWaiters.set(eventId, { commandType: input.type, resolve, reject }));
  }

  dismissError(): void { this.#lastErrorEventId = null; this.#set({ lastError: null }); }

  async readyWithDesign(roomId: string, design: TopDesign, signal?: AbortSignal): Promise<string> {
    if (!this.#token) throw new Error("尚未連線，請稍後再試。");
    const sessionToken = this.#token;
    const fingerprint = JSON.stringify(design);
    let cached: z.infer<typeof designCacheSchema> | null = null;
    const rawCache = this.#storage.get(DESIGN_CACHE_KEY);
    if (rawCache !== null) {
      try {
        const parsed = designCacheSchema.safeParse(JSON.parse(rawCache));
        if (parsed.success) cached = parsed.data; else this.#storage.remove(DESIGN_CACHE_KEY);
      } catch { this.#storage.remove(DESIGN_CACHE_KEY); }
    }
    let designId = cached?.sessionToken === sessionToken && cached.fingerprint === fingerprint ? cached.designId : await this.uploadDesign(design, signal);
    const ensureCurrentSession = () => { if (signal?.aborted || this.#token !== sessionToken) throw new DOMException("操作已取消", "AbortError"); };
    const save = () => this.#storage.set(DESIGN_CACHE_KEY, JSON.stringify({ sessionToken, fingerprint, designId }));
    ensureCurrentSession();
    save();
    try { await this.commandAsync({ type: "player.ready", roomId, designId }); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "DESIGN_NOT_FOUND" && code !== "DESIGN_NOT_OWNED") throw error;
      this.#storage.remove(DESIGN_CACHE_KEY);
      designId = await this.uploadDesign(design, signal); ensureCurrentSession(); save();
      await this.commandAsync({ type: "player.ready", roomId, designId });
    }
    return designId;
  }
}

export function createRealtimeClient(apiBase = import.meta.env.VITE_API_BASE_URL ?? window.location.origin): RealtimeClient {
  const storage = defaultStorage();
  const token = storage.get(SESSION_KEY);
  const guest = `訪客-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const socket: Socket = io(apiBase, {
    autoConnect: false, reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 8_000,
    randomizationFactor: 0.25, auth: { displayName: guest, sessionToken: token ?? undefined },
  });
  return new RealtimeClient({ transport: socket as unknown as RealtimeTransport, apiBase, storage });
}
