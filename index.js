// index.js (ESM)
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
} from '@discordjs/voice';

import play from 'play-dl';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// -------------------- Estado por servidor --------------------
const state = new Map(); // guildId -> { songs, player, connection, playing, loop, shuffle, nowPlayingMsgId }

function getState(guildId) {
  if (!state.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    // Logs IMPORTANTES para debug
    player.on('error', (err) => {
      console.error('[AUDIO PLAYER ERROR]', err?.message ?? err);
      if (err?.stack) console.error(err.stack);
    });

    player.on('stateChange', (oldState, newState) => {
      console.log(`[PLAYER] ${oldState.status} -> ${newState.status}`);
    });

    state.set(guildId, {
      songs: [],
      player,
      connection: null,
      playing: false,
      loop: false,
      shuffle: false,
      nowPlayingMsgId: null,
    });
  }
  return state.get(guildId);
}

function makeControls(q) {
  const loopLabel = q.loop ? '🔁 ON' : '🔁 OFF';
  const shuffleLabel = q.shuffle ? '🔀 ON' : '🔀 OFF';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('toggle').setEmoji('⏯️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('loop').setLabel(loopLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shuffle').setLabel(shuffleLabel).setStyle(ButtonStyle.Secondary),
  );
}

async function resolveSong(query, requestedBy) {
  // URL
  if (query.startsWith('http://') || query.startsWith('https://')) {
    // Intentar SoundCloud primero
    const sc = await play.soundcloud(query).catch(() => null);
    if (sc) {
      return { title: sc.name, url: sc.url, thumbnail: sc.thumbnail, requestedBy };
    }

    // Intentar “basic info” (puede servir para algunos links)
    const info = await play.video_basic_info(query).catch(() => null);
    if (info?.video_details) {
      return {
        title: info.video_details.title,
        url: query,
        thumbnail: info.video_details.thumbnails?.at(-1)?.url ?? null,
        requestedBy,
      };
    }

    // Link directo (mp3, etc.)
    return { title: 'Audio', url: query, thumbnail: null, requestedBy };
  }

  // Búsqueda (por estabilidad, SoundCloud)
  const results = await play
    .search(query, { limit: 1, source: { soundcloud: 'tracks' } })
    .catch(() => []);

  if (!results.length) return null;

  const r = results[0];
  return {
    title: r.title ?? r.name ?? query,
    url: r.url,
    thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
    requestedBy,
  };
}

function pickNext(q) {
  if (!q.songs.length) return null;
  if (q.shuffle && q.songs.length > 1) {
    const idx = Math.floor(Math.random() * q.songs.length);
    return q.songs.splice(idx, 1)[0];
  }
  return q.songs.shift();
}

