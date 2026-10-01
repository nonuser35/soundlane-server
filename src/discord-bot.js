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
  TextInputStyle
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
  constructor(config, store, audioHub) {
    this.config = config;
    this.store = store;
    this.audioHub = audioHub;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.connections = new Map();
    this.players = new Map();
    this.publisherStreams = new Map();
    this.playerStates = new Map();
    this.voiceStates = new Map();

    audioHub.on("publisherStarted", (guildId, stream, codec) => this.attachPublisher(guildId, stream, codec));
    audioHub.on("publisherStopped", (guildId) => this.publisherStreams.delete(guildId));
  }

  async start() {
    await this.registerCommands();
    this.client.on(Events.InteractionCreate, (interaction) => this.handleInteraction(interaction).catch(console.error));
    await this.client.login(this.config.discordToken);
    await this.restoreVoiceConnections();
  }

  async registerCommands() {
    const commands = [
      new SlashCommandBuilder().setName("join").setDescription("Coloca o bot no seu canal de voz"),
      new SlashCommandBuilder().setName("leave").setDescription("Remove o bot do canal de voz"),
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
    return [
      { name: "Aplicativo", value: guild ? `Conectado: ${guild.clientName}` : "Nao conectado", inline: true },
      { name: "Transmissao", value: this.audioHub.isLive(guildId) ? "Ativa" : "Em espera", inline: true },
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
    const description = guild
      ? `Computador conectado: **${guild.clientName}**\nVinculado por **${guild.pairedByUserName}**.`
      : "Nenhum programa esta conectado. Baixe o programa, gere um codigo e insira-o aqui.";
    return {
      embeds: [new EmbedBuilder().setTitle("Conexao do programa").setDescription(description).setColor(0x10975b)],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("relay:add-code").setLabel("Adicionar ou trocar codigo").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("relay:remove-code").setLabel("Remover codigo").setStyle(ButtonStyle.Danger).setDisabled(!guild),
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
        .setDescription("`/join` entra no seu canal.\n`/leave` sai do canal.\n`/help` abre este painel.\n\nA conexao e os codigos ficam em **Gerenciar conexao**.")
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
        .setDescription("O computador atual perdera o acesso. Qualquer membro podera adicionar outro codigo depois.")
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
    this.audioHub.disconnectGuild(interaction.guildId);
    return interaction.editReply({ content: "Conexao salva.", ...this.mainPanel(interaction.guildId) });
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
    const connection = this.createVoiceConnection(interaction.guild, channel.id);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      connection.destroy();
      this.connections.delete(interaction.guildId);
      console.error("Falha ao conectar ao canal de voz:", error);
      return interaction.editReply({ content: "Nao consegui concluir a conexao de voz. Tente /join novamente." });
    }
    await this.store.setGuildVoiceChannel(interaction.guildId, channel.id);
    const player = this.getPlayer(interaction.guildId);
    connection.subscribe(player);
    if (player.state.status === AudioPlayerStatus.Idle && this.audioHub.isLive(interaction.guildId)) {
      this.audioHub.requestPublisherReconnect(interaction.guildId);
    }
    const payload = this.mainPanel(interaction.guildId);
    return interaction.editReply(payload);
  }

  async leave(interaction) {
    this.connections.get(interaction.guildId)?.destroy();
    this.connections.delete(interaction.guildId);
    await this.store.setGuildVoiceChannel(interaction.guildId, null);
    const payload = this.mainPanel(interaction.guildId);
    return interaction.isButton() ? interaction.update(payload) : interaction.reply({ ...ephemeral, ...payload });
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
    this.connections.get(guild.id)?.destroy();
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
