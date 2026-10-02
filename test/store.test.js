import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { float32ToPcm16, parseV2Packet } from "../src/audio-hub.js";
import { OpusJitterStream } from "../src/opus-jitter-stream.js";
import { AudioHub } from "../src/audio-hub.js";
import { DiscordRelayBot } from "../src/discord-bot.js";
import { JamControlHub } from "../src/jam-control-hub.js";
import { RelayStore } from "../src/store.js";

test("pairing creates a reusable guild session without storing the raw token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-store-"));
  try {
    const store = new RelayStore(join(directory, "store.json"));
    await store.load();
    const pairing = await store.createPairing({ clientName: "PC", deviceId: "device-1" }, "https://discord.test/invite");
    const guild = await store.completePairing(pairing.code, { id: "guild-1", name: "Servidor" }, { id: "user-1", username: "Pessoa" });

    assert.ok(guild);
    assert.equal((await store.getPairing(pairing.pairingId)).status, "paired");
    assert.equal((await store.getPairing(pairing.pairingId)).destinationType, "discord");
    assert.equal(store.resolveAccessToken(pairing.accessToken).guildId, "guild-1");
    assert.equal(store.resolveListenerCredential(guild.listenerCode).guildName, "Servidor");
    assert.equal(Object.hasOwn(store.getGuild("guild-1"), "accessToken"), false);
    assert.equal(store.state.audit[0].action, "device_added");

    await store.removeGuild("guild-1", { id: "user-2", username: "Outra pessoa" });
    assert.equal(store.state.audit[1].action, "pairing_removed");
    assert.equal(store.state.audit[1].userName, "Outra pessoa");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple desktop devices remain registered in the same Discord guild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-devices-"));
  try {
    const store = new RelayStore(join(directory, "store.json"));
    await store.load();
    const guild = { id: "guild-1", name: "Servidor" };
    const user = { id: "user-1", username: "Pessoa" };

    const first = await store.createPairing({ clientName: "PC Sala", deviceId: "device-1" }, null);
    await store.completePairing(first.code, guild, user);
    const second = await store.createPairing({ clientName: "Notebook", deviceId: "device-2" }, null);
    await store.completePairing(second.code, guild, user);

    assert.equal(store.getGuildDevices(guild.id).length, 2);
    assert.equal(store.resolveAccessToken(first.accessToken).clientName, "PC Sala");
    assert.equal(store.resolveAccessToken(second.accessToken).clientName, "Notebook");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("extension can redeem the desktop pairing code and revoke its connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-extension-"));
  try {
    const store = new RelayStore(join(directory, "store.json"));
    await store.load();
    const pairing = await store.createPairing({ clientName: "PC", deviceId: "device-1" }, null);
    const extension = await store.completeExtensionPairing(pairing.code, "extension-1");

    assert.ok(extension.listenerToken);
    assert.equal((await store.getPairing(pairing.pairingId)).status, "paired");
    assert.equal((await store.getPairing(pairing.pairingId)).destinationType, "extension");
    assert.equal(store.resolveAccessToken(pairing.accessToken).relayId, extension.relayId);
    assert.equal(store.resolveListenerCredential(extension.listenerToken).relayId, extension.relayId);

    await store.removeExtension(extension.listenerToken);
    assert.equal(store.resolveListenerCredential(extension.listenerToken), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pairing code can only be redeemed once under concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-race-"));
  try {
    const store = new RelayStore(join(directory, "store.json"));
    await store.load();
    const pairing = await store.createPairing({ clientName: "PC", deviceId: "device-1" }, null);
    const attempts = await Promise.all([
      store.completePairing(pairing.code, { id: "guild-1", name: "Servidor" }, { id: "user-1", username: "Pessoa" }),
      store.completeExtensionPairing(pairing.code, "extension-1")
    ]);
    assert.equal(attempts.filter(Boolean).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("float PCM is clamped and converted to signed 16-bit", () => {
  const floats = new Float32Array([-2, -1, 0, 0.5, 1, 2]);
  const converted = float32ToPcm16(Buffer.from(floats.buffer));
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => converted.readInt16LE(index * 2)),
    [-32768, -32768, 0, 16383, 32767, 32767]
  );
});

test("v2 packets preserve sequence, timestamp and Opus payload", () => {
  const frame = Buffer.alloc(15);
  frame.set([0x53, 0x4c, 0x02, 0]);
  frame.writeUInt32LE(42, 4);
  frame.writeUInt32LE(960 * 42, 8);
  frame.set([1, 2, 3], 12);
  const parsed = parseV2Packet(frame);
  assert.equal(parsed.sequence, 42);
  assert.equal(parsed.timestamp, 960 * 42);
  assert.deepEqual([...parsed.payload], [1, 2, 3]);
});

test("Opus jitter buffer bounds its queue and records dropped packets", () => {
  const stream = new OpusJitterStream({ targetPackets: 2, maxPackets: 4 });
  for (let sequence = 0; sequence < 8; sequence += 1) {
    stream.addPacket(sequence, Buffer.from([sequence]));
  }
  const diagnostics = stream.diagnostics();
  assert.ok(diagnostics.queuedPackets <= 4);
  assert.ok(diagnostics.droppedPackets > 0);
  stream.destroy();
});

test("Opus jitter buffer preserves packet boundaries during bursty input", () => {
  const stream = new OpusJitterStream({ targetPackets: 3, maxPackets: 10 });
  stream.addPacket(0, Buffer.from([10]));
  stream.addPacket(1, Buffer.from([11]));
  assert.equal(stream.read(), null);
  stream.addPacket(2, Buffer.from([12]));
  assert.deepEqual([...stream.read()], [10]);
  assert.deepEqual([...stream.read()], [11]);
  assert.deepEqual([...stream.read()], [12]);
  stream.destroy();
});

test("audio hub identifies protocol v2 as Opus before starting Discord playback", async () => {
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(message) { this.sent.push(message); }
    close() { this.emit("close"); }
  }

  const store = {
    resolveAccessTokenFresh: async () => ({ guildId: "guild-1", guildName: "Servidor", deviceId: "device-1" }),
    claimDelegation: async (_, relay) => ({ deviceId: relay.deviceId, clientName: relay.clientName })
  };
  const hub = new AudioHub(store);
  const socket = new Socket();
  const started = new Promise((resolve) => hub.once("publisherStarted", (...args) => resolve(args)));
  assert.equal(await hub.acceptPublisher(socket, "token"), true);

  const frame = Buffer.alloc(15);
  frame.set([0x53, 0x4c, 0x02, 0]);
  frame.set([1, 2, 3], 12);
  socket.emit("message", frame, true);
  const [guildId, stream, codec] = await started;
  assert.equal(guildId, "guild-1");
  assert.equal(codec, "opus");
  stream.destroy();
  socket.close();
});

test("first publisher keeps the jam and a different device is rejected as busy", async () => {
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    closed = null;
    send(message) { this.sent.push(JSON.parse(message)); }
    close(code, reason) { this.closed = { code, reason }; this.emit("close"); }
  }

  const relays = {
    first: { guildId: "guild-1", guildName: "Servidor", deviceId: "device-1", clientName: "PC Sala" },
    second: { guildId: "guild-1", guildName: "Servidor", deviceId: "device-2", clientName: "Notebook" }
  };
  let delegation = null;
  const hub = new AudioHub({
    resolveAccessTokenFresh: async (token) => ({ ...relays[token], delegation }),
    claimDelegation: async (_, relay) => {
      delegation ??= { deviceId: relay.deviceId, clientName: relay.clientName };
      return delegation.deviceId === relay.deviceId ? delegation : null;
    }
  });
  const firstSocket = new Socket();
  const secondSocket = new Socket();

  assert.equal(await hub.acceptPublisher(firstSocket, "first"), true);
  assert.equal(await hub.acceptPublisher(secondSocket, "second"), true);
  assert.equal(hub.activePublisher("guild-1").clientName, "PC Sala");
  assert.equal(secondSocket.sent[0].type, "busy");
  assert.equal(secondSocket.sent[0].activeClientName, "PC Sala");
  assert.equal(firstSocket.closed, null);
  firstSocket.close();
});

test("publisher is refused and delegation released when paired user is not in voice", async () => {
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(message) { this.sent.push(JSON.parse(message)); }
    close(code, reason) { this.closed = { code, reason }; this.emit("close"); }
  }

  let clearedGrantId = null;
  const store = {
    resolveAccessTokenFresh: async () => ({
      guildId: "guild-1",
      deviceId: "device-1",
      pairedByUserId: "user-1"
    }),
    claimDelegation: async () => ({ deviceId: "device-1", grantId: "grant-1" }),
    clearDelegation: async (_, grantId) => { clearedGrantId = grantId; return true; }
  };
  const hub = new AudioHub(store);
  hub.setPublisherPreparer(async () => ({
    ok: false,
    type: "voice_required",
    message: "Entre em uma call."
  }));
  const socket = new Socket();

  assert.equal(await hub.acceptPublisher(socket, "token"), true);
  assert.equal(socket.sent[0].type, "voice_required");
  assert.equal(socket.sent[0].message, "Entre em uma call.");
  assert.equal(clearedGrantId, "grant-1");
  assert.equal(hub.activePublisher("guild-1"), null);
});

