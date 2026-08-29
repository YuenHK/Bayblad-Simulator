import type { DatabaseClient } from "@steam-top/db";

export interface PlatformSettingsStore {
  readPaused(): Promise<boolean>;
  writePaused(paused: boolean): Promise<void>;
}

export class InMemoryPlatformSettingsStore implements PlatformSettingsStore {
  constructor(private paused = false) {}
  async readPaused() { return this.paused; }
  async writePaused(paused: boolean) { this.paused = paused; }
}

export class PostgresPlatformSettingsStore implements PlatformSettingsStore {
  constructor(private readonly client: DatabaseClient) {}
  async readPaused() {
    const rows = await this.client.sql.unsafe("select paused from platform_settings where singleton=true") as readonly Record<string, unknown>[];
    return rows[0]?.paused === true;
  }
  async writePaused(paused: boolean) {
    await this.client.sql.unsafe("insert into platform_settings(singleton,paused,updated_at) values(true,$1,now()) on conflict(singleton) do update set paused=excluded.paused,updated_at=excluded.updated_at", [paused]);
  }
}
