import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";

function float32ToPcm16(buffer) {
  const sampleCount = Math.floor(buffer.length / 4);
  const output = Buffer.allocUnsafe(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, buffer.readFloatLE(index * 4)));
    output.writeInt16LE(sample < 0 ? sample * 32768 : sample * 32767, index * 2);
  }
  return output;
}

export class AudioHub extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.publishers = new Map();
    this.listeners = new Map();
    this.framesReceived = 0;
    this.bytesReceived = 0;
    this.lastFrameAt = null;
  }

  acceptPublisher(socket, token) {
    const guild = this.store.resolveAccessToken(token);
    if (!guild) return false;

    this.publishers.get(guild.guildId)?.close(4001, "Nova transmissao iniciada");
    this.publishers.set(guild.guildId, socket);
    const discordPcm = new PassThrough({ highWaterMark: 38400 });
    this.emit("publisherStarted", guild.guildId, discordPcm);
    console.log(`Transmissao iniciada para um servidor.`);

    socket.on("message", (data, isBinary) => {
      if (!isBinary || data.length > 1024 * 1024) return;
      const frame = Buffer.from(data);
      this.framesReceived += 1;
      this.bytesReceived += frame.length;
      this.lastFrameAt = new Date().toISOString();
      discordPcm.write(float32ToPcm16(frame));
      for (const listener of this.listeners.get(guild.guildId) ?? []) {
        if (listener.readyState === WebSocket.OPEN && listener.bufferedAmount < 512 * 1024) {
          listener.send(frame, { binary: true });
        }
      }
    });
    socket.on("close", () => {
      if (this.publishers.get(guild.guildId) === socket) this.publishers.delete(guild.guildId);
      discordPcm.end();
      this.emit("publisherStopped", guild.guildId);
      console.log(`Transmissao encerrada para um servidor.`);
    });
    socket.send(JSON.stringify({ type: "ready", guildName: guild.guildName }));
    return true;
  }

  acceptListener(socket, code) {
    const guild = this.store.resolveListenerCode(code);
    if (!guild) return false;

    let listeners = this.listeners.get(guild.guildId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(guild.guildId, listeners);
    }
    listeners.add(socket);
    socket.on("close", () => {
      listeners.delete(socket);
      if (listeners.size === 0) this.listeners.delete(guild.guildId);
    });
    socket.send(JSON.stringify({
      type: "ready",
      guildName: guild.guildName,
      live: this.publishers.has(guild.guildId)
    }));
    return true;
  }

  isLive(guildId) {
    return this.publishers.has(guildId);
  }

  listenerCount(guildId) {
    return this.listeners.get(guildId)?.size ?? 0;
  }

  diagnostics() {
    return {
      publishers: this.publishers.size,
      listeners: [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0),
      framesReceived: this.framesReceived,
      bytesReceived: this.bytesReceived,
      lastFrameAt: this.lastFrameAt
    };
  }

  disconnectGuild(guildId) {
    this.publishers.get(guildId)?.close(4001, "Conexao substituida ou removida");
    for (const listener of this.listeners.get(guildId) ?? []) {
      listener.close(4001, "Sessao encerrada");
    }
  }
}

export { float32ToPcm16 };
