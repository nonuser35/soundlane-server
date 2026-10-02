import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown
} from "discord.js";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel
} from "@discordjs/voice";

const ephemeral = { flags: MessageFlags.Ephemeral };

export class DiscordRelayBot {
  constructor(config, store, audioHub, jamControlHub = null) {
    this.config = config;
    this.store = store;
    this.audioHub = audioHub;
    this.jamControlHub = jamControlHub;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.connections = new Map();
    this.players = new Map();
    this.publisherStreams = new Map();
    this.playerStates = new Map();
    this.voiceStates = new Map();
    this.busyNotifications = new Map();

    audioHub.on("publisherStarted", (guildId, stream, codec) => this.attachPublisher(guildId, stream, codec));
    audioHub.on("publisherStopped", (guildId) => this.publisherStreams.delete(guildId));
    audioHub.on("publisherRejected", (guildId, contender, active) => {
      this.notifyJamBusy(guildId, contender, active).catch(console.error);
    });
    jamControlHub?.on("delegationTransferred", (guildId, event) => {
      const name = event.current.pairedByUserName ?? event.current.clientName ?? "Outro participante";
      this.sendJamNotice(guildId, `**${escapeMarkdown(name)}** assumiu a transmissao.`).catch(console.error);
    });
    jamControlHub?.on("delegationReleased", (guildId) => {
      this.sendJamNotice(guildId, "A jam foi liberada e esta disponivel.").catch(console.error);
    });
    jamControlHub?.on("delegationStartFailed", (guildId, delegation) => {
      const name = delegation.pairedByUserName ?? delegation.clientName ?? "O participante";
      this.sendJamNotice(
        guildId,
        `**${escapeMarkdown(name)}** nao iniciou o audio em 10 segundos. A jam foi liberada.`
      ).catch(console.error);
    });
  }

