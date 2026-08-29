import type { LobbyRoom } from "@steam-top/protocol";
import { useState } from "react";
import type { CommandInput } from "../../realtime/socket-client";

const PHASE_LABEL = {
  waiting: "等待中",
  launch: "發射中",
  battle: "對戰中",
  result: "已完成",
} as const;
export function LobbyPage({
  rooms,
  onCommand,
  disabled = false,
}: Readonly<{
  rooms: readonly LobbyRoom[];
  onCommand: (event: CommandInput) => void;
  disabled?: boolean;
}>) {
  const [roomName, setRoomName] = useState("我的陀螺房");
  const [code, setCode] = useState("");
  const [role, setRole] = useState<"player" | "spectator">("player");
  const [page, setPage] = useState(0);
  const pageSize = 50,
    pageCount = Math.max(1, Math.ceil(rooms.length / pageSize)),
    safePage = Math.min(page, pageCount - 1);
  const visibleRooms = rooms.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  return (
    <main className="app-shell">
      <header className="page-heading">
        <p className="eyebrow">STEAM 陀螺</p>
        <h1>對戰大廳</h1>
        <p>建立兩人房間，或進入房間參戰與觀賽。</p>
      </header>
      <fieldset
        disabled={disabled}
        className="panel lobby-actions"
        aria-label="建立或進入房間"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onCommand({
              type: "room.create",
              name: roomName.trim() || "我的陀螺房",
            });
          }}
        >
          <label>
            房間名稱
            <input
              value={roomName}
              maxLength={30}
              onChange={(event) => setRoomName(event.currentTarget.value)}
            />
          </label>
          <button className="primary-button" type="submit">
            建立房間
          </button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim())
              onCommand({ type: "room.join", roomId: code.trim(), role });
          }}
        >
          <label>
            房間碼
            <input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              autoCapitalize="characters"
            />
          </label>
          <label>
            進入身份
            <select
              value={role}
              onChange={(event) =>
                setRole(event.currentTarget.value as typeof role)
              }
            >
              <option value="player">對戰玩家</option>
              <option value="spectator">觀賽玩家</option>
            </select>
          </label>
          <button type="submit">以房間碼進入</button>
        </form>
      </fieldset>
      <section aria-labelledby="all-rooms">
        <h2 id="all-rooms">全部房間</h2>
        {rooms.length === 0 ? (
          <p className="empty-state">現時未有房間，可以建立第一間。</p>
        ) : (
          <>
            <div className="room-grid">
              {visibleRooms.map((room) => (
                <article className="room-card" key={room.id}>
                  <div>
                    <span className={`phase-chip phase-${room.phase}`}>
                      {PHASE_LABEL[room.phase]}
                    </span>
                    <h3>{room.name}</h3>
                    <p className="room-code">
                      房間碼：<strong>{room.code}</strong>
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>玩家一</dt>
                      <dd>{room.player1.displayName ?? "空位"}</dd>
                    </div>
                    <div>
                      <dt>玩家二</dt>
                      <dd>{room.player2.displayName ?? "空位"}</dd>
                    </div>
                    <div>
                      <dt>觀眾</dt>
                      <dd>{room.spectatorCount} 人</dd>
                    </div>
                  </dl>
                  <div className="room-card-actions">
                    <button
                      onClick={() =>
                        onCommand({
                          type: "room.join",
                          roomId: room.id,
                          role: "player",
                        })
                      }
                      disabled={
                        disabled ||
                        room.phase !== "waiting" ||
                        Boolean(
                          room.player1.displayName && room.player2.displayName,
                        )
                      }
                    >
                      參戰
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        onCommand({
                          type: "room.join",
                          roomId: room.id,
                          role: "spectator",
                        })
                      }
                    >
                      觀賽
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <nav aria-label="房間分頁">
              <button
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                上一頁
              </button>
              <span>
                第 {safePage + 1} / {pageCount} 頁
              </span>
              <button
                disabled={safePage + 1 >= pageCount}
                onClick={() => setPage(safePage + 1)}
              >
                下一頁
              </button>
              <button
                disabled={safePage + 1 >= pageCount}
                onClick={() => setPage(pageCount - 1)}
              >
                最後一頁
              </button>
            </nav>
          </>
        )}
      </section>
    </main>
  );
}
