import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
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
  StreamType,
} from '@discordjs/voice';

import play from 'play-dl';
import { fetch } from 'undici';

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const state = new Map(); // guildId -> { songs, player, connection, playing, loop, shuffle }

function getState(guildId) {
  if (!state.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    player.on('error', (err) => console.error('[PLAYER ERROR]', err));
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
  connection.on('error', (e) => console.error('[VOICE ERROR]', e));

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

function isDirectAudioUrl(url) {
  const u = url.toLowerCase();
  return (
    u.endsWith('.mp3') ||
    u.endsWith('.m4a') ||
    u.endsWith('.ogg') ||
    u.endsWith('.wav') ||
    u.includes('.m3u8') ||
    u.includes('audio')
  );
}

async function resolveToPlayable(query, requestedBy) {
  // Spotify link -> convertir a búsqueda YouTube (no stream directo)
  if (query.includes('open.spotify.com')) {
    const sp = await play.spotify(query).catch(() => null);
    if (!sp) return null;

    const firstTrack =
      sp?.type === 'track' ? sp : (sp?.tracks?.[0] ?? null);

    if (!firstTrack) return null;

    const searchText = `${firstTrack.name} ${firstTrack.artists?.[0]?.name ?? ''}`.trim();
    const yt = await play.search(searchText, { limit: 1, source: { youtube: 'video' } }).catch(() => []);
    if (!yt.length) return null;

    return {
      title: `${firstTrack.name} — ${firstTrack.artists?.map(a => a.name).join(', ') ?? ''}`.trim(),
      url: yt[0].url,
      thumbnail: yt[0].thumbnails?.at(-1)?.url ?? null,
      requestedBy,
      sourceLabel: 'Spotify → YouTube',
      kind: 'ytdl',
    };
  }

  // URL directo
  if (query.startsWith('http://') || query.startsWith('https://')) {
    const sc = await play.soundcloud(query).catch(() => null);
    if (sc) {
      return {
        title: sc.name,
        url: sc.url,
        thumbnail: sc.thumbnail ?? null,
        requestedBy,
        sourceLabel: 'SoundCloud',
        kind: 'playdl',
      };
    }

    const info = await play.video_basic_info(query).catch(() => null);
    if (info?.video_details) {
      return {
        title: info.video_details.title,
        url: query,
        thumbnail: info.video_details.thumbnails?.at(-1)?.url ?? null,
        requestedBy,
        sourceLabel: 'YouTube',
        kind: 'playdl',
      };
    }

    // Link de audio directo
    return {
      title: 'Audio',
      url: query,
      thumbnail: null,
      requestedBy,
      sourceLabel: 'Direct',
      kind: 'direct',
    };
  }

  // Búsqueda: YouTube primero, luego SoundCloud
  let results = await play.search(query, { limit: 1, source: { youtube: 'video' } }).catch(() => []);
  let label = 'YouTube';
  if (!results.length) {
    results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } }).catch(() => []);
    label = 'SoundCloud';
  }
  if (!results.length) return null;

  const r = results[0];
  return {
    title: r.title ?? r.name ?? query,
    url: r.url,
    thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
    requestedBy,
    sourceLabel: label,
    kind: 'playdl',
  };
}

async function createResourceFromSong(song) {
  // Direct audio via fetch
  if (song.kind === 'direct') {
    // Si no parece audio directo, igual intentamos, pero puede fallar
    const res = await fetch(song.url);
    if (!res.ok) throw new Error(`Direct fetch failed: ${res.status}`);

    // undici devuelve res.body como ReadableStream (web); convertimos a Node stream:
    const nodeStream = res.body;

    // Para streams directos, discord.js voice suele aceptar StreamType.Arbitrary
    return createAudioResource(nodeStream, { inputType: StreamType.Arbitrary });
  }

  // YouTube/SoundCloud via play-dl
  const stream = await play.stream(song.url);
  return createAudioResource(stream.stream, { inputType: stream.type });
}

async function playNext(interaction, guildId) {
  const q = getState(guildId);
  if (q.playing) return;

  const next = pickNext(q);
  if (!next) return;

  q.playing = true;

  try {
    const resource = await createResourceFromSong(next);
    q.player.play(resource);
  } catch (e) {
    console.error('[STREAM ERROR]', e?.message ?? e);
    q.playing = false;
    await interaction.followUp({ content: `❌ No pude reproducir **${next.title}** (saltando)…` }).catch(() => {});
    return playNext(interaction, guildId);
  }

  const embed = new EmbedBuilder()
    .setTitle('🎶 Now Playing')
    .setDescription(`**${next.title}**\n👤 Agregado por: **${next.requestedBy}**\n🔎 Fuente: **${next.sourceLabel}**`)
    .setURL(next.url)
    .setThumbnail(next.thumbnail ?? null);

  const msg = await interaction.followUp({ embeds: [embed], components: [controlsRow()] }).catch(() => null);

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
      await interaction.editReply('⏳ Buscando y conectando…');

      await connect(voiceChannel, q);

      const query = interaction.options.getString('query', true);
      const song = await resolveToPlayable(query, interaction.user.username);

      if (!song) return interaction.editReply('❌ No encontré resultados. Prueba con otro link o búsqueda.');

      q.songs.push(song);

      const added = new EmbedBuilder()
        .setTitle('✅ Agregado a la cola')
        .setDescription(`**${song.title}**\n👤 Agregado por: **${song.requestedBy}**\n🔎 Fuente: **${song.sourceLabel}**`)
        .setURL(song.url)
        .setThumbnail(song.thumbnail ?? null);

      await interaction.editReply({ content: null, embeds: [added] });

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
    const list = q.songs.slice(0, 15).map((s, i) => `${i + 1}. ${s.title} (by ${s.requestedBy})`).join('\n');
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
