import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { AudioHub } from "./audio-hub.js";
import { BrowserMetadataHub } from "./browser-metadata-hub.js";
import { DiscordRelayBot } from "./discord-bot.js";
import { JamControlHub } from "./jam-control-hub.js";
import { NewsEngine } from "./news-engine.js";
import { RelayStore } from "./store.js";

const config = {
  port: Number(process.env.PORT || 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  downloadUrl: process.env.DOWNLOAD_URL || "https://github.com",
  windowHostSiteUrl: process.env.WINDOW_HOST_SITE_URL || "https://p01--soundlane-bot--xz6744xjl6hb.code.run/window/",
  dataDir: resolve(process.env.DATA_DIR || "./data")
};

const store = new RelayStore(resolve(config.dataDir, "relay-store.json"));
await store.load();
const audioHub = new AudioHub(store);
const browserMetadataHub = new BrowserMetadataHub(store);
const jamControlHub = new JamControlHub(store, audioHub);
const newsEngine = new NewsEngine();
let bot = null;
const windowRoot = resolve("./public/window");
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".webmanifest", "application/manifest+json"]
]);

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

async function serveWindowAsset(url, response) {
  if (url.pathname === "/window") {
    response.writeHead(308, { location: "/window/" });
    response.end();
    return true;
  }
  if (!url.pathname.startsWith("/window/")) return false;
  const relative = decodeURIComponent(url.pathname.slice(8)) || "index.html";
  let assetPath = resolve(windowRoot, relative);
  if (assetPath !== windowRoot && !assetPath.startsWith(windowRoot + sep)) {
    response.writeHead(403);
    response.end();
    return true;
  }
  try {
    const info = await stat(assetPath);
    if (info.isDirectory()) assetPath = resolve(assetPath, "index.html");
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(assetPath).toLowerCase()) || "application/octet-stream",
      "cache-control": extname(assetPath) === ".html" ? "no-cache" : "public, max-age=3600"
    });
    createReadStream(assetPath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Janela nao encontrada");
  }
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, config.publicBaseUrl);
    if (request.method === "GET" && await serveWindowAsset(url, response)) return;
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

    if (request.method === "GET" && url.pathname === "/api/v1/news") {
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length < 2) return json(response, 400, { error: "Busca obrigatoria" });
      const language = url.searchParams.get("lang") || "pt-BR";
      const limit = Math.max(1, Math.min(40, Number(url.searchParams.get("limit")) || 24));
      const items = await newsEngine.search(query, language, limit);
      return json(response, 200, { query, language, updatedAt: new Date().toISOString(), items });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/pairings") {
      const body = await readJson(request);
      if (!body.deviceId) return json(response, 400, { error: "deviceId obrigatorio" });
      const inviteUrl = config.discordClientId
        ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.discordClientId)}&scope=bot%20applications.commands&permissions=3145728`
        : null;
      return json(response, 201, await store.createPairing(body, inviteUrl));
    }

    if (request.method === "POST" && url.pathname === "/api/v1/window-host/sessions") {
      const body = await readJson(request);
      if (!body.credential) return json(response, 400, { error: "Credencial obrigatoria" });
      const session = await store.createWindowHostSession(body.credential, {
        clientName: body.clientName,
        relayName: "Window Host",
        language: body.language
      });
      if (!session) return json(response, 403, { error: "Credencial invalida" });
      const shareUrl = new URL(config.windowHostSiteUrl);
      shareUrl.hash = new URLSearchParams({
        window: session.viewerToken,
        server: config.publicBaseUrl,
        lang: session.language
      }).toString();
      return json(response, 201, {
        sessionId: session.sessionId,
        publisherToken: session.publisherToken,
        viewerToken: session.viewerToken,
        shareUrl: shareUrl.toString(),
        expiresAt: session.expiresAt
      });
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
}, 8_000);
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
      const publicWindowPath = url.pathname === "/api/v1/window-host/listen" ||
        url.pathname === "/api/v1/window-host/metadata/subscribe";
      const auth = legacyCredential || publicWindowPath ? null : await waitForWebSocketAuth(websocket);
      const credential = legacyCredential || auth?.credential || "";
      const accepted = url.pathname === "/api/v1/stream"
        ? await audioHub.acceptPublisher(websocket, credential)
        : url.pathname === "/api/v1/window-host/stream"
          ? await audioHub.acceptWindowPublisher(websocket, credential)
        : url.pathname === "/api/v1/window-host/listen"
          ? audioHub.acceptWindowListener(websocket)
        : url.pathname === "/api/v1/control"
          ? await jamControlHub.accept(websocket, credential)
        : url.pathname === "/api/v1/listen"
          ? await audioHub.acceptListener(websocket, credential)
        : url.pathname === "/api/v1/browser-metadata/publish"
          ? await browserMetadataHub.acceptPublisher(websocket, credential)
        : url.pathname === "/api/v1/browser-metadata/subscribe"
          ? await browserMetadataHub.acceptSubscriber(websocket, credential)
        : url.pathname === "/api/v1/window-host/metadata/publish"
          ? await browserMetadataHub.acceptWindowPublisher(websocket, credential)
        : url.pathname === "/api/v1/window-host/metadata/subscribe"
          ? browserMetadataHub.acceptWindowSubscriber(websocket)
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
