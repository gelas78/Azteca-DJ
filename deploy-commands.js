import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Busca y reproduce (elige entre 5 opciones) o pega un link directo')
    .addStringOption(o =>
      o.setName('query').setDescription('Título/artista o URL').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Saltar canción'),
  new SlashCommandBuilder().setName('queue').setDescription('Ver cola'),
  new SlashCommandBuilder().setName('stop').setDescription('Detener y salir'),
].map(c => c.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('❌ Faltan env vars: DISCORD_TOKEN, CLIENT_ID, GUILD_ID');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('✅ Slash commands registrados (GUILD).');
} catch (err) {
  console.error('❌ Error registrando slash commands:', err);
  process.exit(1);
}
