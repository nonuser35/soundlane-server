import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Redis } from "@upstash/redis";

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const PAIRING_CODE_LIFETIME_SECONDS = PAIRING_LIFETIME_MS / 1000;
const PAIRING_RESULT_LIFETIME_SECONDS = 20 * 60;
const STATE_LOCK_LIFETIME_MS = 10_000;

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
    this.lockKey = `${this.redisKey}:lock`;
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

  pairingIdKey(pairingId) {
    return `${this.redisKey}:pairing:id:${pairingId}`;
  }

  pairingCodeKey(code) {
    return `${this.redisKey}:pairing:code:${code}`;
  }

  async withStateMutation(mutate) {
    if (!this.redis) {
      const result = await mutate();
      await this.save();
      return result;
    }

    const lockToken = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      acquired = Boolean(await this.redis.set(this.lockKey, lockToken, {
        nx: true,
        px: STATE_LOCK_LIFETIME_MS
      }));
      if (acquired) break;
      await new Promise((resolve) => setTimeout(resolve, 75 + Math.floor(Math.random() * 75)));
    }
    if (!acquired) throw new Error("Nao foi possivel bloquear o estado persistente.");

    try {
      await this.refreshRemoteState();
      const result = await mutate();
      await this.save();
      return result;
    } finally {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [this.lockKey],
        [lockToken]
      ).catch((error) => console.error("Falha ao liberar lock do Upstash:", error));
    }
  }

  async createPairing(client, inviteUrl) {
    this.prunePairings();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pairing = {
        pairingId: randomUUID(),
        code: randomCode(6),
        clientName: client.clientName || "Computador Windows",
        deviceId: client.deviceId,
        expiresAt: new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString(),
        inviteUrl,
        status: "pending"
      };

      if (!this.redis) {
        if ([...this.pairings.values()].some((item) => item.code === pairing.code)) continue;
        this.pairings.set(pairing.pairingId, pairing);
        return pairing;
      }

      const claimed = await this.redis.set(this.pairingCodeKey(pairing.code), pairing, {
        nx: true,
        ex: PAIRING_CODE_LIFETIME_SECONDS
      });
      if (!claimed) continue;
      await this.redis.set(this.pairingIdKey(pairing.pairingId), pairing, {
        ex: PAIRING_RESULT_LIFETIME_SECONDS
      });
      return pairing;
    }
    throw new Error("Nao foi possivel gerar um codigo exclusivo.");
  }

  async getPairing(pairingId) {
    if (this.redis) return await this.redis.get(this.pairingIdKey(pairingId));
    this.prunePairings();
    return this.pairings.get(pairingId) ?? null;
  }

  async claimPairing(code) {
    const normalizedCode = code.trim().toUpperCase();
    if (this.redis) {
      const pairing = await this.redis.getdel(this.pairingCodeKey(normalizedCode));
      if (pairing && new Date(pairing.expiresAt).getTime() <= Date.now()) {
        pairing.status = "expired";
        await this.finishPairing(pairing);
        return null;
      }
      return pairing;
    }

    this.prunePairings();
    const pairing = [...this.pairings.values()].find(
      (item) => item.status === "pending" && item.code === normalizedCode);
    if (pairing) pairing.status = "redeeming";
    return pairing ?? null;
  }

  async finishPairing(pairing) {
    if (this.redis) {
      await this.redis.set(this.pairingIdKey(pairing.pairingId), pairing, {
        ex: PAIRING_RESULT_LIFETIME_SECONDS
      });
    } else {
      this.pairings.set(pairing.pairingId, pairing);
    }
  }

  async restorePairing(pairing) {
    pairing.status = "pending";
    if (this.redis) {
      await Promise.all([
        this.redis.set(this.pairingCodeKey(pairing.code), pairing, {
          nx: true,
          ex: Math.max(1, Math.ceil((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000))
        }),
        this.redis.set(this.pairingIdKey(pairing.pairingId), pairing, {
          ex: PAIRING_RESULT_LIFETIME_SECONDS
        })
      ]);
    }
  }

  async completePairing(code, guild, user) {
    const pairing = await this.claimPairing(code);
    if (!pairing) return null;
    try {
      const accessToken = randomBytes(32).toString("base64url");
      const record = await this.withStateMutation(() => {
        const previous = this.state.guilds[guild.id];
        const devices = { ...(previous?.devices ?? {}) };
        if (previous?.accessTokenHash && previous.deviceId && !devices[previous.deviceId]) {
          devices[previous.deviceId] = {
            deviceId: previous.deviceId,
            clientName: previous.clientName,
            accessTokenHash: previous.accessTokenHash,
            pairedByUserId: previous.pairedByUserId,
            pairedByUserName: previous.pairedByUserName,
            pairedAt: previous.pairedAt
          };
        }
        const existingDevice = devices[pairing.deviceId];
        devices[pairing.deviceId] = {
          deviceId: pairing.deviceId,
          clientName: pairing.clientName,
          accessTokenHash: hashToken(accessToken),
          pairedByUserId: user.id,
          pairedByUserName: user.username,
          pairedAt: new Date().toISOString()
        };
        const next = {
          ...previous,
          guildId: guild.id,
          guildName: guild.name,
          listenerCode: previous?.listenerCode ?? randomCode(8),
          voiceChannelId: previous?.voiceChannelId ?? null,
          notificationChannelId: previous?.notificationChannelId ?? null,
          devices
        };
        delete next.clientName;
        delete next.deviceId;
        delete next.accessTokenHash;
        delete next.pairedByUserId;
        delete next.pairedByUserName;
        delete next.pairedAt;
        this.state.guilds[guild.id] = next;
        this.addAudit({
          action: existingDevice ? "device_reconnected" : "device_added",
          guildId: guild.id,
          deviceId: pairing.deviceId,
          userId: user.id,
          userName: user.username,
          clientName: pairing.clientName
        });
        return next;
      });
      Object.assign(pairing, {
        status: "paired",
        accessToken,
        guildName: guild.name,
        discordUserName: user.username,
        destinationType: "discord"
      });
      await this.finishPairing(pairing);
      return record;
    } catch (error) {
      await this.restorePairing(pairing).catch(console.error);
      throw error;
    }
  }

  async completeExtensionPairing(code, extensionId) {
    const pairing = await this.claimPairing(code);
    if (!pairing) return null;
    try {
      const accessToken = randomBytes(32).toString("base64url");
      const listenerToken = randomBytes(32).toString("base64url");
      const relayId = randomUUID();
      const record = await this.withStateMutation(() => {
        const next = {
          relayId,
          relayName: "Extensao do navegador",
          clientName: pairing.clientName,
          deviceId: pairing.deviceId,
          extensionId,
          accessTokenHash: hashToken(accessToken),
          listenerTokenHash: hashToken(listenerToken),
          pairedAt: new Date().toISOString()
        };
        this.state.extensions[relayId] = next;
        this.addAudit({ action: "extension_pairing_added", relayId, clientName: pairing.clientName });
        return next;
      });
      Object.assign(pairing, {
        status: "paired",
        accessToken,
        guildName: record.relayName,
        destinationType: "extension"
      });
      await this.finishPairing(pairing);
      return { ...record, listenerToken };
    } catch (error) {
      await this.restorePairing(pairing).catch(console.error);
      throw error;
    }
  }

  async removeGuild(guildId, user) {
    return await this.withStateMutation(() => {
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
      return true;
    });
  }

  async setGuildVoiceChannel(guildId, voiceChannelId) {
    return await this.withStateMutation(() => {
      const guild = this.state.guilds[guildId];
      if (!guild) return false;
      guild.voiceChannelId = voiceChannelId;
      return true;
    });
  }

  async setGuildNotificationChannel(guildId, notificationChannelId) {
    return await this.withStateMutation(() => {
      const guild = this.state.guilds[guildId];
      if (!guild) return false;
      guild.notificationChannelId = notificationChannelId;
      return true;
    });
  }

  getGuild(guildId) {
    return this.state.guilds[guildId] ?? null;
  }

  getGuildDevices(guildId) {
    const guild = this.getGuild(guildId);
    if (!guild) return [];
    const devices = Object.values(guild.devices ?? {});
    if (devices.length === 0 && guild.accessTokenHash) {
      devices.push({
        deviceId: guild.deviceId ?? "legacy",
        clientName: guild.clientName ?? "Computador Windows",
        accessTokenHash: guild.accessTokenHash,
        pairedByUserName: guild.pairedByUserName,
        pairedAt: guild.pairedAt
      });
    }
    return devices;
  }

  resolveAccessToken(token) {
    const tokenHash = hashToken(token);
    for (const guild of Object.values(this.state.guilds)) {
      if (guild.accessTokenHash === tokenHash) return guild;
      const device = Object.values(guild.devices ?? {}).find(
        (candidate) => candidate.accessTokenHash === tokenHash);
      if (device) return { ...guild, ...device };
    }
    return Object.values(this.state.extensions).find(
      (extension) => extension.accessTokenHash === tokenHash) ?? null;
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
    return await this.withStateMutation(() => {
      const record = this.resolveListenerCredential(listenerToken);
      if (!record?.relayId || !this.state.extensions[record.relayId]) return null;
      delete this.state.extensions[record.relayId];
      this.addAudit({ action: "extension_pairing_removed", relayId: record.relayId });
      return record;
    });
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
