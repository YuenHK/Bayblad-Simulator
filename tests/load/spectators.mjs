import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { stopChildCleanly } from "./child-process.mjs";

const SECRET = "steam-top-load-only", CYCLES = Number(process.env.LOAD_CYCLES ?? 3);
const MAX_MS = Number(process.env.LOAD_MAX_SCENARIO_MS ?? 60_000);
const HEAP_SPAN = Number(process.env.LOAD_MAX_STEADY_HEAP_SPAN_MIB ?? 24) * 1024 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cmd = (type, fields = {}) => ({ type, protocolVersion: 1, eventId: randomUUID(), ...fields });

async function poll(label, fn, timeout = 15_000) {
  const end = Date.now() + timeout; let error;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (cause) { error = cause; } await delay(25); }
  throw new Error(`Timed out: ${label}${error ? `: ${error}` : ""}`);
}
function collector(socket, label) {
  const events = [], waiters = [];
  socket.on("server.event", (event) => { events.push(event); for (const waiter of [...waiters]) if (waiter.test(event)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(event); } });
  return { events, next(test, timeout = 60_000) { const old = events.find(test); if (old) return Promise.resolve(old); return new Promise((resolve, reject) => { const waiter = { test, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`${label} timeout; recent=${events.slice(-10).map((e) => e.type)}`)); }, timeout) }; waiters.push(waiter); }); } };
}
async function startServer() {
  const child = spawn("pnpm", ["--filter", "@steam-top/server", "exec", "node", "--expose-gc", "--import", "tsx", "../../tests/support/realtime-server.ts"], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", BATTLE_ENGINE: "real", TEST_REALTIME_PORT: "0", TEST_CONTROL_SECRET: SECRET }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", buffer = "", resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error(`ready timeout\n${output}`)), 15_000);
  child.stdout.on("data", (chunk) => { const text = String(chunk); output += text; buffer += text; for (;;) { const at = buffer.indexOf("\n"); if (at < 0) break; const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); try { const parsed = JSON.parse(line); if (parsed.type === "ready") { clearTimeout(timer); resolveReady(parsed); } } catch {} } });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.once("exit", (code, signal) => { if (code !== 0) rejectReady(new Error(`early exit ${code}/${signal}\n${output}`)); });
  const info = await ready; return { child, url: info.url, output: () => output };
}
async function stopServer(server) {
  await stopChildCleanly(server.child, {
    requestGraceful: async () => (await fetch(`${server.url}/__test/shutdown`, { method: "POST", headers: { "x-test-secret": SECRET } })).ok,
    timeoutMs: 5_000,
    diagnostics: server.output,
  });
}
async function connect(url, name) {
  const socket = io(url, { transports: ["websocket"], reconnection: false, auth: { displayName: name } }), stream = collector(socket, name);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const welcome = stream.next((e) => e.type === "protocol.welcome"); socket.emit("client.event", { type: "protocol.hello", eventId: randomUUID(), supportedVersions: [1] });
  return { socket, stream, token: (await welcome).sessionToken, name };
}
function design(name, attack) {
  const layer = (position, shape, diameterMm, color, points = 6) => ({ id: randomUUID(), position, shape, points, diameterMm, cornerRoundness: 0.5, rotationDeg: 0, color });
  return attack ? { id: randomUUID(), name, layers: [layer("top", "star", 48, "#2563eb", 8), layer("middle", "polygon", 60, "#60a5fa"), layer("bottom", "circle", 52, "#1d4ed8")], screwLayout: { count: 4, radiusMm: 15, rotationDeg: 0 }, metalDiscDiameterMm: 40 } : { id: randomUUID(), name, layers: [layer("top", "circle", 32, "#e34d59"), layer("middle", "circle", 40, "#f59e0b"), layer("bottom", "circle", 42, "#b45309")], screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 }, metalDiscDiameterMm: 0 };
}
async function control(url, path, data) { const response = await fetch(`${url}${path}`, { method: data ? "POST" : "GET", headers: { "x-test-secret": SECRET, ...(data ? { "content-type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); }
const stats = (url, gc = false) => control(url, `/__test/stats${gc ? "?gc=1" : ""}`);
async function upload(url, client, body) { const response = await fetch(`${url}/api/designs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${client.token}` }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`upload ${response.status}: ${await response.text()}`); return (await response.json()).designId; }
async function advanceTo(url, target) { const current = await stats(url); await control(url, "/__test/advance", { ms: Math.max(0, Math.ceil(target - current.nowMs)) }); }

async function cycle(url, clients, players, index) {
  const before = await stats(url), roomP = players[0].stream.next((e) => e.type === "room.snapshot" && e.name === `Load cycle ${index}`);
  players[0].socket.emit("client.event", cmd("room.create", { name: `Load cycle ${index}` })); const room = await roomP;
  await Promise.all(clients.slice(1).map((client, i) => { const joined = client.stream.next((e) => e.type === "room.snapshot" && e.roomId === room.roomId); client.socket.emit("client.event", cmd("room.join", { roomId: room.roomId, role: i === 0 ? "player" : "spectator" })); return joined; }));
  const ids = await Promise.all(players.map((player, i) => upload(url, player, design(`${index}-${i}`, i === 0))));
  players.forEach((player, i) => player.socket.emit("client.event", cmd("player.ready", { roomId: room.roomId, designId: ids[i] })));
  const seen = new Set(); let finished;
  for (;;) {
    const event = await players[0].stream.next((e) => e.roomId === room.roomId && (e.type === "match.finished" || e.type === "match.cancelled" || (e.type === "launch.schedule" && !seen.has(e.roundId))));
    if (event.type === "match.cancelled") throw new Error(`formal match cancelled: ${event.reason}`);
    if (event.type === "match.finished") { finished = event; break; }
    seen.add(event.roundId); await advanceTo(url, event.serverTargetTimeMs);
    players.forEach((player) => player.socket.emit("client.event", cmd("launch.tap", { roomId: room.roomId, roundId: event.roundId, nonce: event.nonce, clientTimeMs: Date.now() })));
  }
  const finals = await Promise.all(clients.map((client) => client.stream.next((e) => e.type === "match.finished" && e.matchId === finished.matchId)));
  if (new Set(finals.map((e) => e.matchId)).size !== 1) throw new Error("final matchId mismatch");
  const after = await stats(url), rounds = after.observedRounds.slice(before.observedRounds.length).filter((r) => r.matchId === finished.matchId);
  if (after.engineKind !== "real" || after.physicsModelVersion !== "2.0.0" || rounds.some((r) => r.modelVersion !== "2.0.0")) throw new Error("not formal Planck 2.0.0");
  if (after.simulationCount - before.simulationCount !== rounds.length) throw new Error("simulation/attempt mismatch");
  if (rounds.filter((r) => r.winner !== "draw").length !== finished.roundWinners.length) throw new Error("non-draw mismatch");
  const broadcasts = rounds.reduce((sum, r) => sum + r.frameCount, 0);
  if (after.frameBroadcastOperations - before.frameBroadcastOperations !== broadcasts) throw new Error("broadcast operations multiplied");
  for (const round of rounds) for (const client of clients) { const final = client.stream.events.filter((e) => e.type === "battle.frame" && e.roundId === round.roundId).at(-1); if (!final || final.tick !== round.finalTick) throw new Error(`${client.name} missed ${round.roundId} final tick`); }
  clients.forEach((client) => client.socket.emit("client.event", cmd("room.leave", { roomId: room.roomId }))); await control(url, "/__test/advance", { ms: 120_001 });
  const cleaned = await poll(`cycle ${index} cleanup`, async () => { const s = await stats(url, true); return s.rooms === 0 && s.matches === 0 && s.bindings === 0 && s.terminalMatches === 0 && s.timers === 0 && s.engine.cache === 0 && s.engine.running === 0 && s.engine.queued === 0 && s.designs.total === 0 ? s : false; });
  return { attempts: rounds.length, nonDrawRounds: finished.roundWinners.length, frames: rounds.map((r) => r.frameCount), ticks: rounds.map((r) => r.finalTick), broadcasts, heap: cleaned.heapUsed };
}

let server, failure; const clients = [];
try {
  server = await startServer(); const cold = await stats(server.url, true), started = Date.now();
  const players = await Promise.all([connect(server.url, "Load-player-1"), connect(server.url, "Load-player-2")]), spectators = await Promise.all(Array.from({ length: 20 }, (_, i) => connect(server.url, `Load-spectator-${i + 1}`))); clients.push(...players, ...spectators);
  const connected = await stats(server.url, true), results = []; for (let i = 1; i <= CYCLES; i += 1) results.push(await cycle(server.url, clients, players, i));
  const elapsedMs = Date.now() - started, heaps = results.map((r) => r.heap), deltas = heaps.slice(1).map((h, i) => h - heaps[i]);
  if (elapsedMs > MAX_MS) throw new Error(`scenario ${elapsedMs}ms > ${MAX_MS}ms`);
  if (Math.max(...heaps) - Math.min(...heaps) > HEAP_SPAN || (deltas.length > 1 && deltas.every((d) => d > 4 * 1024 * 1024))) throw new Error(`linear/unbounded heap: ${heaps}`);
  clients.forEach((c) => c.socket.disconnect()); await control(server.url, "/__test/advance", { ms: 120_001 });
  const final = await poll("disconnect cleanup", async () => { const s = await stats(server.url, true); return s.connections === 0 && s.sessions === 0 && s.rooms === 0 && s.matches === 0 && s.bindings === 0 && s.timers === 0 && s.engine.cache === 0 && s.designs.total === 0 ? s : false; });
  if (final.heapUsed > connected.heapUsed + HEAP_SPAN) throw new Error("post-disconnect heap remained high");
  console.info(JSON.stringify({ engineKind: final.engineKind, physicsModelVersion: final.physicsModelVersion, cycles: results.map(({ heap, ...r }) => r), elapsedMs, heapMiB: { cold: +(cold.heapUsed / 1048576).toFixed(2), connected: +(connected.heapUsed / 1048576).toFixed(2), steady: heaps.map((h) => +(h / 1048576).toFixed(2)), final: +(final.heapUsed / 1048576).toFixed(2) }, finalCounts: { connections: final.connections, sessions: final.sessions, rooms: final.rooms, matches: final.matches, bindings: final.bindings, timers: final.timers, designs: final.designs.total, cache: final.engine.cache } }));
} catch (error) { failure = error; }
finally { clients.forEach((c) => c.socket.disconnect()); if (server) try { await stopServer(server); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; } }
if (failure) throw failure;
