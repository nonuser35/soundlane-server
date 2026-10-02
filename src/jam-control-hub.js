import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

const REQUEST_LIFETIME_MS = 20_000;
const START_GRACE_MS = 10_000;

export class JamControlHub extends EventEmitter {
  constructor(store, audioHub) {
    super();
    this.store = store;
    this.audioHub = audioHub;
    this.sessions = new Map();
    this.requests = new Map();
    this.offers = new Map();
    this.participantProvider = async () => [];

    audioHub.on("publisherStarted", (guildId) => this.broadcastSnapshot(guildId));
    audioHub.on("publisherStopped", (guildId) => this.broadcastSnapshot(guildId));
  }

  setParticipantProvider(provider) {
    this.participantProvider = provider;
  }

  async accept(socket, token) {
    const relay = await this.store.resolveAccessTokenFresh(token);
    if (!relay?.guildId || !relay.deviceId) return false;
    const session = { socket, relay };
    let guildSessions = this.sessions.get(relay.guildId);
    if (!guildSessions) {
      guildSessions = new Set();
      this.sessions.set(relay.guildId, guildSessions);
    }
    guildSessions.add(session);

    socket.on("message", (data, isBinary) => {
      if (isBinary || data.length > 16_384) return;
      try {
        this.handleMessage(session, JSON.parse(data.toString("utf8"))).catch(console.error);
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Mensagem invalida." }));
      }
    });
    socket.on("close", () => {
      guildSessions.delete(session);
      if (guildSessions.size === 0) this.sessions.delete(relay.guildId);
      this.broadcastSnapshot(relay.guildId);
    });
    await this.sendSnapshot(session);
    await this.broadcastSnapshot(relay.guildId);
    return true;
  }

  async handleMessage(session, message) {
    switch (message.type) {
      case "request_turn":
        return this.requestTurn(session);
      case "select_participant":
        return this.selectParticipant(session, message.userId);
      case "confirm_transfer":
        return this.confirmTransfer(session, message.requestId, message.userId);
      case "accept_offer":
        return this.acceptOffer(session, message.offerId);
      case "decline_offer":
        return this.declineOffer(session, message.offerId);
      case "release_delegation":
        return this.releaseDelegation(session.relay.guildId);
      default:
        return undefined;
    }
  }

  async requestTurn(session) {
    const { guildId, deviceId } = session.relay;
    const delegation = this.store.getGuild(guildId)?.delegation;
    if (!delegation) {
      await this.transferTo(guildId, session.relay);
      return;
    }
    if (delegation.deviceId === deviceId) return;

    let guildRequests = this.requests.get(guildId);
    if (!guildRequests) {
      guildRequests = new Map();
      this.requests.set(guildId, guildRequests);
    }
    for (const request of guildRequests.values()) {
      if (request.deviceId === deviceId) return;
    }
    const request = {
      id: randomUUID(),
      deviceId,
      userId: session.relay.pairedByUserId ?? null,
      userName: session.relay.pairedByUserName ?? session.relay.clientName,
      clientName: session.relay.clientName,
      expiresAt: new Date(Date.now() + REQUEST_LIFETIME_MS).toISOString()
    };
    guildRequests.set(request.id, request);
    const timer = setTimeout(() => {
      guildRequests.delete(request.id);
      if (guildRequests.size === 0) this.requests.delete(guildId);
      this.broadcastSnapshot(guildId);
    }, REQUEST_LIFETIME_MS);
    timer.unref();
    await this.broadcastSnapshot(guildId, { type: "turn_requested" });
  }

  async selectParticipant(session, userId) {
    const guildId = session.relay.guildId;
    const delegation = this.store.getGuild(guildId)?.delegation;
    if (delegation?.deviceId !== session.relay.deviceId) return;
    const target = this.findOnlineRelay(guildId, userId);
    if (!target || target.deviceId === session.relay.deviceId) return;

    const request = [...(this.requests.get(guildId)?.values() ?? [])]
      .find((item) => item.deviceId === target.deviceId);
    session.socket.send(JSON.stringify({
      type: "transfer_confirmation",
      requestId: request?.id ?? null,
      userId,
      targetName: target.pairedByUserName ?? target.clientName
    }));
  }

  async confirmTransfer(session, requestId, userId) {
    const guildId = session.relay.guildId;
    const delegation = this.store.getGuild(guildId)?.delegation;
    if (delegation?.deviceId !== session.relay.deviceId) return;
    const target = requestId
      ? this.findRelayByRequest(guildId, requestId)
      : this.findOnlineRelay(guildId, userId);
    if (!target) return;

    if (requestId) {
      this.requests.get(guildId)?.delete(requestId);
      await this.transferTo(guildId, target);
      return;
    }

    const offer = {
      id: randomUUID(),
      guildId,
      fromDeviceId: session.relay.deviceId,
      targetDeviceId: target.deviceId,
      targetUserId: target.pairedByUserId,
      expiresAt: new Date(Date.now() + REQUEST_LIFETIME_MS).toISOString()
    };
    this.offers.set(offer.id, offer);
    this.sendToDevice(guildId, target.deviceId, {
      type: "transfer_offer",
      offerId: offer.id,
      fromName: session.relay.pairedByUserName ?? session.relay.clientName,
      expiresAt: offer.expiresAt
    });
    const timer = setTimeout(() => {
      if (!this.offers.delete(offer.id)) return;
      this.sendToDevice(guildId, offer.fromDeviceId, { type: "transfer_offer_expired", offerId: offer.id });
      this.sendToDevice(guildId, offer.targetDeviceId, { type: "transfer_offer_expired", offerId: offer.id });
      this.broadcastSnapshot(guildId);
    }, REQUEST_LIFETIME_MS);
    timer.unref();
    await this.broadcastSnapshot(guildId);
  }

