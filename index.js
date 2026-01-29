import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} from 'discord.js';

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection
} from '@discordjs/voice';

import play from 'play-dl';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// Estado por servidor
const state = new Map(); // guildId -> { songs: [], player, connection, playing, loop, shuffle }

function getState(guildId) {
  if (!state.has(guildId)) {
    state.set(guildId, {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
      connection: null,
      playing: false,
      loop: false,
      shuffle: false
    });
  }
  return state.get(guildId);
}

function makeControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('toggle').setEmoji('⏯️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
  );
}

async function resolveSong(query, requestedBy) {
  // URL
  if (query.startsWith('http://') || query.startsWith('https://')) {
    const sc = await play.soundcloud(query).catch(() => null);
    if (sc) return { title: sc.name, url: sc.url, thumbnail: sc.thumbnail, requestedBy };

    const info = await play.video_basic_info(query).catch(() => null);
    if (info?.video_details) {
      return {
        title: info.video_details.title,
        url: query,
        thumbnail: info.video_details.thumbnails?.at(-1)?.url,
        requestedBy
      };
    }

    return { title: 'Audio', url: query, thumbnail: null, requestedBy };
  }

  // Búsqueda (preferimos SoundCloud por estabilidad)
  //const results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } }).catch(() => []);
 // if (!results.length) return null;
  //const r = results[0];

  let results = await play.search(query, { limit: 1, source: { youtube: 'video' } }).catch(() => []);
  if (!results.length) {
  results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } }).catch(() => []);
}

  const r = results[0];
return {
  title: r.title ?? r.name ?? query,
  url: r.url,
  thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
  requestedBy
};


  return {
    title: r.title ?? r.name ?? query,
    url: r.url,
    thumbnail: r.thumbnails?.at(-1)?.url ?? r.thumbnail ?? null,
    requestedBy
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

async function startPlayback(interaction, guildId) {
  const q = getState(guildId);
  if (q.playing) return;

  const next = pickNext(q);
  if (!next) return;

  q.playing = true;

  const stream = await play.stream(next.url);
  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  q.player.play(resource);

  const embed = new EmbedBuilder()
    .setTitle('🎶 Now Playing')
    .setDescription(`**${next.title}**\nSolicitado por: **${next.requestedBy}**`)
    .setURL(next.url)
    .setThumbnail(next.thumbnail ?? null);

  const msg = await interaction.followUp({
    embeds: [embed],
    components: [makeControls()]
  });

  // Botones (solo por 5 minutos, luego se desactivan)
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000
  });

  collector.on('collect', async (btn) => {
    // (Opcional) restringe a quien pidió la canción:
    // if (btn.user.id !== interaction.user.id) return btn.reply({ content:'Solo quien pidió controla.', ephemeral:true });

    if (btn.customId === 'toggle') {
      if (q.player.state.status === 'playing') q.player.pause();
      else q.player.unpause();
      await btn.deferUpdate();
    }

    if (btn.customId === 'skip') {
      q.player.stop(true);
      await btn.deferUpdate();
    }

    if (btn.customId === 'stop') {
      const conn = getVoiceConnection(guildId);
      conn?.destroy();
      state.delete(guildId);
      await btn.update({ content: '🛑 Detenido.', embeds: [], components: [] });
    }

    if (btn.customId === 'loop') {
      q.loop = !q.loop;
      await btn.reply({ content: `🔁 Loop: **${q.loop ? 'ON' : 'OFF'}**`, ephemeral: true });
    }

    if (btn.customId === 'shuffle') {
      q.shuffle = !q.shuffle;
      await btn.reply({ content: `🔀 Shuffle: **${q.shuffle ? 'ON' : 'OFF'}**`, ephemeral: true });
    }
  });

  q.player.once(AudioPlayerStatus.Idle, async () => {
    // Loop: vuelve a meter la canción al final
    if (q.loop) q.songs.push(next);
    q.playing = false;
    await startPlayback(interaction, guildId).catch(() => {});
  });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  const q = getState(guildId);

  if (interaction.commandName === 'play') {
    if (!voiceChannel) return interaction.reply({ content: '❌ Únete a un canal de voz primero.', ephemeral: true });

    await interaction.reply('⏳ Preparando…');

    if (!q.connection) {
      q.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator
      });
      q.connection.subscribe(q.player);
    }

    const query = interaction.options.getString('query', true);
    const song = await resolveSong(query, interaction.user.username);

    if (!song) return interaction.editReply('❌ No encontré resultados. Prueba con un link de SoundCloud o link directo.');

    q.songs.push(song);

    const added = new EmbedBuilder()
      .setTitle('✅ Agregado a la cola')
      .setDescription(`**${song.title}**`)
      .setURL(song.url)
      .setThumbnail(song.thumbnail ?? null);

    await interaction.editReply({ content: null, embeds: [added] });

    if (!q.playing) await startPlayback(interaction, guildId);
  }

  if (interaction.commandName === 'pause') {
    if (q.player.state.status === 'playing') q.player.pause();
    else q.player.unpause();
    return interaction.reply('⏯️ Toggle pausa.');
  }

  if (interaction.commandName === 'queue') {
    if (!q.songs.length) return interaction.reply({ content: '📭 Cola vacía.', ephemeral: true });
    const list = q.songs.slice(0, 10).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📃 Cola').setDescription(list)] });
  }

  if (interaction.commandName === 'skip') {
    q.player.stop(true);
    return interaction.reply('⏭️ Skip!');
  }

  if (interaction.commandName === 'stop') {
    const conn = getVoiceConnection(guildId);
    conn?.destroy();
    state.delete(guildId);
    return interaction.reply('🛑 Detenido y salí del canal.');
  }
});

client.once('ready', () => console.log(`✅ Online como ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