async function connectToVoice(voiceChannel, q) {
  if (q.connection) return q.connection;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true, // recomendado para bots música
    selfMute: false,
  });

  // Logs de voz IMPORTANTES
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[VOICE] ${oldState.status} -> ${newState.status}`);
  });

  connection.on('error', (err) => {
    console.error('[VOICE CONNECTION ERROR]', err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  });

  // Esperar a Ready (si no llega, suele ser bloqueo UDP/hosting o permisos)
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log('[VOICE] Ready ✅');
  } catch (e) {
    console.error('[VOICE] No llegó a Ready (posible bloqueo UDP o permisos).', e?.message ?? e);
  }

  connection.subscribe(q.player);
  q.connection = connection;

  return connection;
}

async function startPlayback(interaction, guildId) {
  const q = getState(guildId);
  if (q.playing) return;

  const next = pickNext(q);
  if (!next) return;

  q.playing = true;

  // Intentar reproducir
  let stream;
  try {
    stream = await play.stream(next.url);
  } catch (e) {
    console.error('[STREAM ERROR] No pude abrir stream:', e?.message ?? e);
    q.playing = false;

    // Saltar automáticamente a la siguiente
    await interaction.followUp({ content: `❌ No pude reproducir: **${next.title}** (saltando)…` }).catch(() => {});
    return startPlayback(interaction, guildId);
  }

  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  q.player.play(resource);

  const embed = new EmbedBuilder()
    .setTitle('🎶 Now Playing')
    .setDescription(`**${next.title}**\nSolicitado por: **${next.requestedBy}**`)
    .setURL(next.url)
    .setThumbnail(next.thumbnail ?? null);

  const msg = await interaction
    .followUp({
      embeds: [embed],
      components: [makeControls(q)],
    })
    .catch(() => null);

  // Botones (5 minutos)
  if (msg) {
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
    });

    collector.on('collect', async (btn) => {
      // Puedes restringir controles a DJ/solicitante si quieres (luego lo hacemos)

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
        const conn = getVoiceConnection(guildId);
        conn?.destroy();
        state.delete(guildId);
        return btn.update({ content: '🛑 Detenido.', embeds: [], components: [] });
      }

      if (btn.customId === 'loop') {
        q.loop = !q.loop;
        await btn.reply({ content: `🔁 Loop: **${q.loop ? 'ON' : 'OFF'}**`, ephemeral: true });
        // Actualiza botones
        return msg.edit({ components: [makeControls(q)] }).catch(() => {});
      }

      if (btn.customId === 'shuffle') {
        q.shuffle = !q.shuffle;
        await btn.reply({ content: `🔀 Shuffle: **${q.shuffle ? 'ON' : 'OFF'}**`, ephemeral: true });
        // Actualiza botones
        return msg.edit({ components: [makeControls(q)] }).catch(() => {});
      }
    });

    collector.on('end', async () => {
      // Desactiva botones al terminar
      try {
        await msg.edit({ components: [] });
      } catch {}
    });
  }

  // Cuando termina la canción
  q.player.once(AudioPlayerStatus.Idle, async () => {
    if (q.loop) q.songs.push(next);
    q.playing = false;
    await startPlayback(interaction, guildId).catch(() => {});
  });
}

// -------------------- Comandos --------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const q = getState(guildId);

  if (interaction.commandName === 'play') {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: '❌ Únete a un canal de voz primero.', ephemeral: true });
    }

    // Evita timeout del interaction
    await interaction.deferReply();

    // Conectar a voz (y loguear estado)
    await connectToVoice(voiceChannel, q);

    const query = interaction.options.getString('query', true);
    const song = await resolveSong(query, interaction.user.username);

    if (!song) {
      return interaction.editReply('❌ No encontré resultados. Prueba con un link de SoundCloud o link directo.');
    }

    q.songs.push(song);

    const added = new EmbedBuilder()
      .setTitle('✅ Agregado a la cola')
      .setDescription(`**${song.title}**`)
      .setURL(song.url)
      .setThumbnail(song.thumbnail ?? null);

    await interaction.editReply({ content: null, embeds: [added] });

    if (!q.playing) {
      await startPlayback(interaction, guildId);
    }
  }

  if (interaction.commandName === 'pause') {
    if (q.player.state.status === 'playing') q.player.pause();
    else q.player.unpause();
    return interaction.reply({ content: '⏯️ Toggle pausa.', ephemeral: true });
  }

  if (interaction.commandName === 'queue') {
    if (!q.songs.length) {
      return interaction.reply({ content: '📭 Cola vacía.', ephemeral: true });
    }
    const list = q.songs.slice(0, 15).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📃 Cola').setDescription(list)] });
  }

  if (interaction.commandName === 'skip') {
    q.player.stop(true);
    return interaction.reply({ content: '⏭️ Skip!', ephemeral: true });
  }

  if (interaction.commandName === 'stop') {
    const conn = getVoiceConnection(guildId);
    conn?.destroy();
    state.delete(guildId);
    return interaction.reply({ content: '🛑 Detenido y salí del canal.', ephemeral: true });
  }
});

// -------------------- Ready --------------------
client.once('ready', () => {
  console.log(`✅ Online como ${client.user.tag}`);
  console.log('TIP: Si no se escucha, instala OPUS: npm i @discordjs/opus');
});

client.login(process.env.DISCORD_TOKEN);