  async acceptOffer(session, offerId) {
    const offer = this.offers.get(offerId);
    if (!offer || offer.guildId !== session.relay.guildId || offer.targetDeviceId !== session.relay.deviceId) return;
    this.offers.delete(offerId);
    await this.transferTo(offer.guildId, session.relay);
  }

  async declineOffer(session, offerId) {
    const offer = this.offers.get(offerId);
    if (!offer || offer.guildId !== session.relay.guildId || offer.targetDeviceId !== session.relay.deviceId) return;
    this.offers.delete(offerId);
    this.sendToDevice(offer.guildId, offer.fromDeviceId, { type: "transfer_offer_declined", offerId });
    await this.broadcastSnapshot(offer.guildId);
  }

  async transferTo(guildId, relay) {
    const previous = this.store.getGuild(guildId)?.delegation;
    const delegation = await this.store.transferDelegation(guildId, relay);
    if (!delegation) return false;
    this.requests.delete(guildId);
    for (const [id, offer] of this.offers) {
      if (offer.guildId === guildId) this.offers.delete(id);
    }
    if (previous?.deviceId && previous.deviceId !== relay.deviceId) {
      this.sendToDevice(guildId, previous.deviceId, { type: "delegation_revoked", fadeMs: 300 });
    }
    this.sendToDevice(guildId, relay.deviceId, {
      type: "delegation_granted",
      autoStart: true,
      startGraceMs: START_GRACE_MS
    });
    if (previous?.deviceId && previous.deviceId !== relay.deviceId) {
      this.emit("delegationTransferred", guildId, {
        previous,
        current: delegation
      });
    }
    await this.broadcastSnapshot(guildId);

    const timer = setTimeout(async () => {
      const current = this.store.getGuild(guildId)?.delegation;
      if (current?.grantId !== delegation.grantId || this.audioHub.hasActiveAudio(guildId)) return;
      await this.store.clearDelegation(guildId, delegation.grantId);
      await this.broadcastSnapshot(guildId, { type: "start_failed" });
      this.emit("delegationStartFailed", guildId, delegation);
    }, START_GRACE_MS);
    timer.unref();
    return true;
  }

  async releaseDelegation(guildId) {
    if (this.audioHub.hasActiveAudio(guildId)) return { released: false, reason: "audio_active" };
    const released = await this.store.clearDelegation(guildId);
    if (released) {
      await this.broadcastSnapshot(guildId, { type: "delegation_released" });
      this.emit("delegationReleased", guildId);
    }
    return { released, reason: released ? null : "already_free" };
  }

  findOnlineRelay(guildId, userId) {
    return [...(this.sessions.get(guildId) ?? [])]
      .find((session) => session.relay.pairedByUserId === userId)?.relay ?? null;
  }

  findRelayByRequest(guildId, requestId) {
    const request = this.requests.get(guildId)?.get(requestId);
    if (!request) return null;
    return [...(this.sessions.get(guildId) ?? [])]
      .find((session) => session.relay.deviceId === request.deviceId)?.relay ?? null;
  }

  sendToDevice(guildId, deviceId, message) {
    const payload = JSON.stringify(message);
    for (const session of this.sessions.get(guildId) ?? []) {
      if (session.relay.deviceId === deviceId && session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(payload);
      }
    }
  }

  async createSnapshot(guildId, currentDeviceId = null) {
    const voiceParticipants = await this.participantProvider(guildId);
    const guildSessions = [...(this.sessions.get(guildId) ?? [])];
    const requests = [...(this.requests.get(guildId)?.values() ?? [])];
    const delegation = this.store.getGuild(guildId)?.delegation ?? null;
    return {
      type: "jam_snapshot",
      delegation,
      audioActive: this.audioHub.hasActiveAudio(guildId),
      currentDeviceId,
      participants: voiceParticipants.map((participant) => {
        const onlineSession = guildSessions.find(
          (session) => session.relay.pairedByUserId === participant.userId);
        const request = requests.find((item) => item.userId === participant.userId);
        return {
          ...participant,
          online: Boolean(onlineSession),
          deviceId: onlineSession?.relay.deviceId ?? null,
          clientName: onlineSession?.relay.clientName ?? null,
          isOwner: Boolean(delegation && onlineSession?.relay.deviceId === delegation.deviceId),
          requestId: request?.id ?? null,
          requestExpiresAt: request?.expiresAt ?? null
        };
      })
    };
  }

  async sendSnapshot(session) {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(JSON.stringify(
      await this.createSnapshot(session.relay.guildId, session.relay.deviceId)));
  }

  async broadcastSnapshot(guildId, extra = null) {
    for (const session of this.sessions.get(guildId) ?? []) {
      await this.sendSnapshot(session);
      if (extra && session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify(extra));
      }
    }
  }
}