test("audio hub can request a clean publisher reconnect", () => {
  const hub = new AudioHub(new RelayStore("unused.json"));
  const calls = [];
  hub.publishers.set("guild-1", {
    socket: {
      readyState: 1,
      close: (code, reason) => calls.push({ code, reason })
    }
  });

  assert.equal(hub.requestPublisherReconnect("guild-1"), true);
  assert.deepEqual(calls, [{ code: 4002, reason: "Reiniciando fluxo de audio" }]);
  assert.equal(hub.requestPublisherReconnect("missing"), false);
});

test("Discord panel exposes the agreed actions", () => {
  const store = new RelayStore("unused.json");
  const bot = new DiscordRelayBot(
    { downloadUrl: "https://github.com/example/project/releases/latest" },
    store,
    new AudioHub(store));
  const panel = bot.mainPanel("guild-1");
  const labels = panel.components.flatMap((row) => row.components.map((button) => button.data.label));
  assert.deepEqual(labels, [
    "Entrar", "Sair", "Gerenciar conexao", "Ouvir pela extensao", "Baixar programa", "Ajuda"
  ]);
});

test("jam control accepts simultaneous requests and transfers the delegation", async () => {
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(message) { this.sent.push(JSON.parse(message)); }
  }
  const relays = {
    owner: { guildId: "guild-1", deviceId: "device-1", pairedByUserId: "user-1", pairedByUserName: "Joao", clientName: "PC 1" },
    guest: { guildId: "guild-1", deviceId: "device-2", pairedByUserId: "user-2", pairedByUserName: "Maria", clientName: "PC 2" }
  };
  const guild = { delegation: { deviceId: "device-1", userId: "user-1", userName: "Joao", grantId: "grant-1" } };
  const store = {
    resolveAccessTokenFresh: async (token) => relays[token],
    getGuild: () => guild,
    transferDelegation: async (_, relay) => (guild.delegation = {
      deviceId: relay.deviceId,
      userId: relay.pairedByUserId,
      userName: relay.pairedByUserName,
      grantId: "grant-2"
    }),
    clearDelegation: async () => { delete guild.delegation; return true; }
  };
  const audioHub = new EventEmitter();
  audioHub.isLive = () => false;
  audioHub.hasActiveAudio = () => false;
  const control = new JamControlHub(store, audioHub);
  let transferred;
  control.once("delegationTransferred", (_, event) => { transferred = event; });
  control.setParticipantProvider(async () => [
    { userId: "user-1", name: "Joao" },
    { userId: "user-2", name: "Maria" }
  ]);
  const ownerSocket = new Socket();
  const guestSocket = new Socket();
  await control.accept(ownerSocket, "owner");
  await control.accept(guestSocket, "guest");

  const guestSession = [...control.sessions.get("guild-1")].find((session) => session.relay.deviceId === "device-2");
  const ownerSession = [...control.sessions.get("guild-1")].find((session) => session.relay.deviceId === "device-1");
  await control.requestTurn(guestSession);
  const request = [...control.requests.get("guild-1").values()][0];
  assert.equal(request.userName, "Maria");
  await control.confirmTransfer(ownerSession, request.id, "user-2");
  assert.equal(guild.delegation.deviceId, "device-2");
  assert.equal(guestSocket.sent.some((message) => message.type === "delegation_granted"), true);
  assert.equal(ownerSocket.sent.some((message) => message.type === "delegation_revoked"), true);
  assert.equal(transferred.current.deviceId, "device-2");
});

test("release clears a silent delegation but never interrupts active audio", async () => {
  const guild = { delegation: { deviceId: "device-1", grantId: "grant-1" } };
  let audioActive = true;
  const store = {
    getGuild: () => guild,
    clearDelegation: async () => { delete guild.delegation; return true; }
  };
  const audioHub = new EventEmitter();
  audioHub.hasActiveAudio = () => audioActive;
  const control = new JamControlHub(store, audioHub);
  let releasedGuildId;
  control.once("delegationReleased", (guildId) => { releasedGuildId = guildId; });

  assert.deepEqual(await control.releaseDelegation("guild-1"), {
    released: false,
    reason: "audio_active"
  });
  assert.ok(guild.delegation);

  audioActive = false;
  assert.deepEqual(await control.releaseDelegation("guild-1"), {
    released: true,
    reason: null
  });
  assert.equal(guild.delegation, undefined);
  assert.equal(releasedGuildId, "guild-1");
});