  async start() {
    await this.registerCommands();
    this.client.on(Events.InteractionCreate, (interaction) => this.handleInteraction(interaction).catch(console.error));
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      const guildId = after.guild.id || before.guild.id;
      this.jamControlHub?.broadcastSnapshot(guildId).catch(console.error);
    });
    await this.client.login(this.config.discordToken);
    await this.restoreVoiceConnections();
  }

  async registerCommands() {
    const commands = [
      new SlashCommandBuilder().setName("join").setDescription("Coloca o bot no seu canal de voz"),
      new SlashCommandBuilder().setName("leave").setDescription("Remove o bot do canal de voz"),
      new SlashCommandBuilder().setName("release").setDescription("Libera uma delegacao sem audio"),
      new SlashCommandBuilder().setName("help").setDescription("Abre o painel de audio")
    ].map((command) => command.toJSON());
    const rest = new REST({ version: "10" }).setToken(this.config.discordToken);
    await rest.put(Routes.applicationCommands(this.config.discordClientId), { body: commands });
  }

  async handleInteraction(interaction) {
    if (!interaction.inGuild()) return;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "join") return this.join(interaction);
      if (interaction.commandName === "leave") return this.leave(interaction);
      if (interaction.commandName === "release") return this.release(interaction);
      return interaction.reply({ ...ephemeral, ...this.mainPanel(interaction.guildId) });
    }

    if (interaction.isModalSubmit() && interaction.customId === "relay:pairing-modal") {
      return this.savePairing(interaction);
    }

    if (!interaction.isButton()) return;
    switch (interaction.customId) {
      case "relay:join": return this.join(interaction);
      case "relay:leave": return this.leave(interaction);
      case "relay:main": return interaction.update(this.mainPanel(interaction.guildId));
      case "relay:connection": return interaction.update(this.connectionPanel(interaction.guildId));
      case "relay:listen": return interaction.update(this.listenerPanel(interaction.guildId));
      case "relay:help": return interaction.update(this.helpPanel());
      case "relay:add-code": return interaction.showModal(this.pairingModal());
      case "relay:remove-code": return interaction.update(this.removeConfirmation(interaction.guildId));
      case "relay:confirm-remove": return this.removePairing(interaction);
      default: return interaction.update(this.mainPanel(interaction.guildId));
    }
  }

  statusFields(guildId) {
    const guild = this.store.getGuild(guildId);
    const connection = this.connections.get(guildId);
    const devices = this.store.getGuildDevices(guildId);
    const active = this.audioHub.activePublisher(guildId);
    return [
      { name: "Computadores salvos", value: guild ? `${devices.length}` : "Nenhum", inline: true },
      {
        name: "Jam agora",
        value: active
          ? `**${escapeMarkdown(active.clientName)}**${active.pairedByUserName ? ` (${escapeMarkdown(active.pairedByUserName)})` : ""}`
          : "Livre",
        inline: true
      },
      { name: "Canal", value: connection?.joinConfig.channelId ? `<#${connection.joinConfig.channelId}>` : "Fora do canal", inline: true },
      { name: "Extensao", value: `${this.audioHub.listenerCount(guildId)} ouvinte(s)`, inline: true }
    ];
  }

  mainPanel(guildId) {
    const embed = new EmbedBuilder()
      .setTitle("Painel de audio")
      .setDescription("Controle a transmissao e a conexao do programa.")
      .setColor(0x10975b)
      .addFields(this.statusFields(guildId));
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("relay:join").setLabel("Entrar").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("relay:leave").setLabel("Sair").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("relay:connection").setLabel("Gerenciar conexao").setStyle(ButtonStyle.Primary)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("relay:listen").setLabel("Ouvir pela extensao").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setLabel("Baixar programa").setStyle(ButtonStyle.Link).setURL(this.config.downloadUrl),
          new ButtonBuilder().setCustomId("relay:help").setLabel("Ajuda").setStyle(ButtonStyle.Secondary)
        )
      ]
    };
  }

  connectionPanel(guildId) {
    const guild = this.store.getGuild(guildId);
    const devices = this.store.getGuildDevices(guildId);
    const deviceList = devices.slice(0, 10).map((device) =>
      `• **${escapeMarkdown(device.clientName ?? "Computador Windows")}** — adicionado por ${escapeMarkdown(device.pairedByUserName ?? "membro")}`
    ).join("\n");
    const description = guild
      ? `${deviceList || "Nenhum computador salvo."}\n\nO primeiro que iniciar a transmissao assume a jam; os demais aguardam.`
      : "Nenhum programa esta salvo. Baixe o programa, gere um codigo e insira-o aqui uma unica vez.";
    return {
      embeds: [new EmbedBuilder().setTitle("Conexao do programa").setDescription(description).setColor(0x10975b)],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("relay:add-code").setLabel("Adicionar computador").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("relay:remove-code").setLabel("Remover todos").setStyle(ButtonStyle.Danger).setDisabled(!guild),
          new ButtonBuilder().setCustomId("relay:main").setLabel("Voltar").setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Baixar programa").setStyle(ButtonStyle.Link).setURL(this.config.downloadUrl)
        )
      ]
    };
  }

  listenerPanel(guildId) {
    const guild = this.store.getGuild(guildId);
    const description = guild
      ? `Abra a extensao, selecione **Ouvir transmissao** e informe:\n\n**${guild.listenerCode}**\n\nO audio comeca depois de clicar em Ouvir.`
      : "Conecte primeiro um programa Windows para criar a sessao de escuta.";
    return {
      embeds: [new EmbedBuilder().setTitle("Ouvir pela extensao").setDescription(description).setColor(0x10975b)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("relay:main").setLabel("Voltar").setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  helpPanel() {
    return {
      embeds: [new EmbedBuilder()
        .setTitle("Ajuda")
        .setDescription("`/join` entra no seu canal.\n`/leave` sai do canal.\n`/release` libera uma delegacao que esteja sem audio.\n`/help` abre este painel.\n\nCada computador e adicionado apenas uma vez em **Gerenciar conexao**. O primeiro a transmitir assume a jam; os demais podem pedir a vez.")
        .setColor(0x10975b)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("relay:main").setLabel("Voltar").setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  pairingModal() {
    return new ModalBuilder()
      .setCustomId("relay:pairing-modal")
      .setTitle("Conectar programa")
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("code")
          .setLabel("Codigo gerado no programa")
          .setPlaceholder("ABC123")
          .setMinLength(6)
          .setMaxLength(8)
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
      ));
  }

  removeConfirmation(guildId) {
    return {
      embeds: [new EmbedBuilder()
        .setTitle("Remover conexao?")
        .setDescription("Todos os computadores salvos perderao o acesso. Qualquer membro podera adiciona-los novamente depois.")
        .setColor(0xc83f32)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("relay:confirm-remove").setLabel("Salvar remocao").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("relay:connection").setLabel("Voltar").setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  async savePairing(interaction) {
    const code = interaction.fields.getTextInputValue("code");
    await interaction.deferReply(ephemeral);

    let record;
    try {
      record = await this.store.completePairing(code, interaction.guild, interaction.user);
    } catch (error) {
      console.error("Falha ao salvar pareamento:", error);
      return interaction.editReply({
        content: "Nao foi possivel consultar o armazenamento agora. Tente novamente em alguns instantes."
      });
    }

    if (!record) {
      return interaction.editReply({ content: "Codigo invalido ou expirado. Gere outro no programa e tente novamente." });
    }
    await this.store.setGuildNotificationChannel(interaction.guildId, interaction.channelId);
    return interaction.editReply({
      content: `Computador salvo. Agora existem ${this.store.getGuildDevices(interaction.guildId).length} dispositivo(s) nesta jam.`,
      ...this.mainPanel(interaction.guildId)
    });
  }

  async removePairing(interaction) {
    await this.store.removeGuild(interaction.guildId, interaction.user);
    this.audioHub.disconnectGuild(interaction.guildId);
    this.connections.get(interaction.guildId)?.destroy();
    this.connections.delete(interaction.guildId);
    return interaction.update(this.connectionPanel(interaction.guildId));
  }

  async join(interaction) {
    if (!this.store.getGuild(interaction.guildId)) {
      const payload = this.connectionPanel(interaction.guildId);
      return interaction.isButton() ? interaction.update(payload) : interaction.reply({ ...ephemeral, ...payload });
    }
    const channel = interaction.member?.voice?.channel;
    if (!channel) {
      const payload = { content: "Entre em um canal de voz primeiro." };
      return interaction.isButton() ? interaction.reply({ ...ephemeral, ...payload }) : interaction.reply({ ...ephemeral, ...payload });
    }
    await interaction.deferReply(ephemeral);
    const active = this.audioHub.activePublisher(interaction.guildId);
    const currentChannelId = this.connections.get(interaction.guildId)?.joinConfig.channelId;
    if (active && currentChannelId && currentChannelId !== channel.id) {
      return interaction.editReply({
        content: `A jam esta sendo usada por **${escapeMarkdown(active.clientName)}** em <#${currentChannelId}>. Aguarde a transmissao terminar.`
      });
    }
    const connection = this.createVoiceConnection(interaction.guild, channel.id);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      connection.destroy();
      this.connections.delete(interaction.guildId);
      console.error("Falha ao conectar ao canal de voz:", error);
      return interaction.editReply({ content: "Nao consegui concluir a conexao de voz. Tente /join novamente." });
    }
    await this.store.setGuildVoiceChannel(interaction.guildId, channel.id, channel.name);
    await this.store.setGuildNotificationChannel(interaction.guildId, interaction.channelId);
    const player = this.getPlayer(interaction.guildId);
    connection.subscribe(player);
    await this.jamControlHub?.broadcastSnapshot(interaction.guildId);
    if (player.state.status === AudioPlayerStatus.Idle && this.audioHub.isLive(interaction.guildId)) {
      this.audioHub.requestPublisherReconnect(interaction.guildId);
    }
    const payload = this.mainPanel(interaction.guildId);
    return interaction.editReply(payload);
  }

  async notifyJamBusy(guildId, contender, active) {
    const key = `${guildId}:${contender.deviceId ?? contender.clientName}`;
    const now = Date.now();
    if (now - (this.busyNotifications.get(key) ?? 0) < 15_000) return;
    this.busyNotifications.set(key, now);

    const guildRecord = this.store.getGuild(guildId);
    const channelId = guildRecord?.notificationChannelId;
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const voiceChannelId = this.connections.get(guildId)?.joinConfig.channelId;
    await channel.send(
      `A jam${voiceChannelId ? ` em <#${voiceChannelId}>` : ""} ja esta sendo usada por **${escapeMarkdown(active.clientName ?? "outro participante")}**` +
      `${active.pairedByUserName || active.userName ? `, cadastrado por **${escapeMarkdown(active.pairedByUserName ?? active.userName)}**` : ""}. ` +
      `**${escapeMarkdown(contender.clientName ?? "Outro computador")}** tentou entrar e deve aguardar a transmissao terminar.`
    );
  }

  async sendJamNotice(guildId, content) {
    const channelId = this.store.getGuild(guildId)?.notificationChannelId;
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) await channel.send(content);
  }

  async leave(interaction) {
    this.connections.get(interaction.guildId)?.destroy();
    this.connections.delete(interaction.guildId);
    await this.store.setGuildVoiceChannel(interaction.guildId, null, null);
    await this.jamControlHub?.broadcastSnapshot(interaction.guildId);
    const payload = this.mainPanel(interaction.guildId);
    return interaction.isButton() ? interaction.update(payload) : interaction.reply({ ...ephemeral, ...payload });
  }

  async release(interaction) {
    if (!this.store.getGuild(interaction.guildId)) {
      return interaction.reply({ ...ephemeral, content: "Nenhuma jam configurada neste servidor." });
    }
    const result = await this.jamControlHub?.releaseDelegation(interaction.guildId);
    if (result?.reason === "audio_active") {
      return interaction.reply({
        ...ephemeral,
        content: "A delegacao nao pode ser removida enquanto existe audio sendo transmitido."
      });
    }
    return interaction.reply({
      ...ephemeral,
      content: result?.released ? "Delegacao liberada. A jam esta livre." : "A jam ja estava livre."
    });
  }

  async getVoiceParticipants(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    const channelId = this.connections.get(guildId)?.joinConfig.channelId ??
      this.store.getGuild(guildId)?.voiceChannelId;
    const channel = guild?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => ({
        userId: member.id,
        name: member.displayName || member.user.globalName || member.user.username,
        userName: member.user.username,
        avatarUrl: member.displayAvatarURL({ extension: "png", size: 64 })
      }));
  }

  getGuildStatus(guildId) {
    const connection = this.connections.get(guildId);
    const channelId = connection?.joinConfig.channelId ?? null;
    const channel = this.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    return {
      botConnected: Boolean(connection && channelId),
      voiceChannelId: channelId,
      voiceChannelName: channel?.name ?? null
    };
  }

  async preparePublisher(relay) {
    const guild = this.client.guilds.cache.get(relay.guildId);
    if (!guild) {
      return {
        ok: false,
        type: "voice_unavailable",
        message: "O bot nao encontrou o servidor vinculado. Abra /help no Discord."
      };
    }
    const channel = guild.voiceStates.cache.get(relay.pairedByUserId)?.channel;
    if (!channel?.isVoiceBased()) {
      return {
        ok: false,
        type: "voice_required",
        message: "Entre em uma call do Discord e clique em Iniciar transmissao novamente."
      };
    }

    const connection = this.createVoiceConnection(guild, channel.id);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      console.error("Falha no autojoin do bot:", error);
      connection.destroy();
      this.connections.delete(guild.id);
      return {
        ok: false,
        type: "voice_unavailable",
        message: "Nao consegui entrar na sua call. Confira as permissoes do bot e tente novamente."
      };
    }
    connection.subscribe(this.getPlayer(guild.id));
    await this.store.setGuildVoiceChannel(guild.id, channel.id, channel.name);
    await this.jamControlHub?.broadcastSnapshot(guild.id);
    return { ok: true, channelId: channel.id, channelName: channel.name };
  }

  async restoreVoiceConnections() {
    for (const guildRecord of Object.values(this.store.state.guilds)) {
      if (!guildRecord.voiceChannelId) continue;
      const guild = this.client.guilds.cache.get(guildRecord.guildId);
      const channel = guild?.channels.cache.get(guildRecord.voiceChannelId);
      if (!guild || !channel?.isVoiceBased()) continue;
      try {
        const connection = this.createVoiceConnection(guild, channel.id);
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        connection.subscribe(this.getPlayer(guild.id));
        console.log(`Conexao de voz restaurada para ${guild.name}.`);
      } catch (error) {
        console.error(`Falha ao restaurar voz em ${guildRecord.guildId}:`, error);
      }
    }
  }

  createVoiceConnection(guild, channelId) {
    const existing = this.connections.get(guild.id);
    if (existing?.joinConfig.channelId === channelId &&
        existing.state.status !== VoiceConnectionStatus.Destroyed) {
      return existing;
    }
    existing?.destroy();
    const connection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true
    });
    this.connections.set(guild.id, connection);
    connection.on("stateChange", (_, state) => {
      this.voiceStates.set(guild.id, state.status);
      console.log(`Conexao de voz: ${state.status}`);
      if (state.status === VoiceConnectionStatus.Destroyed && this.connections.get(guild.id) === connection) {
        this.connections.delete(guild.id);
      }
    });
    return connection;
  }

  getPlayer(guildId) {
    let player = this.players.get(guildId);
    if (!player) {
      player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
          maxMissedFrames: 100
        }
      });
      player.on("error", (error) => console.error(`Audio ${guildId}:`, error));
      player.on("stateChange", (previousState, state) => {
        this.playerStates.set(guildId, state.status);
        console.log(`Player de audio: ${state.status}`);
        if (previousState.status !== AudioPlayerStatus.Idle &&
            state.status === AudioPlayerStatus.Idle &&
            this.audioHub.isLive(guildId)) {
          console.warn(`Player ${guildId} ficou ocioso; solicitando reconexao do fluxo.`);
          this.audioHub.requestPublisherReconnect(guildId);
        }
      });
      this.players.set(guildId, player);
    }
    return player;
  }

  attachPublisher(guildId, stream, codec = "pcm-f32") {
    this.publisherStreams.set(guildId, stream);
    const player = this.getPlayer(guildId);
    const resource = createAudioResource(stream, {
      inputType: codec === "opus" ? StreamType.Opus : StreamType.Raw
    });
    player.play(resource);
    if (player.state.status === AudioPlayerStatus.Idle) console.warn(`Player ${guildId} permaneceu ocioso.`);
  }

  diagnostics() {
    return {
      voiceConnections: this.connections.size,
      voiceStates: [...this.voiceStates.values()],
      playerStates: [...this.playerStates.values()],
      publisherStreams: this.publisherStreams.size
    };
  }
}
