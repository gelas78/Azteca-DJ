import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder,
} from 'discord.js';

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';

import play from 'play-dl';

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// guildId -> { songs, player, connection, playing, loop, shuffle }
const state = new Map();

function getState(guildId) {
  if (!state.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    player.on('error', (err) => console.error('[PLAYER ERROR]', err?.message ?? err));
    player.on('stateChange', (o, n) => console.log(`[PLAYER] ${o.status} -> ${n.status}`));

    state.set(guildId, {
      songs: [],
      player,
      connection: null,
      playing: false,
      loop: false,
      shuffle: false,
    });
  }
  return state.get(guildId);
}

function controlsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('toggle').setEmoji('⏯️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
  );
}

function truncate(text, max = 95) {
  if (!text) return 'Unknown';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

async function connect(voiceChannel, q) {
  if (q.connection) return q.connection;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('stateChange', (o, n) => console.log(`[VOICE] ${o.status} -> ${n.status}`));
  connection.on('error', (e) => console.error('[VOICE ERROR]', e?.message ?? e));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log('[VOICE] Ready ✅');
  } catch (e) {
    console.error('[VOICE] No llegó a Ready ❌ (posible UDP/permiso/hosting).', e?.message ?? e);
  }

  connection.subscribe(q.player);
  q.connection = connection;
  return connection;
}

function pickNext(q) {
  if (!q.songs.length) return null;
  if (q.shuffle && q.songs.length > 1) {
    const idx = Math.floor(Math.random() * q.songs.length);
    return q.songs.splice(idx, 1)[0];
  }
  return q.songs.shift();
}

// ✅ SOLO SoundCloud: top 5
async function searchTop5SoundCloud(query) {
  let results = [];
  try {
    results = await play.search(query, { limit: 5, source: { soundcloud: 'tracks' } });
    console.log('[SEARCH] SoundCloud:', results?.length ?? 0);
  } catch (e) {
    console.error('[SEARCH] SoundCloud failed:', e?.message ?? e);
  }

  const normalized = results.slice(0, 5).map(r => ({
    title: r.title ?? r.name ?? 'Unknown',
    url: r.url,
    thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
    sourceLabel: 'SoundCloud',
  }));

  return normalized;
}

// ✅ SOLO SoundCloud: resolver a canción reproducible
async function resolveToPlayableSoundCloud(query, requestedBy) {
  // Spotify -> convertir a texto -> buscar SOLO en SoundCloud
  if (query.includes('open.spotify.com')) {
    const sp = await play.spotify(query).catch(() => null);
    if (!sp) return null;

    const firstTrack = sp?.type === 'track' ? sp : (sp?.tracks?.[0] ?? null);
    if (!firstTrack) return null;

    const searchText = `${firstTrack.name} ${firstTrack.artists?.[0]?.name ?? ''}`.trim();
    const scRes = await play.search(searchText, { limit: 1, source: { soundcloud: 'tracks' } }).catch(() => []);
    if (!scRes.length) return null;

    const r = scRes[0];
    return {
      title: `${firstTrack.name} — ${firstTrack.artists?.map(a => a.name).join(', ') ?? ''}`.trim(),
      url: r.url,
      thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
      requestedBy,
      sourceLabel: 'Spotify → SoundCloud',
    };
  }

  // URL directo: SOLO SoundCloud permitido
  if (query.startsWith('http://') || query.startsWith('https://')) {
    const sc = await play.soundcloud(query).catch(() => null);
    if (!sc) return null;

    return {
      title: sc.name,
      url: sc.url,
      thumbnail: sc.thumbnail ?? null,
      requestedBy,
      sourceLabel: 'SoundCloud',
    };
  }

  // Texto: SOLO SoundCloud
  const results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } }).catch(() => []);
  if (!results.length) return null;

  const r = results[0];
  return {
    title: r.title ?? r.name ?? query,
    url: r.url,
    thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
    requestedBy,
    sourceLabel: 'SoundCloud',
  };
}

async function playNext(interaction, guildId) {
  const q = getState(guildId);
  if (q.playing) return;

  const next = pickNext(q);
  if (!next) return;

  q.playing = true;

  let stream;
  try {
    stream = await play.stream(next.url);
  } catch (e) {
    console.error('[STREAM ERROR]', e?.message ?? e);
    q.playing = false;
    await interaction.followUp({ content: `❌ No pude reproducir **${next.title}** (saltando)…` }).catch(() => {});
    return playNext(interaction, guildId);
  }

  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  q.player.play(resource);

  const embed = new EmbedBuilder()
    .setTitle('🎶 Now Playing')
    .setDescription(`**${next.title}**\n👤 Agregado por: **${next.requestedBy}**\n🔎 Fuente: **${next.sourceLabel}**`)
    .setURL(next.url)
    .setThumbnail(next.thumbnail ?? null);

  const msg = await interaction.followUp({
    embeds: [embed],
    components: [controlsRow()],
  }).catch(() => null);

  if (msg) {
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
    });

    collector.on('collect', async (btn) => {
      if (btn.customId === 'toggle') {
        if (q.player.state.status === 'playing') q.player.pause();
        else q.player.unpause();
        return btn.deferUpdate();
      }
      if (btn.customId === 'skip') {
        q.player.stop(true);
        return btn.deferUpdate();
      }
      if (btn.customId === 'stop') {
        getVoiceConnection(guildId)?.destroy();
        state.delete(guildId);
        return btn.update({ content: '🛑 Detenido.', embeds: [], components: [] });
      }
      if (btn.customId === 'loop') {
        q.loop = !q.loop;
        return btn.reply({ content: `🔁 Loop: **${q.loop ? 'ON' : 'OFF'}**`, ephemeral: true });
      }
      if (btn.customId === 'shuffle') {
        q.shuffle = !q.shuffle;
        return btn.reply({ content: `🔀 Shuffle: **${q.shuffle ? 'ON' : 'OFF'}**`, ephemeral: true });
      }
    });

    collector.on('end', async () => {
      try { await msg.edit({ components: [] }); } catch {}
    });
  }

  q.player.once(AudioPlayerStatus.Idle, async () => {
    if (q.loop) q.songs.push(next);
    q.playing = false;
    await playNext(interaction, guildId).catch(() => {});
  });
}

