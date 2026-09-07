#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import https from "node:https";
import { io } from "socket.io-client";

const [origin, nonce] = process.argv.slice(2);
if (!/^https:\/\//u.test(origin) || !/^[a-f0-9]{64}$/u.test(nonce)) process.exit(2);
const publicUrl = new URL(origin);
const integration = process.env.SMOKE_INTEGRATION_MODE === "true";
if (publicUrl.pathname !== "/" || (integration ? origin !== "https://steam-top.integration.test:18443" : Boolean(publicUrl.port))) process.exit(2);

// Keep the public Host/SNI for certificate validation, but never use public DNS.
const lookup = (_hostname, _options, callback) => callback(null, "127.0.0.1", 4);
const agent = new https.Agent({ lookup, rejectUnauthorized: true });
const command = (type, fields = {}) => ({ type, protocolVersion: 1, eventId: randomUUID(), ...fields });
const wait = (socket, type, ms = 15_000) => new Promise((resolve, reject) => {
  const listener = (event) => {
    if (event.type !== type) return;
    clearTimeout(timer);
    socket.off("server.event", listener);
    resolve(event);
  };
  const timer = setTimeout(() => {
    socket.off("server.event", listener);
    reject(new Error(`timeout ${type}`));
  }, ms);
  socket.on("server.event", listener);
});
const waitWhere = (socket, type, predicate, ms = 15_000) => new Promise((resolve, reject) => {
  const listener = (event) => {
    if (event.type !== type || !predicate(event)) return;
    clearTimeout(timer); socket.off("server.event", listener); resolve(event);
  };
  const timer = setTimeout(() => { socket.off("server.event", listener); reject(new Error(`timeout ${type} correlation`)); }, ms);
  socket.on("server.event", listener);
});

async function connect(name) {
  const cookie = await new Promise((resolve, reject) => {
    const request = https.request({
      agent, hostname: publicUrl.hostname, port: publicUrl.port || 443,
      servername: publicUrl.hostname, path: "/api/identity", method: "GET",
      headers: { host: publicUrl.host, origin },
    }, response => {
      response.resume();
      const cookies = response.headers["set-cookie"] ?? [];
      if (response.statusCode !== 200 || cookies.length === 0) return reject(new Error(`identity ${response.statusCode}`));
      resolve(cookies.map(value => value.split(";", 1)[0]).join("; "));
    });
    request.setTimeout(10_000, () => request.destroy(new Error("identity timeout")));
    request.on("error", reject); request.end();
  });
  const socket = io(origin, {
    transports: ["websocket"], upgrade: false, rejectUnauthorized: true,
    transportOptions: { websocket: { lookup } },
    extraHeaders: { origin, cookie },
    forceNew: true, reconnection: false,
    auth: { displayName: `smoke-${nonce.slice(0, 8)}-${name}` }, timeout: 8_000,
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  if (socket.io.engine.transport.name !== "websocket") throw new Error("not websocket");
  const welcome = wait(socket, "protocol.welcome");
  socket.emit("client.event", command("protocol.hello", { supportedVersions: [1] }));
  return { socket, token: (await welcome).sessionToken };
}

function postJson(path, token, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request({
      agent, hostname: publicUrl.hostname, port: publicUrl.port || 443, servername: publicUrl.hostname,
      path, method: "POST", headers: {
        host: publicUrl.host, origin, authorization: `Bearer ${token}`,
        "content-type": "application/json", "content-length": payload.length,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 201) return reject(new Error(`design ${response.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

const design = () => ({
  id: randomUUID(), name: `smoke-${nonce.slice(0, 8)}`,
  layers: [
    { id: randomUUID(), position: "top", shape: "circle", points: 6, diameterMm: 40, cornerRoundness: 0.5, rotationDeg: 0, color: "#2563eb" },
    { id: randomUUID(), position: "middle", shape: "polygon", points: 6, diameterMm: 55, cornerRoundness: 0.5, rotationDeg: 0, color: "#60a5fa" },
    { id: randomUUID(), position: "bottom", shape: "circle", points: 6, diameterMm: 48, cornerRoundness: 0.5, rotationDeg: 0, color: "#bfdbfe" },
  ],
  screwLayout: { count: 4, radiusMm: 15, rotationDeg: 0 }, metalDiscDiameterMm: 0,
});

const clients = [];
try {
  const a = await connect("a");
  const b = await connect("b");
  clients.push(a.socket, b.socket);
  const created = wait(a.socket, "room.snapshot");
  a.socket.emit("client.event", command("room.create", { name: `smoke-${nonce}` }));
  const room = await created;
  const joined = wait(b.socket, "room.snapshot");
  b.socket.emit("client.event", command("room.join", { roomId: room.roomId, role: "player" }));
  await joined;
  const upload = async (client) => (await postJson("/api/designs", client.token, design())).designId;
  const [d1, d2] = await Promise.all([upload(a), upload(b)]);
  // Each round consumes a full minute, in addition to the launch window.
  const finishedA = waitWhere(a.socket, "match.finished", (event) => event.roomId === room.roomId, 300_000);
  const finishedB = waitWhere(b.socket, "match.finished", (event) => event.roomId === room.roomId, 300_000);
  const rounds = [new Map(), new Map()];
  const completedRounds = [new Map(), new Map()];
  const tap = async (client, event) => {
    if (event.roomId !== room.roomId || typeof event.roundId !== "string" || typeof event.nonce !== "string") throw new Error("schedule correlation invalid");
    // The CI client and loopback server share a host clock; respect the countdown.
    const delay = event.serverTargetTimeMs - Date.now();
    if (!Number.isFinite(delay) || delay > 15_000) throw new Error("launch target invalid");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)));
    const request = command("launch.tap", { roomId: room.roomId, roundId: event.roundId, nonce: event.nonce, clientTimeMs: event.serverTargetTimeMs });
    const ack = waitWhere(client.socket, "command.ack", (reply) => reply.causedByEventId === request.eventId && reply.commandType === "launch.tap");
    const result = waitWhere(client.socket, "launch.result.private", (reply) => reply.roomId === room.roomId && reply.roundId === event.roundId);
    client.socket.emit("client.event", request);
    const [accepted, privateResult] = await Promise.all([ack, result]);
    if (accepted.roomId && accepted.roomId !== room.roomId || privateResult.matchId && typeof privateResult.matchId !== "string") throw new Error("tap binding invalid");
    return privateResult;
  };
  const handlers = [a, b].map((client, index) => (event) => {
    if (event.type === "launch.schedule") { if(rounds[index].has(event.roundId))throw new Error("duplicate launch schedule");rounds[index].set(event.roundId,tap(client, event)); }
    if (event.type === "round.finished" && event.roomId === room.roomId) {
      if (completedRounds[index].has(event.roundId)) throw new Error("duplicate round result");
      completedRounds[index].set(event.roundId, { winner: event.winner, matchId: event.matchId });
    }
  });
  [a, b].forEach((client,index)=>client.socket.on("server.event",handlers[index]));
  const readyA=command("player.ready",{roomId:room.roomId,designId:d1}),readyB=command("player.ready",{roomId:room.roomId,designId:d2});
  const readyAcknowledge=waitWhere(a.socket,"command.ack",reply=>reply.causedByEventId===readyA.eventId&&reply.commandType==="player.ready"),readyBAcknowledge=waitWhere(b.socket,"command.ack",reply=>reply.causedByEventId===readyB.eventId&&reply.commandType==="player.ready");
  a.socket.emit("client.event",readyA);b.socket.emit("client.event",readyB);await Promise.all([readyAcknowledge,readyBAcknowledge]);
  const [matchA, matchB] = await Promise.all([finishedA, finishedB]);
  if (matchA.matchId !== matchB.matchId || matchA.roomId !== room.roomId || matchA.roundWinners.length < 2) throw new Error("match correlation invalid");
  // match.roundWinners contains player labels, not round IDs; draws are replayed.
  const expectedRounds=new Set(completedRounds[0].keys());
  if (expectedRounds.size < matchA.roundWinners.length || JSON.stringify(matchA.roundWinners) !== JSON.stringify(matchB.roundWinners)) throw new Error("round winner set invalid");
  for (const completed of completedRounds) {
    if (completed.size !== expectedRounds.size || [...completed].some(([id, result]) => !expectedRounds.has(id) || result.matchId !== matchA.matchId)) throw new Error("round result correlation invalid");
    const winners = [...completed.values()].map(result => result.winner).filter(winner => winner !== "draw");
    if (JSON.stringify(winners) !== JSON.stringify(matchA.roundWinners)) throw new Error("round result winners invalid");
  }
  await new Promise((resolve,reject)=>{const deadline=Date.now()+15_000;const check=()=>{if(rounds.every(seen=>seen.size===expectedRounds.size&&[...expectedRounds].every(roundId=>seen.has(roundId))))return resolve();if(Date.now()>=deadline)return reject(new Error("rhythm coverage deadline"));setTimeout(check,25)};check()});
  [a,b].forEach((client,index)=>client.socket.off("server.event",handlers[index]));
  const sealedSubmissions=rounds.flatMap(seen=>[...expectedRounds].map(roundId=>seen.get(roundId)));const results=await Promise.all(sealedSubmissions);
  if(sealedSubmissions.length!==expectedRounds.size*2||results.some(result=>result.roomId!==room.roomId||result.matchId&&result.matchId!==matchA.matchId||!expectedRounds.has(result.roundId)))throw new Error("per-client rhythm coverage invalid");
  if (![d1, d2].every((id) => typeof id === "string" && id.length > 0)) throw new Error("design correlation invalid");
  a.socket.emit("client.event", command("room.close", { roomId: room.roomId }));
} finally {
  for (const socket of clients) socket.close();
}
