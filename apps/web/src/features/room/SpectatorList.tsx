import type { Spectator } from "@steam-top/protocol";

const WINDOW_SIZE = 60;
export function SpectatorList({ spectators }: Readonly<{ spectators: readonly Spectator[] }>) {
  const visible = spectators.slice(0, WINDOW_SIZE);
  return (
    <section className="spectator-panel" aria-labelledby="spectator-heading">
      <h3 id="spectator-heading">{spectators.length} 位觀眾</h3>
      <ul className="spectator-list" aria-label="觀眾玩家">
        {visible.map((person) => <li key={person.participantId}>{person.displayName}</li>)}
      </ul>
      {spectators.length > WINDOW_SIZE ? <p className="field-note">為保持順暢，現時顯示前 {WINDOW_SIZE} 位。</p> : null}
    </section>
  );
}
