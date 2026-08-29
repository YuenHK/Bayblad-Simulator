export type AdminSession = { username: string; expiresAt: string; csrfToken: string };
export type AdminRoom = { roomId: string; roomCode: string; status: string; players: Array<{ id: string; displayName: string }>; spectators: Array<{ id: string; displayName: string }> };
export type RoomsResponse = { paused: boolean; rooms: AdminRoom[] };
export type RecordRow = { id: string; occurredAt: string; className?: string; identity: string; deviceName?: string; parameters: string; totalScore: number };
export type RecordsResponse = { rows: RecordRow[]; total: number; page: number; pageSize: number };
export type AnalyticsResponse = { usagePeriods: Record<"daily" | "weekly" | "monthly", Array<Record<string, string | number>>>; parameterUsage: Array<Record<string, string | number>>; rankings: { top: Array<Record<string, string | number>>; bottom: Array<Record<string, string | number>>; overallLaunchDistribution: Record<string, number> }; refreshedAt: string };
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
