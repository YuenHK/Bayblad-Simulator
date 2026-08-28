import type { Spectator } from "@steam-top/protocol";
import { useState } from "react";

const PAGE_SIZE = 50;
export function SpectatorList({ spectators }: Readonly<{ spectators: readonly Spectator[] }>) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(spectators.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = spectators.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  return (
    <section className="spectator-panel" aria-labelledby="spectator-heading">
      <h3 id="spectator-heading">{spectators.length} 位觀眾</h3>
      <ul className="spectator-list" aria-label={`觀眾玩家，共 ${spectators.length} 人`}>{visible.map((person) => <li key={person.participantId}>{person.displayName}</li>)}</ul>
      {pageCount > 1 ? <nav aria-label="觀眾分頁"><button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一頁</button><span>第 {safePage + 1} / {pageCount} 頁</span><button disabled={safePage + 1 >= pageCount} onClick={() => setPage(safePage + 1)}>下一頁</button></nav> : null}
    </section>
  );
}
