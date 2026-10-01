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
    assert.equal(store.state.audit[0].action, "pairing_added");

    await store.removeGuild("guild-1", { id: "user-2", username: "Outra pessoa" });
    assert.equal(store.state.audit[1].action, "pairing_removed");
    assert.equal(store.state.audit[1].userName, "Outra pessoa");
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
    resolveAccessTokenFresh: async () => ({ guildId: "guild-1", guildName: "Servidor" })
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
