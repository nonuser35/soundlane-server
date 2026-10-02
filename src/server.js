import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { AudioHub } from "./audio-hub.js";
import { DiscordRelayBot } from "./discord-bot.js";
import { JamControlHub } from "./jam-control-hub.js";
import { RelayStore } from "./store.js";

const config = {
  port: Number(process.env.PORT || 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  downloadUrl: process.env.DOWNLOAD_URL || "https://github.com",
  dataDir: resolve(process.env.DATA_DIR || "./data")
};

const store = new RelayStore(resolve(config.dataDir, "relay-store.json"));
await store.load();
const audioHub = new AudioHub(store);
const jamControlHub = new JamControlHub(store, audioHub);
let bot = null;

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("Payload muito grande");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, config.publicBaseUrl);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type"
      });
      return response.end();
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        status: "ok",
        audio: audioHub.diagnostics(),
        discord: bot?.diagnostics() ?? { connected: false }
      });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/pairings") {
      const body = await readJson(request);
      if (!body.deviceId) return json(response, 400, { error: "deviceId obrigatorio" });
      const inviteUrl = config.discordClientId
        ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.discordClientId)}&scope=bot%20applications.commands&permissions=3145728`
        : null;
      return json(response, 201, await store.createPairing(body, inviteUrl));
    }

    if (request.method === "POST" && url.pathname === "/api/v1/extensions/pair") {
      const body = await readJson(request);
      if (!body.code || !body.extensionId) return json(response, 400, { error: "Codigo e extensao obrigatorios" });
      const pairing = await store.completeExtensionPairing(body.code, body.extensionId);
      if (!pairing) return json(response, 404, { error: "Codigo invalido ou expirado" });
      return json(response, 200, {
        listenerToken: pairing.listenerToken,
        relayName: pairing.relayName
      });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/extensions/remove") {
      const body = await readJson(request);
      if (!body.listenerToken) return json(response, 400, { error: "Credencial obrigatoria" });
      const removed = await store.removeExtension(body.listenerToken);
      if (!removed) return json(response, 404, { error: "Conexao nao encontrada" });
      audioHub.disconnectRelay(removed.relayId);
      return json(response, 200, { removed: true });
    }

    const pairingMatch = url.pathname.match(/^\/api\/v1\/pairings\/([a-f0-9-]+)$/i);
    if (request.method === "GET" && pairingMatch) {
      const pairing = await store.getPairing(pairingMatch[1]);
      if (!pairing) return json(response, 404, { error: "Pareamento nao encontrado" });
      return json(response, 200, {
        status: pairing.status === "paired" ? "connected" : pairing.status,
        accessToken: pairing.accessToken ?? null,
        guildName: pairing.guildName ?? null,
        discordUserName: pairing.discordUserName ?? null,
        destinationType: pairing.destinationType ?? null
      });
    }

    return json(response, 404, { error: "Rota nao encontrada" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: "Erro interno" });
  }
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const websocketHeartbeat = setInterval(() => {
  for (const websocket of websocketServer.clients) {
    if (websocket.isAlive === false) {
      websocket.terminate();
      continue;
    }
    websocket.isAlive = false;
    websocket.ping();
  }
}, 25_000);
websocketHeartbeat.unref();

function waitForWebSocketAuth(websocket) {
  return new Promise((resolveAuth) => {
    const timer = setTimeout(() => {
      cleanup();
      resolveAuth(null);
    }, 8_000);
    const onMessage = (data, isBinary) => {
      cleanup();
      if (isBinary || data.length > 4_096) return resolveAuth(null);
      try {
        const message = JSON.parse(data.toString("utf8"));
        resolveAuth(message.type === "auth" ? message : null);
      } catch {
        resolveAuth(null);
      }
    };
    const onClose = () => {
      cleanup();
      resolveAuth(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      websocket.off("message", onMessage);
      websocket.off("close", onClose);
    };
    websocket.once("message", onMessage);
    websocket.once("close", onClose);
  });
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, config.publicBaseUrl);
  websocketServer.handleUpgrade(request, socket, head, async (websocket) => {
    try {
      websocket.isAlive = true;
      websocket.on("pong", () => { websocket.isAlive = true; });
      const legacyCredential = url.pathname === "/api/v1/stream"
        ? url.searchParams.get("access_token")
        : url.searchParams.get("code");
      const auth = legacyCredential ? null : await waitForWebSocketAuth(websocket);
      const credential = legacyCredential || auth?.credential || "";
      const accepted = url.pathname === "/api/v1/stream"
        ? await audioHub.acceptPublisher(websocket, credential)
        : url.pathname === "/api/v1/control"
          ? await jamControlHub.accept(websocket, credential)
        : url.pathname === "/api/v1/listen"
          ? await audioHub.acceptListener(websocket, credential)
          : false;
      if (!accepted) websocket.close(4003, "Credencial invalida");
    } catch (error) {
      console.error("Falha ao validar credencial no Upstash:", error);
      websocket.close(1011, "Persistencia temporariamente indisponivel");
    }
  });
});

server.on("close", () => clearInterval(websocketHeartbeat));

server.listen(config.port, "0.0.0.0", () => {
  console.log(`HTTP e WebSocket escutando na porta ${config.port}`);
});

if (config.discordToken && config.discordClientId) {
  bot = new DiscordRelayBot(config, store, audioHub, jamControlHub);
  await bot.start();
  jamControlHub.setParticipantProvider((guildId) => bot.getVoiceParticipants(guildId));
  jamControlHub.setGuildStatusProvider((guildId) => bot.getGuildStatus(guildId));
  audioHub.setPublisherPreparer((relay) => bot.preparePublisher(relay));
  console.log("Bot do Discord conectado.");
} else {
  console.warn("DISCORD_TOKEN/DISCORD_CLIENT_ID ausentes: API iniciada sem bot.");
}
