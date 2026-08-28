import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";

const PORT = 4184;
const URL = `http://127.0.0.1:${PORT}`;
const SECRET = "steam-top-load-only";
const deadline = (ms) => Date.now() + ms;
const retryDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(description, check, timeoutMs = 10_000) {
  const until = deadline(timeoutMs);
  let lastError;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error; }
    await retryDelay(25);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

function command(type, fields = {}) {
  return { type, protocolVersion: 1, eventId: randomUUID(), ...fields };
}

function collect(socket, label) {
  const events = [];
  const waiters = [];
  socket.on("server.event", (event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  });
  return {
    events,
    next(predicate, timeoutMs = 10_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`${label} timed out; recent events=${events.slice(-8).map((event) => event.type).join(",")}`));
        }, timeoutMs) };
        waiters.push(waiter);
      });
    },
  };
}

async function connect(name) {
  const socket = io(URL, { transports: ["websocket"], reconnection: false, auth: { displayName: name } });
  const stream = collect(socket, name);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const welcome = stream.next((event) => event.type === "protocol.welcome");
  socket.emit("client.event", { type: "protocol.hello", eventId: randomUUID(), supportedVersions: [1] });
  return { socket, stream, token: (await welcome).sessionToken, name };
}

function design(name, diameterMm) {
  const layer = (position, shape, diameter, color) => ({ id: randomUUID(), position, shape, points: 6, diameterMm: diameter, cornerRoundness: 0.5, rotationDeg: 0, color });
  return {
    id: randomUUID(), name,
    layers: [layer("top", "circle", diameterMm, "#2563eb"), layer("middle", "polygon", 55, "#60a5fa"), layer("bottom", "circle", 48, "#1d4ed8")],
    screwLayout: { count: 4, radiusMm: 15, rotationDeg: 0 }, metalDiscDiameterMm: 0,
  };
}

async function upload(client, body) {
  const response = await fetch(`${URL}/api/designs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${client.token}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`design upload failed: ${response.status} ${await response.text()}`);
  return (await response.json()).designId;
}

async function stats() {
  const response = await fetch(`${URL}/__test/stats`, { headers: { "x-test-secret": SECRET } });
  if (!response.ok) throw new Error(`stats failed: ${response.status}`);
  return response.json();
}

async function tapRound(players, schedule) {
  const waitMs = Math.max(0, schedule.serverTargetTimeMs - Date.now());
  if (waitMs) await retryDelay(waitMs);
  for (const player of players) player.socket.emit("client.event", command("launch.tap", {
    roomId: schedule.roomId, roundId: schedule.roundId, nonce: schedule.nonce, clientTimeMs: Date.now(),
  }));
}

const server = spawn("pnpm", ["--filter", "@steam-top/server", "exec", "tsx", "../../tests/support/realtime-server.ts"], {
  cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", TEST_REALTIME_PORT: String(PORT), TEST_CONTROL_SECRET: SECRET }, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const clients = [];
const startedAt = Date.now();

try {
  await poll("test server health", async () => (await fetch(`${URL}/health`)).ok);
  const baseline = await stats();
  const players = await Promise.all([connect("Load-player-1"), connect("Load-player-2")]);
  clients.push(...players);
  const ownerRoomPromise = players[0].stream.next((event) => event.type === "room.snapshot");
  players[0].socket.emit("client.event", command("room.create", { name: "20 spectators" }));
  const room = await ownerRoomPromise;
  const peerRoom = players[1].stream.next((event) => event.type === "room.snapshot" && event.roomId === room.roomId);
  players[1].socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
  await peerRoom;

  const spectators = await Promise.all(Array.from({ length: 20 }, (_, index) => connect(`Load-spectator-${index + 1}`)));
  clients.push(...spectators);
  await Promise.all(spectators.map(async (spectator) => {
    const joined = spectator.stream.next((event) => event.type === "room.snapshot" && event.roomId === room.roomId);
    spectator.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "spectator" }));
    await joined;
  }));

  const designIds = await Promise.all([upload(players[0], design("Load A", 40)), upload(players[1], design("Load B", 42))]);
  const firstSchedule = spectators[0].stream.next((event) => event.type === "launch.schedule");
  players.forEach((player, index) => player.socket.emit("client.event", command("player.ready", { roomId: room.roomId, designId: designIds[index] })));
  const schedule1 = await firstSchedule;
  await tapRound(players, schedule1);
  const schedule2 = await spectators[0].stream.next((event) => event.type === "launch.schedule" && event.roundId !== schedule1.roundId, 15_000);
  await tapRound(players, schedule2);

  const finalEvents = await Promise.all(clients.map((client) => client.stream.next((event) => event.type === "match.finished", 15_000)));
  const finalFrames = clients.map((client) => client.stream.events.filter((event) => event.type === "battle.frame").at(-1));
  if (finalFrames.some((frame) => !frame)) throw new Error("at least one client missed the reliable final frame");
  const matchIds = new Set([...finalEvents.map((event) => event.matchId), ...finalFrames.map((event) => event.matchId)]);
  const ticks = new Set(finalFrames.map((event) => event.tick));
  if (matchIds.size !== 1 || ticks.size !== 1) throw new Error(`inconsistent clients: matchIds=${[...matchIds]} ticks=${[...ticks]}`);

  const loaded = await stats();
  if (loaded.simulationCount !== 2) throw new Error(`expected 2 simulations, got ${loaded.simulationCount}`);
  if (loaded.frameBroadcastOperations !== 6) throw new Error(`expected 6 frame broadcasts, got ${loaded.frameBroadcastOperations}`);
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 20_000) throw new Error(`load run too slow: ${elapsedMs}ms`);
  if (loaded.heapUsed - baseline.heapUsed > 100 * 1024 * 1024) throw new Error(`heap grew by more than 100 MiB`);

  clients.forEach((client) => client.socket.disconnect());
  const drained = await poll("socket connections and transport handles to drain", async () => {
    const value = await stats();
    return value.connections === 0 && value.activeHandles <= baseline.activeHandles + 10 ? value : false;
  });
  console.info(JSON.stringify({ spectators: 20, players: 2, rounds: loaded.simulationCount, frameBroadcastOperations: loaded.frameBroadcastOperations, finalTick: [...ticks][0], elapsedMs, heapDeltaMiB: Number(((loaded.heapUsed - baseline.heapUsed) / 1024 / 1024).toFixed(2)), drainedConnections: drained.connections }));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  clients.forEach((client) => client.socket.disconnect());
  server.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), retryDelay(3_000)]);
}
