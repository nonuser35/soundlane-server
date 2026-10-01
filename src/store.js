import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state.guilds ??= {};
      this.state.extensions ??= {};
      this.state.audit ??= [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2));
    await rename(temporaryPath, this.filePath);
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
    await this.save();
    return record;
  }

  async completeExtensionPairing(code, extensionId) {
    this.prunePairings();
    const pairing = [...this.pairings.values()].find(
      (item) => item.status === "pending" && item.code === code.trim().toUpperCase());
    if (!pairing) return null;

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
    await this.save();
    return { ...record, listenerToken };
  }

  async removeGuild(guildId, user) {
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

  resolveListenerCredential(credential) {
    const normalized = credential.trim();
    const legacyGuild = Object.values(this.state.guilds).find(
      (guild) => guild.listenerCode === normalized.toUpperCase());
    if (legacyGuild) return legacyGuild;
    const tokenHash = hashToken(normalized);
    return Object.values(this.state.extensions).find(
      (extension) => extension.listenerTokenHash === tokenHash) ?? null;
  }

  async removeExtension(listenerToken) {
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
