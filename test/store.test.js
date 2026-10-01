import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { float32ToPcm16 } from "../src/audio-hub.js";
import { AudioHub } from "../src/audio-hub.js";
import { DiscordRelayBot } from "../src/discord-bot.js";
import { RelayStore } from "../src/store.js";

test("pairing creates a reusable guild session without storing the raw token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-store-"));
  try {
    const store = new RelayStore(join(directory, "store.json"));
    await store.load();
    const pairing = store.createPairing({ clientName: "PC", deviceId: "device-1" }, "https://discord.test/invite");
    const guild = await store.completePairing(pairing.code, { id: "guild-1", name: "Servidor" }, { id: "user-1", username: "Pessoa" });

    assert.ok(guild);
    assert.equal(store.getPairing(pairing.pairingId).status, "paired");
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
    const pairing = store.createPairing({ clientName: "PC", deviceId: "device-1" }, null);
    const extension = await store.completeExtensionPairing(pairing.code, "extension-1");

    assert.ok(extension.listenerToken);
    assert.equal(store.getPairing(pairing.pairingId).status, "paired");
    assert.equal(store.resolveAccessToken(pairing.accessToken).relayId, extension.relayId);
    assert.equal(store.resolveListenerCredential(extension.listenerToken).relayId, extension.relayId);

    await store.removeExtension(extension.listenerToken);
    assert.equal(store.resolveListenerCredential(extension.listenerToken), null);
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
