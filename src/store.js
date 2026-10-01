import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Redis } from "@upstash/redis";

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export class RelayStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { guilds: {}, extensions: {}, audit: [] };
    this.pairings = new Map();
    this.redis = null;
    this.redisKey = process.env.UPSTASH_REDIS_KEY || "soundlane:relay-state:v1";
    this.keepAliveTimer = null;

    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (Boolean(redisUrl) !== Boolean(redisToken)) {
      throw new Error("Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN juntos.");
    }
    if (redisUrl && redisToken) {
      this.redis = new Redis({ url: redisUrl, token: redisToken });
    }
  }

  async load() {
    if (this.redis) {
      await this.refreshRemoteState();
      this.keepAliveTimer = setInterval(() => {
        this.redis.get(this.redisKey).catch((error) => {
          console.error("Falha no keep-alive do Upstash:", error);
        });
      }, 24 * 60 * 60 * 1000);
      this.keepAliveTimer.unref();
      console.log("Estado persistente carregado do Upstash.");
      return;
    }

    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8"));
      this.normalizeState();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async save() {
    if (this.redis) {
      await this.redis.set(this.redisKey, JSON.stringify(this.state));
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2));
    await rename(temporaryPath, this.filePath);
  }

  normalizeState() {
    this.state.guilds ??= {};
    this.state.extensions ??= {};
    this.state.audit ??= [];
  }

  async refreshRemoteState() {
    if (!this.redis) return;
    const storedState = await this.redis.get(this.redisKey);
    this.state = storedState
      ? (typeof storedState === "string" ? JSON.parse(storedState) : storedState)
      : { guilds: {}, extensions: {}, audit: [] };
    this.normalizeState();
  }

  createPairing(client, inviteUrl) {
    this.prunePairings();
    let code;
    do code = randomCode(6); while ([...this.pairings.values()].some((item) => item.code === code));

    const pairing = {
      pairingId: randomUUID(),
      code,
      clientName: client.clientName || "Computador Windows",
      deviceId: client.deviceId,
      expiresAt: new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString(),
      inviteUrl,
      status: "pending"
    };
    this.pairings.set(pairing.pairingId, pairing);
    return pairing;
  }

  getPairing(pairingId) {
    this.prunePairings();
    return this.pairings.get(pairingId) ?? null;
  }

  async completePairing(code, guild, user) {
    this.prunePairings();
    const pairing = [...this.pairings.values()].find(
      (item) => item.status === "pending" && item.code === code.trim().toUpperCase());
    if (!pairing) return null;

    await this.refreshRemoteState();

    const accessToken = randomBytes(32).toString("base64url");
    const previous = this.state.guilds[guild.id];
    const record = {
      guildId: guild.id,
      guildName: guild.name,
      clientName: pairing.clientName,
      deviceId: pairing.deviceId,
      accessTokenHash: hashToken(accessToken),
      listenerCode: previous?.listenerCode ?? randomCode(8),
      pairedByUserId: user.id,
      pairedByUserName: user.username,
      pairedAt: new Date().toISOString()
    };
    this.state.guilds[guild.id] = record;
    this.addAudit({
      action: previous ? "pairing_replaced" : "pairing_added",
      guildId: guild.id,
      userId: user.id,
      userName: user.username,
      clientName: pairing.clientName
    });
    pairing.status = "paired";
    pairing.accessToken = accessToken;
    pairing.guildName = guild.name;
    pairing.discordUserName = user.username;
    pairing.destinationType = "discord";
    await this.save();
    return record;
  }

  async completeExtensionPairing(code, extensionId) {
    this.prunePairings();
    const pairing = [...this.pairings.values()].find(
      (item) => item.status === "pending" && item.code === code.trim().toUpperCase());
    if (!pairing) return null;

    await this.refreshRemoteState();

    const accessToken = randomBytes(32).toString("base64url");
    const listenerToken = randomBytes(32).toString("base64url");
    const relayId = randomUUID();
    const record = {
      relayId,
      relayName: "Extensao do navegador",
      clientName: pairing.clientName,
      deviceId: pairing.deviceId,
      extensionId,
      accessTokenHash: hashToken(accessToken),
      listenerTokenHash: hashToken(listenerToken),
      pairedAt: new Date().toISOString()
    };
    this.state.extensions[relayId] = record;
    this.addAudit({ action: "extension_pairing_added", relayId, clientName: pairing.clientName });
    pairing.status = "paired";
    pairing.accessToken = accessToken;
    pairing.guildName = record.relayName;
    pairing.destinationType = "extension";
    await this.save();
    return { ...record, listenerToken };
  }

  async removeGuild(guildId, user) {
    await this.refreshRemoteState();
    if (!this.state.guilds[guildId]) return false;
    const previous = this.state.guilds[guildId];
    delete this.state.guilds[guildId];
    this.addAudit({
      action: "pairing_removed",
      guildId,
      userId: user?.id,
      userName: user?.username,
      clientName: previous.clientName
    });
    await this.save();
    return true;
  }

  getGuild(guildId) {
    return this.state.guilds[guildId] ?? null;
  }

  resolveAccessToken(token) {
    const tokenHash = hashToken(token);
    return Object.values(this.state.guilds).find((guild) => guild.accessTokenHash === tokenHash)
      ?? Object.values(this.state.extensions).find((extension) => extension.accessTokenHash === tokenHash)
      ?? null;
  }

  async resolveAccessTokenFresh(token) {
    await this.refreshRemoteState();
    return this.resolveAccessToken(token);
  }

  resolveListenerCredential(credential) {
    const normalized = credential.trim();
    const legacyGuild = Object.values(this.state.guilds).find(
      (guild) => guild.listenerCode === normalized.toUpperCase());
    if (legacyGuild) return legacyGuild;
    const tokenHash = hashToken(normalized);
    return Object.values(this.state.extensions).find(
      (extension) => extension.listenerTokenHash === tokenHash) ?? null;
  }

  async resolveListenerCredentialFresh(credential) {
    await this.refreshRemoteState();
    return this.resolveListenerCredential(credential);
  }

  async removeExtension(listenerToken) {
    await this.refreshRemoteState();
    const record = this.resolveListenerCredential(listenerToken);
    if (!record?.relayId || !this.state.extensions[record.relayId]) return null;
    delete this.state.extensions[record.relayId];
    this.addAudit({ action: "extension_pairing_removed", relayId: record.relayId });
    await this.save();
    return record;
  }

  addAudit(entry) {
    this.state.audit.push({ ...entry, at: new Date().toISOString() });
    if (this.state.audit.length > 500) {
      this.state.audit.splice(0, this.state.audit.length - 500);
    }
  }

  prunePairings() {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) {
      if (new Date(pairing.expiresAt).getTime() <= now && pairing.status === "pending") {
        pairing.status = "expired";
      }
      if (new Date(pairing.expiresAt).getTime() + PAIRING_LIFETIME_MS <= now) {
        this.pairings.delete(id);
      }
    }
  }
}

export { hashToken };
