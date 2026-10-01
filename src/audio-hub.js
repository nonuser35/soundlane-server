import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { OpusJitterStream } from "./opus-jitter-stream.js";

const V2_HEADER_BYTES = 12;

function parseV2Packet(frame) {
  if (frame.length <= V2_HEADER_BYTES ||
      frame[0] !== 0x53 || frame[1] !== 0x4c || frame[2] !== 0x02) return null;
  return {
    sequence: frame.readUInt32LE(4),
    timestamp: frame.readUInt32LE(8),
    payload: frame.subarray(V2_HEADER_BYTES)
  };
}

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

  async acceptPublisher(socket, token) {
    const relay = await this.store.resolveAccessTokenFresh(token);
    if (!relay) return false;
    const relayKey = relay.guildId ?? relay.relayId;

    this.publishers.get(relayKey)?.socket.close(4001, "Nova transmissao iniciada");
    const session = { socket, relay, stream: null, codec: null };
    this.publishers.set(relayKey, session);
    console.log(`Transmissao iniciada para um servidor.`);

    socket.on("message", (data, isBinary) => {
      if (!isBinary || data.length > 1024 * 1024) return;
      const frame = Buffer.from(data);
      this.framesReceived += 1;
      this.bytesReceived += frame.length;
      this.lastFrameAt = new Date().toISOString();

      const v2Packet = parseV2Packet(frame);
      if (!session.stream) {
        if (v2Packet) {
          session.codec = "opus";
          session.stream = new OpusJitterStream();
        } else {
          session.codec = "pcm-f32";
          session.stream = new PassThrough({ highWaterMark: 38400 });
        }
        if (relay.guildId) this.emit("publisherStarted", relay.guildId, session.stream, session.codec);
        this.notifyFormat(relayKey, session.codec);
      }

      if (session.codec === "opus") {
        if (!v2Packet) return;
        session.stream.addPacket(v2Packet.sequence, v2Packet.payload);
      } else {
        session.stream.write(float32ToPcm16(frame));
      }

      for (const listener of this.listeners.get(relayKey) ?? []) {
        if (listener.readyState === WebSocket.OPEN && listener.bufferedAmount < 512 * 1024) {
          listener.send(frame, { binary: true });
        }
      }
    });
    socket.on("close", () => {
      if (session.codec === "opus") session.stream?.endInput();
      else session.stream?.end();
      if (this.publishers.get(relayKey) === session) {
        this.publishers.delete(relayKey);
        if (relay.guildId) this.emit("publisherStopped", relay.guildId);
      }
      console.log(`Transmissao encerrada para um servidor.`);
    });
    socket.send(JSON.stringify({ type: "ready", guildName: relay.guildName ?? relay.relayName }));
    return true;
  }

  async acceptListener(socket, code) {
    const relay = await this.store.resolveListenerCredentialFresh(code);
    if (!relay) return false;
    const relayKey = relay.guildId ?? relay.relayId;

    let listeners = this.listeners.get(relayKey);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(relayKey, listeners);
    }
    listeners.add(socket);
    socket.on("close", () => {
      listeners.delete(socket);
      if (listeners.size === 0) this.listeners.delete(relayKey);
    });
    socket.send(JSON.stringify({
      type: "ready",
      guildName: relay.guildName ?? relay.relayName,
      live: this.publishers.has(relayKey),
      codec: this.publishers.get(relayKey)?.codec ?? null
    }));
    return true;
  }

  notifyFormat(relayKey, codec) {
    const message = JSON.stringify({
      type: "format",
      codec,
      sampleRate: 48000,
      channels: 2,
      frameMs: codec === "opus" ? 20 : 10
    });
    for (const listener of this.listeners.get(relayKey) ?? []) {
      if (listener.readyState === WebSocket.OPEN) listener.send(message);
    }
  }

  isLive(guildId) {
    return this.publishers.has(guildId);
  }

  requestPublisherReconnect(relayKey) {
    const socket = this.publishers.get(relayKey)?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.close(4002, "Reiniciando fluxo de audio");
    return true;
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
      lastFrameAt: this.lastFrameAt,
      codecs: [...this.publishers.values()].map((session) => session.codec ?? "waiting"),
      jitter: [...this.publishers.values()]
        .filter((session) => session.codec === "opus")
        .map((session) => session.stream.diagnostics())
    };
  }

  disconnectGuild(guildId) {
    this.publishers.get(guildId)?.socket.close(4001, "Conexao substituida ou removida");
    for (const listener of this.listeners.get(guildId) ?? []) {
      listener.close(4001, "Sessao encerrada");
    }
  }

  disconnectRelay(relayId) {
    this.publishers.get(relayId)?.socket.close(4001, "Conexao removida");
    for (const listener of this.listeners.get(relayId) ?? []) {
      listener.close(4001, "Conexao removida");
    }
  }
}

export { float32ToPcm16, parseV2Packet };
