import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Reproduce música (SoundCloud o link directo)')
    .addStringOption(o =>
      o.setName('query').setDescription('Link o búsqueda').setRequired(true)
    ),
  new SlashCommandBuilder().setName('pause').setDescription('Pausa / reanuda'),
  new SlashCommandBuilder().setName('skip').setDescription('Saltar canción'),
  new SlashCommandBuilder().setName('queue').setDescription('Ver cola'),
  new SlashCommandBuilder().setName('stop').setDescription('Detener y salir'),
].map(c => c.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // opcional

if (!token || !clientId) {
  console.error('❌ Faltan variables: DISCORD_TOKEN y/o CLIENT_ID');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    // ✅ Aparecen INMEDIATO en ese servidor
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('✅ Slash commands registrados (GUILD).');
  } else {
    // ✅ Global (pueden tardar unos minutos)
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Slash commands registrados (GLOBAL).');
  }
} catch (err) {
  console.error('❌ Error registrando slash commands:', err);
  process.exit(1);
}
