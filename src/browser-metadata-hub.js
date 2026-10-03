import { WebSocket } from "ws";

const MAX_TABS = 20;

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeSnapshot(message) {
  const tabs = Array.isArray(message.tabs) ? message.tabs.slice(0, MAX_TABS) : [];
  return {
    type: "browser_metadata",
    browser: cleanText(message.browser, 32),
    updatedAt: new Date().toISOString(),
    tabs: tabs.map((tab) => ({
      id: Number.isInteger(tab.id) ? tab.id : null,
      title: cleanText(tab.title, 300),
      origin: cleanText(tab.origin, 200),
      favIconUrl: cleanText(tab.favIconUrl, 2_048),
      audible: tab.audible === true,
      muted: tab.muted === true
    })).filter((tab) => tab.audible)
  };
}

export class BrowserMetadataHub {
  constructor(store) {
    this.store = store;
    this.subscribers = new Map();
    this.latest = new Map();
  }

  async acceptPublisher(socket, credential) {
    const relay = await this.store.resolveAccessTokenFresh(credential) ??
      await this.store.resolveListenerCredentialFresh(credential);
    if (!relay?.relayId) return false;

    socket.on("message", (data, isBinary) => {
      if (isBinary || data.length > 64 * 1024) return;
      try {
        const message = JSON.parse(data.toString("utf8"));
        if (message.type === "browser_metadata") {
          this.broadcast(relay.relayId, sanitizeSnapshot(message));
        }
      } catch {
        // A malformed update is ignored without dropping the persistent link.
      }
    });
    socket.on("close", () => this.broadcast(relay.relayId, {
      type: "browser_metadata",
      browser: "",
      updatedAt: new Date().toISOString(),
      tabs: []
    }));
    socket.send(JSON.stringify({ type: "ready" }));
    return true;
  }

  async acceptSubscriber(socket, credential) {
    const relay = await this.store.resolveAccessTokenFresh(credential) ??
      await this.store.resolveListenerCredentialFresh(credential);
    if (!relay?.relayId) return false;

    let listeners = this.subscribers.get(relay.relayId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(relay.relayId, listeners);
    }
    listeners.add(socket);
    socket.on("close", () => {
      listeners.delete(socket);
      if (listeners.size === 0) this.subscribers.delete(relay.relayId);
    });
    socket.send(JSON.stringify({ type: "ready" }));
    const snapshot = this.latest.get(relay.relayId);
    if (snapshot) socket.send(JSON.stringify(snapshot));
    return true;
  }

  broadcast(relayId, message) {
    this.latest.set(relayId, message);
    const payload = JSON.stringify(message);
    for (const socket of this.subscribers.get(relayId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
}

