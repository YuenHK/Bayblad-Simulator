export type AdminSession = { username: string; expiresAt: string; csrfToken: string };
export type AdminRoom = { roomId: string; roomCode: string; status: string; players: Array<{ id: string; displayName: string }>; spectators: Array<{ id: string; displayName: string }> };
export type RoomsResponse = { paused: boolean; rooms: AdminRoom[] };
export type { AdminAnalyticsSummary as AnalyticsResponse, AdminRecordsPage as RecordsResponse, AdminRecordRow as RecordRow, AdminLeaderboardPage as LeaderboardResponse } from "@steam-top/protocol";
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
