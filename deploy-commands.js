import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Reproducir (SoundCloud o link directo)')
    .addStringOption(o =>
      o.setName('query').setDescription('Link o búsqueda').setRequired(true)
    ),
  new SlashCommandBuilder().setName('pause').setDescription('Pausa / reanuda'),
  new SlashCommandBuilder().setName('skip').setDescription('Saltar canción'),
  new SlashCommandBuilder().setName('queue').setDescription('Ver cola'),
  new SlashCommandBuilder().setName('stop').setDescription('Detener y salir')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Global commands (tardan a veces minutos en aparecer)
await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: commands }
);

console.log('✅ Slash commands registrados.');