// -------------------- Slash Commands --------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const q = getState(guildId);

  if (interaction.commandName === 'play') {
    try {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: '❌ Únete a un canal de voz primero.', ephemeral: true });
      }

      await interaction.deferReply();
      await connect(voiceChannel, q);

      const query = interaction.options.getString('query', true);

      // Si pega YouTube URL, decirle claramente que aquí solo SC
      if (query.includes('youtube.com') || query.includes('youtu.be')) {
        return interaction.editReply('⚠️ Este bot está configurado SOLO para **SoundCloud** en Railway. Pega un link de SoundCloud o busca por texto.');
      }

      // URL directo: solo SC
      if (query.startsWith('http://') || query.startsWith('https://')) {
        await interaction.editReply('⏳ Procesando link de SoundCloud…');

        const song = await resolveToPlayableSoundCloud(query, interaction.user.username);
        if (!song) return interaction.editReply('❌ Ese link no parece ser de SoundCloud o no pude leerlo.');

        q.songs.push(song);

        const added = new EmbedBuilder()
          .setTitle('✅ Agregado a la cola')
          .setDescription(`**${song.title}**\n👤 Agregado por: **${song.requestedBy}**\n🔎 Fuente: **${song.sourceLabel}**`)
          .setURL(song.url)
          .setThumbnail(song.thumbnail ?? null);

        await interaction.editReply({ content: null, embeds: [added], components: [] });

        if (!q.playing) await playNext(interaction, guildId);
        return;
      }

      // Texto: top 5 SOLO SC
      await interaction.editReply('🔎 Buscando en SoundCloud (5 opciones)…');

      const options = await searchTop5SoundCloud(query);
   if (!options.length) {
  const scUrl = `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('🔎 Buscar en SoundCloud')
      .setURL(scUrl)
  );

  return interaction.editReply({
    content:
      '❌ No encontré resultados en **SoundCloud**.\n' +
      '👉 Usa el botón para buscarla en SoundCloud y pega aquí el **link del track**.\n' +
      '✅ Ejemplo: `/play https://soundcloud.com/usuario/cancion`',
    components: [row],
    embeds: []
  });
}


      const embed = new EmbedBuilder()
        .setTitle('Resultados (SoundCloud)')
        .setDescription(options.map((r, i) => `**${i + 1}.** ${r.title}`).join('\n'));

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`pick_song:${interaction.user.id}`)
        .setPlaceholder('Elige una canción (1–5)…')
        .addOptions(
          options.map((r, i) => ({
            label: truncate(`${i + 1}. ${r.title}`),
            description: truncate(r.url),
            value: String(i),
          }))
        );

      const row = new ActionRowBuilder().addComponents(menu);

      const msg = await interaction.editReply({
        embeds: [embed],
        components: [row],
      });

      const picked = await msg.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 60_000,
        filter: (i) =>
          i.user.id === interaction.user.id &&
          i.customId === `pick_song:${interaction.user.id}`,
      }).catch(() => null);

      if (!picked) {
        return interaction.editReply({ content: '⌛ Se acabó el tiempo. Usa /play otra vez.', embeds: [], components: [] });
      }

      const idx = Number(picked.values[0]);
      const chosen = options[idx];

      await picked.deferUpdate();

      const song = await resolveToPlayableSoundCloud(chosen.url, interaction.user.username);
      if (!song) {
        return interaction.editReply({ content: '❌ No pude reproducir esa opción. Prueba otra.', embeds: [], components: [] });
      }

      q.songs.push(song);

      const added = new EmbedBuilder()
        .setTitle('✅ Agregado a la cola')
        .setDescription(`**${song.title}**\n👤 Agregado por: **${song.requestedBy}**\n🔎 Fuente: **${song.sourceLabel}**`)
        .setURL(song.url)
        .setThumbnail(song.thumbnail ?? null);

      await interaction.editReply({ content: null, embeds: [added], components: [] });

      if (!q.playing) await playNext(interaction, guildId);
    } catch (e) {
      console.error('[PLAY ERROR]', e);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ Error interno. Revisa Railway Logs.');
      } else {
        await interaction.reply({ content: '❌ Error interno. Revisa Railway Logs.', ephemeral: true });
      }
    }
  }

  if (interaction.commandName === 'skip') {
    q.player.stop(true);
    return interaction.reply({ content: '⏭️ Skip!', ephemeral: true });
  }

  if (interaction.commandName === 'queue') {
    if (!q.songs.length) return interaction.reply({ content: '📭 Cola vacía.', ephemeral: true });

    const list = q.songs
      .slice(0, 15)
      .map((s, i) => `${i + 1}. ${s.title} (by ${s.requestedBy})`)
      .join('\n');

    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📃 Cola').setDescription(list)] });
  }

  if (interaction.commandName === 'stop') {
    getVoiceConnection(guildId)?.destroy();
    state.delete(guildId);
    return interaction.reply({ content: '🛑 Detenido y salí del canal.', ephemeral: true });
  }
});

client.once('ready', () => console.log(`✅ Online como ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
