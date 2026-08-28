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
  type V1CommandEvent,
} from "@steam-top/protocol";
import { io, type Socket } from "socket.io-client";

export type StorageAdapter = Readonly<{
  get(key: string): string | null;
  set(key: string, value: string): void;
}>;

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
  lastError: string | null;
}>;

const SESSION_KEY = "steam-top.session-token";
const initialState: RealtimeState = {
  status: "offline", sessionStatus: null, lobbyRooms: [], room: null,
  battleStarted: null, schedule: null, privateGrade: null, spectatorGrades: null,
  frames: [], roundFinished: null, matchFinished: null, cancelledReason: null,
  lastError: null,
};

function defaultStorage(): StorageAdapter {
  return { get: (key) => localStorage.getItem(key), set: (key, value) => localStorage.setItem(key, value) };
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
  readonly #listeners = new Set<() => void>();
  readonly #bound = new Map<string, (...args: unknown[]) => void>();
  #state: RealtimeState = initialState;
  #token: string | null;
  #started = false;

  constructor(options: Readonly<{ transport: RealtimeTransport; storage?: StorageAdapter; apiBase?: string; fetcher?: typeof fetch }>) {
    this.#transport = options.transport;
    this.#storage = options.storage ?? defaultStorage();
    this.#apiBase = (options.apiBase ?? "").replace(/\/$/u, "");
    this.#fetch = options.fetcher ?? fetch;
    this.#token = this.#storage.get(SESSION_KEY);
    this.#transport.auth.sessionToken = this.#token ?? undefined;
  }

  getState = (): RealtimeState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#listen("connect", () => {
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
    this.#started = false;
    this.#set({ status: "offline" });
  }

  command(input: CommandInput): string {
    const eventId = crypto.randomUUID();
    this.#transport.emit("client.event", { ...input, protocolVersion: PROTOCOL_VERSION, eventId } satisfies V1CommandEvent);
    return eventId;
  }

  async uploadDesign(design: TopDesign): Promise<string> {
    if (!this.#token) throw new Error("尚未連線，請稍後再試。");
    const response = await this.#fetch(`${this.#apiBase}/api/designs`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` }, body: JSON.stringify(design),
    });
    const payload = await response.json() as { designId?: string; error?: string };
    if (!response.ok || !payload.designId) throw new Error(payload.error ?? "上載設計失敗。");
    return payload.designId;
  }

  clearRoom(): void { this.#set({ room: null, battleStarted: null, schedule: null, frames: [], matchFinished: null, cancelledReason: null }); }

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
    switch (event.type) {
      case "protocol.welcome":
        if (event.sessionToken) { this.#token = event.sessionToken; this.#storage.set(SESSION_KEY, event.sessionToken); this.#transport.auth.sessionToken = event.sessionToken; }
        this.#set({ status: "online", sessionStatus: event.sessionStatus ?? "new", lastError: null }); break;
      case "lobby.snapshot": this.#set({ lobbyRooms: event.rooms }); break;
      case "room.snapshot": this.#set({ room: event }); break;
      case "room.delta": {
        if (!this.#state.room) break;
        const room = updateRoomFromDelta(this.#state.room, event);
        this.#set(room ? { room } : { lastError: "房間資料需要同步，請重新進入。" }); break;
      }
      case "battle.started": this.#set({ battleStarted: event, frames: [], roundFinished: null, matchFinished: null, cancelledReason: null }); break;
      case "launch.schedule": this.#set({ schedule: event, privateGrade: null, spectatorGrades: null, frames: [], roundFinished: null }); break;
      case "launch.result.private": this.#set({ privateGrade: event.grade }); break;
      case "launch.result.spectator": this.#set({ spectatorGrades: { player1: event.player1.grade, player2: event.player2.grade } }); break;
      case "battle.frame": this.#set({ frames: [...this.#state.frames.slice(-29), event] }); break;
      case "round.finished": this.#set({ roundFinished: { winner: event.winner } }); break;
      case "match.finished": this.#set({ matchFinished: event, schedule: null }); break;
      case "match.cancelled": this.#set({ cancelledReason: event.reason, schedule: null }); break;
      case "error": this.#set({ lastError: event.message }); break;
      case "battle.checkpoint":
      case "command.ack": break;
    }
  }
}

export function createRealtimeClient(apiBase = import.meta.env.VITE_API_BASE_URL ?? window.location.origin): RealtimeClient {
  const token = localStorage.getItem(SESSION_KEY);
  const guest = `訪客-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const socket: Socket = io(apiBase, {
    autoConnect: false, reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 8_000,
    randomizationFactor: 0.25, auth: { displayName: guest, sessionToken: token ?? undefined },
  });
  return new RealtimeClient({ transport: socket as unknown as RealtimeTransport, apiBase });
}
