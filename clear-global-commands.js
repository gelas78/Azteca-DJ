import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error('Faltan DISCORD_TOKEN o CLIENT_ID');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

await rest.put(Routes.applicationCommands(clientId), { body: [] });
console.log('✅ Comandos GLOBAL borrados.');
