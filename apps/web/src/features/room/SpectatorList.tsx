import type { Spectator } from "@steam-top/protocol";
import { useState } from "react";

const ROW_HEIGHT = 44;
const VIEWPORT_HEIGHT = 264;
const OVERSCAN = 3;
export function SpectatorList({ spectators }: Readonly<{ spectators: readonly Spectator[] }>) {
  const [scrollTop, setScrollTop] = useState(0);
  const visibleRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT);
  const maximumStart = Math.max(0, spectators.length - visibleRows);
  const start = Math.min(maximumStart, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const end = Math.min(spectators.length, start + visibleRows + OVERSCAN * 2);
  const visible = spectators.slice(start, end);
  return (
    <section className="spectator-panel" aria-labelledby="spectator-heading">
      <h3 id="spectator-heading">{spectators.length} 位觀眾</h3>
      <ul className="spectator-list" aria-label="觀眾玩家" aria-rowcount={spectators.length} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <li aria-hidden="true" className="spectator-spacer" style={{ height: spectators.length * ROW_HEIGHT }} />
        {visible.map((person, offset) => <li key={person.participantId} aria-posinset={start + offset + 1} aria-setsize={spectators.length} style={{ position: "absolute", top: (start + offset) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}>{person.displayName}</li>)}
      </ul>
      {spectators.length > visibleRows ? <p className="field-note">向下捲動可查看全部 {spectators.length} 位觀眾。</p> : null}
    </section>
  );
}
