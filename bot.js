require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, AttachmentBuilder, Events, PermissionsBitField, EmbedBuilder, REST, Routes, SlashCommandBuilder, Colors, ChannelType } = require('discord.js');
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN) {
  console.error('Please set DISCORD_TOKEN, CLIENT_ID, and CLIENT_SECRET in .env');
  process.exit(1);
}
const allowedUserIds = ['817621670461702155', '1243809777604235309', '1414468530555981955'];
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');
let settingsStore = {};
let warnStore = {};
try {
  settingsStore = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
  for (const guildId in settingsStore) {
    if (!settingsStore[guildId]?.verify || typeof settingsStore[guildId].verify.enabled !== 'boolean' || !settingsStore[guildId].verify.channelId) {
      console.warn(`Invalid settings for guild ${guildId}, resetting verify config`);
      delete settingsStore[guildId].verify;
    }
  }
  for (const guildId in settingsStore) {
    if (!settingsStore[guildId].antiraid) {
      settingsStore[guildId].antiraid = { enabled: false, messageLimit: 5, timeWindow: 10000 }; 
    }
  }
} catch (e) {
  console.error('Failed to load settings.json:', e);
  settingsStore = {};
}
try {
  warnStore = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8') || '{}');
} catch (e) {
  console.error('Failed to load warnings.json:', e);
  warnStore = {};
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}
function saveWarnings() {
  try {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnStore, null, 2));
  } catch (e) {
    console.error('Failed to save warnings:', e);
  }
}
const captchaMap = new Map();
const spamTracker = new Map(); // guildId => Map<userId, number[]> (timestamps)
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message]
});
client.once(Events.ClientReady, async () => {
  console.log('Bot ready as', client.user.tag);
  const commands = [
    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check if the bot is alive'),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('List all available commands'),
    new SlashCommandBuilder()
      .setName('invite')
      .setDescription('Get the bot invite link'),
    new SlashCommandBuilder()
      .setName('getserver')
      .setDescription('Get server information or icon')
      .addSubcommand(subcommand =>
        subcommand
          .setName('info')
          .setDescription('Display server information')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('icon')
          .setDescription('Get the server icon')
      ),
    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a user from the server')
      .addUserOption(option => option.setName('user').setDescription('The user to kick').setRequired(true))
      .addStringOption(option => option.setName('reason').setDescription('Reason for kick').setRequired(false)),
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user from the server')
      .addUserOption(option => option.setName('user').setDescription('The user to ban').setRequired(true))
      .addStringOption(option => option.setName('reason').setDescription('Reason for ban').setRequired(false)),
    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a user')
      .addUserOption(option => option.setName('user').setDescription('The user to warn').setRequired(true))
      .addStringOption(option => option.setName('reason').setDescription('Reason for warning').setRequired(true)),
    new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('View warnings for a user')
      .addUserOption(option => option.setName('user').setDescription('The user to check warnings for').setRequired(true)),
    new SlashCommandBuilder()
      .setName('clearwarnings')
      .setDescription('Clear all warnings for a user')
      .addUserOption(option => option.setName('user').setDescription('The user to clear warnings for').setRequired(true)),
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Mute a user for a specified time')
      .addUserOption(option => option.setName('user').setDescription('The user to mute').setRequired(true))
      .addIntegerOption(option => option.setName('minutes').setDescription('Minutes to mute').setRequired(false))
      .addIntegerOption(option => option.setName('hours').setDescription('Hours to mute').setRequired(false))
      .addIntegerOption(option => option.setName('days').setDescription('Days to mute').setRequired(false))
      .addStringOption(option => option.setName('reason').setDescription('Reason for mute').setRequired(false)),
    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Unmute a user')
      .addUserOption(option => option.setName('user').setDescription('The user to unmute').setRequired(true)),
    new SlashCommandBuilder()
      .setName('verify-setup')
      .setDescription('Setup the verification system')
      .addChannelOption(option => option.setName('channel').setDescription('The verification channel').setRequired(true))
      .addStringOption(option => option.setName('prompt').setDescription('Verification prompt text').setRequired(false))
      .addStringOption(option => option.setName('ping').setDescription('Ping text (e.g., @role)').setRequired(false))
      .addStringOption(option => option.setName('embed_title').setDescription('Embed title').setRequired(false))
      .addStringOption(option => option.setName('embed_color').setDescription('Embed color (hex)').setRequired(false))
      .addStringOption(option => option.setName('image_url').setDescription('Image/GIF URL for embed').setRequired(false))
      .addStringOption(option => option.setName('roles_on_join').setDescription('Comma-separated role IDs or names to give on join').setRequired(false))
      .addStringOption(option => option.setName('roles_on_verify').setDescription('Comma-separated role IDs or names to give on verify').setRequired(false)),
    new SlashCommandBuilder()
      .setName('verify-test')
      .setDescription('Send a test verification message'),
    new SlashCommandBuilder()
      .setName('verify-disable')
      .setDescription('Disable the verification system'),
    new SlashCommandBuilder()
      .setName('verification')
      .setDescription('Generate a verification code')
      .addStringOption(option =>
        option.setName('type')
          .setDescription('Type of verification code')
          .setRequired(true)
          .addChoices(
            { name: 'Numeric', value: 'numeric' },
            { name: 'Alphabetic', value: 'alphabetic' },
            { name: 'Mixed', value: 'mixed' }
          ))
      .addIntegerOption(option =>
        option.setName('length')
          .setDescription('Length of the code (4-10)')
          .setRequired(true)
          .setMinValue(4)
          .setMaxValue(10)),
    new SlashCommandBuilder()
      .setName('verification2')
      .setDescription('Answer a math question to verify'),
    new SlashCommandBuilder()
      .setName('cw')
      .setDescription('Add a censored word')
      .addStringOption(option => option.setName('word').setDescription('The word to censor').setRequired(true)),
    new SlashCommandBuilder()
      .setName('ucw')
      .setDescription('Remove a censored word')
      .addStringOption(option => option.setName('word').setDescription('The word to uncensor').setRequired(true)),
    new SlashCommandBuilder()
      .setName('cwl')
      .setDescription('List censored words'),
    new SlashCommandBuilder()
      .setName('prefix')
      .setDescription('Manage prefixes')
      .addSubcommand(subcommand =>
        subcommand
          .setName('add')
          .setDescription('Add a prefix')
          .addStringOption(option => option.setName('prefix').setDescription('The prefix to add').setRequired(true))
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('remove')
          .setDescription('Remove a prefix')
          .addStringOption(option => option.setName('prefix').setDescription('The prefix to remove').setRequired(true))
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('list')
          .setDescription('List prefixes')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('clear')
          .setDescription('Clear all prefixes')
      ),
    new SlashCommandBuilder()
      .setName('usage')
      .setDescription('Detailed usage for commands')
      .addStringOption(option =>
        option.setName('command')
          .setDescription('Specific command to get usage for')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('lock')
      .setDescription('Lock a channel')
      .addChannelOption(option => option.setName('channel').setDescription('The channel to lock').setRequired(false)),
    new SlashCommandBuilder()
      .setName('unlock')
      .setDescription('Unlock a channel')
      .addChannelOption(option => option.setName('channel').setDescription('The channel to unlock').setRequired(false)),
    new SlashCommandBuilder()
      .setName('uptime')
      .setDescription('Bot uptime'),
    new SlashCommandBuilder()
      .setName('dice')
      .setDescription('Roll a dice')
      .addIntegerOption(option => option.setName('sides').setDescription('Number of sides (default 6)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('coin')
      .setDescription('Flip a coin'),
    new SlashCommandBuilder()
      .setName('role')
      .setDescription('Assign a role to a user')
      .addUserOption(option => option.setName('user').setDescription('The user').setRequired(true))
      .addRoleOption(option => option.setName('role').setDescription('The role').setRequired(true)),
    new SlashCommandBuilder()
      .setName('audit')
      .setDescription('View recent audit logs')
      .addIntegerOption(option => option.setName('limit').setDescription('Number of entries (default 10)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('about')
      .setDescription('About the bot'),
    new SlashCommandBuilder()
      .setName('say')
      .setDescription('Make the bot say something')
      .addStringOption(option => option.setName('message').setDescription('The message').setRequired(true)),
    new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Create a poll')
      .addStringOption(option => option.setName('question').setDescription('The question').setRequired(true))
      .addStringOption(option => option.setName('options').setDescription('Comma-separated options').setRequired(true)),
    new SlashCommandBuilder()
      .setName('antiraid')
      .setDescription('Manage anti-raid (anti-spam) protection')
      .addSubcommand(subcommand =>
        subcommand
          .setName('enable')
          .setDescription('Enable anti-raid')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('disable')
          .setDescription('Disable anti-raid')
      ),
  ];
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands.map(command => command.toJSON()) }
      );
      console.log(`Successfully registered commands for guild ${guild.id}.`);
    } catch (error) {
      console.error(`Failed to register commands for guild ${guild.id}:`, error);
    }
  }
  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;
    const cfg = settingsStore[guildId];
    if (!cfg?.verify?.enabled || !cfg.verify.channelId) {
      console.log(`Skipping guild ${guildId}: Verification not enabled or channel not set`);
      continue;
    }
    const channel = await guild.channels.fetch(cfg.verify.channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      console.warn(`Verify channel ${cfg.verify.channelId} invalid or not text-based for guild ${guildId}`);
      continue;
    }
    const messageId = cfg.verify.messageId;
    let message = messageId
      ? await channel.messages.fetch({ message: messageId, cache: false }).catch(() => null)
      : null;
    if (message) {
      console.log(`Found existing verification message for guild ${guildId}, message ID: ${message.id}`);
      continue;
    }
    const lastSent = cfg.verify.lastSent || 0;
    if (Date.now() - lastSent < 1000 * 60 * 60 * 24 * 10) {
      console.log(`Skipping sending verification for guild ${guildId}: recently sent`);
      continue;
    }
    const prompt = cfg.verify.prompt || 'Click Verify to start. You will receive a captcha to solve.';
    const ping = cfg.verify.ping || '';
    const embedTitle = cfg.verify.embedTitle || 'VERIFICATION SECTION';
    const embedColor = cfg.verify.embedColor || '#0099ff';
    const gifURL = cfg.verify.gifURL;
    const verifyButton = new ButtonBuilder()
      .setCustomId('verify')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(verifyButton);
    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setDescription(prompt)
      .setColor(embedColor);
    if (gifURL) {
      embed.setImage(gifURL);
    }
    try {
      message = await channel.send({
        content: ping,
        embeds: [embed],
        components: [row]
      });
      settingsStore[guildId].verify.messageId = message.id;
      settingsStore[guildId].verify.lastSent = Date.now();
      saveSettings();
      console.log(`Sent verification message for guild ${guildId}, message ID: ${message.id}`);
    } catch (e) {
      console.error(`Failed to send verification message in guild ${guildId}:`, e);
    }
  }
});
// Helper function to send DM to user
async function sendUserDM(user, guild, action, reason) {
  try {
    const embed = new EmbedBuilder()
      .setTitle(`You have been ${action} on ${guild.name}`)
      .setDescription(`**Reason:** ${reason}`)
      .setColor(action === 'warned' ? Colors.Yellow : action === 'kicked' ? Colors.Orange : Colors.Red)
      .setTimestamp()
      .setFooter({ text: `Server: ${guild.name}` });
    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.warn(`Could not send DM to ${user.tag}:`, error.message);
    return false;
  }
}
// Warning system functions
function addWarning(guildId, userId, reason, moderatorId) {
  if (!warnStore[guildId]) warnStore[guildId] = {};
  if (!warnStore[guildId][userId]) warnStore[guildId][userId] = [];
 
  const warning = {
    id: Date.now().toString(),
    reason,
    moderatorId,
    timestamp: Date.now()
  };
 
  warnStore[guildId][userId].push(warning);
  saveWarnings();
  return warning;
}
function getWarnings(guildId, userId) {
  return warnStore[guildId]?.[userId] || [];
}
function clearWarnings(guildId, userId) {
  if (warnStore[guildId]?.[userId]) {
    delete warnStore[guildId][userId];
    saveWarnings();
    return true;
  }
  return false;
}
function randomText(len = 4, type = 'mixed') {
  let chars;
  if (type === 'numeric') {
    chars = '0123456789';
  } else if (type === 'alphabetic') {
    chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  } else {
    chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  }
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
async function createCaptchaImage({ text, avatarURL }) {
  try {
    const width = 500;
    const height = 200;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0B1B2A';
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = `rgba(${Math.floor(Math.random()*120+50)},${Math.floor(Math.random()*120+50)},${Math.floor(Math.random()*120+50)},0.25)`;
      ctx.beginPath();
      ctx.moveTo(Math.random()*width, Math.random()*height);
      ctx.lineTo(Math.random()*width, Math.random()*height);
      ctx.stroke();
    }
    if (avatarURL) {
      try {
        const avatarBuf = await axios.get(avatarURL, { responseType: 'arraybuffer', timeout: 5000 }).then(r => r.data);
        const img = await loadImage(avatarBuf);
        const avSize = 120;
        const avX = 30;
        const avY = (height - avSize) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(avX + avSize/2, avY + avSize/2, avSize/2, 0, Math.PI*2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, avX, avY, avSize, avSize);
        ctx.restore();
        ctx.strokeStyle = '#12323b';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(avX + avSize/2, avY + avSize/2, avSize/2 + 2, 0, Math.PI*2);
        ctx.stroke();
      } catch (e) {
        console.warn('Avatar load failed:', e?.message || e);
      }
    }
    const startX = 200;
    const baseY = height / 2 + 12;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const fontSize = 40 + Math.floor(Math.random()*16);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = ['#dbefff', '#bfe3d8', '#ffd7a8'][i % 3];
      const x = startX + i * 45 + (Math.random()*8 - 4);
      const angle = (Math.random()*30 - 15) * Math.PI/180;
      ctx.save();
      ctx.translate(x, baseY);
      ctx.rotate(angle);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    }
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.08})`;
      ctx.beginPath();
      ctx.arc(Math.random()*width, Math.random()*height, Math.random()*2+0.5, 0, Math.PI*2);
      ctx.fill();
    }
    const buffer = canvas.toBuffer('image/png');
    return { buffer, text };
  } catch (e) {
    console.error('Failed to create captcha image:', e);
    throw new Error('Captcha generation failed');
  }
}
function generateMathQuestion() {
  const num1 = Math.floor(Math.random() * 20) + 1;
  const num2 = Math.floor(Math.random() * 20) + 1;
  const operators = ['+', '-', '*'];
  const operator = operators[Math.floor(Math.random() * operators.length)];
  let answer;
  switch (operator) {
    case '+': answer = num1 + num2; break;
    case '-': answer = num1 - num2; break;
    case '*': answer = num1 * num2; break;
  }
  return { question: `${num1} ${operator} ${num2} = ?`, answer };
}
// Command help data with detailed usage
const commandHelp = [
  { name: '/ping', description: 'Replies with Pong!', usage: 'Use `/ping` to check if the bot is responsive.' },
  { name: '/help', description: 'Lists all commands', usage: 'Use `/help` to see a list of all available commands.' },
  { name: '/invite', description: 'Gets invite link', usage: 'Use `/invite` to get a link to add the bot to your server.' },
  { name: '/getserver info', description: 'Server info', usage: 'Use `/getserver info` to display server details like member count and channels.' },
  { name: '/getserver icon', description: 'Server icon', usage: 'Use `/getserver icon` to get the server’s icon image.' },
  { name: '/kick <user> [reason]', description: 'Kicks a user', usage: 'Use `/kick @user [reason]` to kick a user. Requires Kick Members permission.' },
  { name: '/ban <user> [reason]', description: 'Bans a user', usage: 'Use `/ban @user [reason]` to ban a user. Requires Ban Members permission.' },
  { name: '/warn <user> <reason>', description: 'Warns a user', usage: 'Use `/warn @user <reason>` to warn a user. Requires Moderate Members permission.' },
  { name: '/warnings <user>', description: 'Views warnings', usage: 'Use `/warnings @user` to see a user’s warnings. Requires Moderate Members permission.' },
  { name: '/clearwarnings <user>', description: 'Clears warnings', usage: 'Use `/clearwarnings @user` to clear a user’s warnings. Requires Moderate Members permission.' },
  { name: '/mute <user> [minutes] [hours] [days] [reason]', description: 'Mutes a user', usage: 'Use `/mute @user [minutes] [hours] [days] [reason]` to mute a user. Duration up to 28 days. Requires Moderate Members permission.' },
  { name: '/unmute <user>', description: 'Unmutes a user', usage: 'Use `/unmute @user` to unmute a user. Requires Moderate Members permission.' },
  { name: '/verify-setup <channel> [options]', description: 'Sets up verification', usage: 'Use `/verify-setup #channel [prompt] [ping] [embed_title] [embed_color] [image_url] [roles_on_join] [roles_on_verify]` to configure verification. Example: `/verify-setup #verify Welcome! @everyone Verification #FF0000 https://example.com/image.png Admin,Moderator Member`.' },
  { name: '/verify-test', description: 'Tests verification', usage: 'Use `/verify-test` to send a test verification message. Requires Manage Guild permission.' },
  { name: '/verify-disable', description: 'Disables verification', usage: 'Use `/verify-disable` to turn off verification. Requires Manage Guild permission.' },
  { name: '/verification <type> <length>', description: 'Generates code', usage: 'Use `/verification <type: numeric|alphabetic|mixed> <length: 4-10>` to generate a test verification code. Example: `/verification mixed 6`.' },
  { name: '/verification2', description: 'Math verification', usage: 'Use `/verification2` to get a math question for verification.' },
  { name: '/cw <word>', description: 'Adds censored word', usage: 'Use `/cw <word>` to add a word to the censor list. Requires Manage Guild permission.' },
  { name: '/ucw <word>', description: 'Removes censored word', usage: 'Use `/ucw <word>` to remove a word from the censor list. Requires Manage Guild permission.' },
  { name: '/cwl', description: 'Lists censored words', usage: 'Use `/cwl` to list all censored words. Requires Manage Guild permission.' },
  { name: '/prefix add <prefix>', description: 'Adds prefix', usage: 'Use `/prefix add <prefix>` to add a command prefix. Example: `/prefix add .`.' },
  { name: '/prefix remove <prefix>', description: 'Removes prefix', usage: 'Use `/prefix remove <prefix>` to remove a prefix. Example: `/prefix remove .`.' },
  { name: '/prefix list', description: 'Lists prefixes', usage: 'Use `/prefix list` to see all prefixes.' },
  { name: '/prefix clear', description: 'Clears prefixes', usage: 'Use `/prefix clear` to remove all prefixes. Requires Manage Guild permission.' },
  { name: '/usage [command]', description: 'Detailed command usage', usage: 'Use `/usage [command]` to get detailed usage for a command or all commands. Example: `/usage ping`.' },
  { name: '/lock [channel]', description: 'Locks channel', usage: 'Use `/lock [#channel]` to lock a channel. Defaults to current channel. Requires Manage Channels permission.' },
  { name: '/unlock [channel]', description: 'Unlocks channel', usage: 'Use `/unlock [#channel]` to unlock a channel. Defaults to current channel. Requires Manage Channels permission.' },
  { name: '/uptime', description: 'Bot uptime', usage: 'Use `/uptime` to see how long the bot has been running.' },
  { name: '/dice [sides]', description: 'Rolls dice', usage: 'Use `/dice [sides]` to roll a die. Defaults to 6 sides. Example: `/dice 20`.' },
  { name: '/coin', description: 'Flips coin', usage: 'Use `/coin` to flip a coin (Heads or Tails).' },
  { name: '/role <user> <role>', description: 'Assigns role', usage: 'Use `/role @user @role` to assign a role to a user. Requires Manage Roles permission.' },
  { name: '/audit [limit]', description: 'Views audit logs', usage: 'Use `/audit [limit]` to view recent audit logs. Defaults to 10 entries. Requires View Audit Log permission.' },
  { name: '/about', description: 'Bot info', usage: 'Use `/about` to see information about the bot.' },
  { name: '/say <message>', description: 'Bot says message', usage: 'Use `/say <message>` to make the bot send a message. Example: `/say Hello world!`.' },
  { name: '/poll <question> <options>', description: 'Creates poll', usage: 'Use `/poll <question> <options>` to create a poll. Options are comma-separated. Example: `/poll Favorite color? Red,Blue,Green`.' },
  { name: '/antiraid enable', description: 'Enables anti-raid', usage: 'Use `/antiraid enable` to turn on spam detection (auto-delete and kick). Requires Administrator permission.' },
  { name: '/antiraid disable', description: 'Disables anti-raid', usage: 'Use `/antiraid disable` to turn off spam detection. Requires Administrator permission.' },
];
client.on('guildMemberAdd', async (member) => {
  try {
    const guildId = member.guild.id;
    const cfg = settingsStore[guildId];
    if (!cfg || !cfg.verify || !cfg.verify.enabled) {
      console.log(`No verification configured for guild ${guildId}`);
      return;
    }
    const botMember = await member.guild.members.fetch(client.user.id).catch(() => null);
    if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      console.warn(`Bot lacks ManageRoles permission in guild ${guildId}`);
      return;
    }
    const rolesOnJoin = Array.isArray(cfg.verify.rolesOnJoin) ? cfg.verify.rolesOnJoin : [];
    for (const r of rolesOnJoin) {
      try {
        const role = member.guild.roles.cache.get(r) || member.guild.roles.cache.find(x => x.name === r);
        if (role) {
          await member.roles.add(role).catch(() => null);
          console.log(`Assigned role ${r} to member ${member.id} in guild ${guildId}`);
        } else {
          console.warn(`Role ${r} not found in guild ${guildId}`);
        }
      } catch (e) {
        console.error(`Failed to add role ${r} to member ${member.id} in guild ${guildId}:`, e);
      }
    }
  } catch (err) {
    console.error('Error on guildMemberAdd:', err);
  }
});
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  const cfg = settingsStore[guildId] || {};
  // Censor words
  if (cfg.censoredWords && cfg.censoredWords.some(word => message.content.toLowerCase().includes(word.toLowerCase()))) {
    try {
      await message.delete();
      await message.author.send(`Your message in ${message.guild.name} was deleted because it contained a censored word.`);
    } catch (e) {
      console.error(`Failed to delete censored message in guild ${guildId}:`, e);
    }
    return;
  }
  // Anti-raid spam detection
  if (cfg.antiraid?.enabled) {
    if (!spamTracker.has(guildId)) spamTracker.set(guildId, new Map());
    const userTracker = spamTracker.get(guildId);
    const userId = message.author.id;
    if (!userTracker.has(userId)) userTracker.set(userId, []);
    const timestamps = userTracker.get(userId);
    const now = Date.now();
    timestamps.push(now);
    // Remove old timestamps
    while (timestamps.length && timestamps[0] < now - cfg.antiraid.timeWindow) {
      timestamps.shift();
    }
    if (timestamps.length > cfg.antiraid.messageLimit) {
      // Spam detected: delete recent messages in this channel and kick
      try {
        await message.delete();
        const messagesToDelete = await message.channel.messages.fetch({ limit: 100 });
        const spamMsgs = messagesToDelete.filter(m => m.author.id === userId && m.createdTimestamp > now - cfg.antiraid.timeWindow);
        if (spamMsgs.size > 0) {
          await message.channel.bulkDelete(spamMsgs);
        }
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member && member.kickable) {
          await member.kick('Spamming detected by anti-raid');
        }
        userTracker.delete(userId);
      } catch (e) {
        console.error(`Anti-raid action failed in guild ${guildId} for user ${userId}:`, e);
      }
    }
  }
  // Prefix commands
  const prefixes = cfg.prefixes || [];
  if (prefixes.length === 0) return;
  const prefix = prefixes.find(p => message.content.startsWith(p));
  if (!prefix) return;
  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  const commandsMap = {
    ping: async () => await message.reply('Pong!'),
    help: async () => {
      const embed = new EmbedBuilder()
        .setTitle('Bot Commands')
        .setDescription('Available commands (use /usage for details):')
        .addFields(commandHelp.slice(0, 10).map(cmd => ({ name: cmd.name, value: cmd.description, inline: true })))
        .setColor(Colors.Blue);
      await message.reply({ embeds: [embed] });
    },
    coin: async () => {
      const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
      await message.reply(`The coin landed on ${result}!`);
    },
    dice: async () => {
      const sides = parseInt(args[0]) || 6;
      if (isNaN(sides) || sides < 1) return await message.reply('Please provide a valid number of sides.');
      const roll = Math.floor(Math.random() * sides) + 1;
      await message.reply(`You rolled a ${roll}! (1-${sides})`);
    },
    uptime: async () => {
      const uptime = client.uptime;
      const days = Math.floor(uptime / 86400000);
      const hours = Math.floor(uptime / 3600000) % 24;
      const minutes = Math.floor(uptime / 60000) % 60;
      const seconds = Math.floor(uptime / 1000) % 60;
      await message.reply(`Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s`);
    },
    about: async () => {
      const embed = new EmbedBuilder()
        .setTitle('About Aurox Bot')
        .setDescription('**Aurox Bot** is a multi-purpose Discord bot with moderation, verification, and fun commands.\n\n**Features**:\n- Moderation (kick, ban, mute, warn)\n- Verification with captcha/math\n- Fun commands (dice, coin, poll)\n\nCreated by **aurox.x**.\nJoin the [support server](https://discord.gg/zYfhKn5wbm) for help!')
        .setColor(Colors.Gold)
        .setTimestamp();
      await message.reply({ embeds: [embed] });
    },
  };
  if (commandsMap[commandName]) {
    try {
      await commandsMap[commandName]();
    } catch (e) {
      console.error(`Prefix command error: ${commandName}`, e);
      await message.reply({ content: 'An error occurred with this prefix command. Try the slash command instead.', ephemeral: true });
    }
  } else {
    await message.reply({ content: `Unknown prefix command: ${commandName}. Use /help for a list of commands.`, ephemeral: true });
  }
});
client.on(Events.InteractionCreate, async (interaction) => {
  const interactionAge = Date.now() - interaction.createdTimestamp;
  try {
    console.log(`Processing interaction: type=${interaction.type}, customId=${interaction.customId || 'none'}, user=${interaction.user.id}, guild=${interaction.guildId || 'none'}, isRepliable=${interaction.isRepliable()}, token=${interaction.token.slice(0, 10)}..., age=${interactionAge}ms`);
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !['ping', 'help', 'getserver', 'invite', 'verification', 'verification2', 'uptime', 'dice', 'coin', 'about', 'say', 'poll', 'usage'].includes(commandName)) {
        return interaction.reply({ content: 'You need the Manage Guild permission to use this command.', ephemeral: true });
      }
      if (commandName === 'ping') {
        return interaction.reply('Pong!');
      }
      if (commandName === 'invite') {
        const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;
        const embed = new EmbedBuilder()
          .setTitle('Invite Me!')
          .setDescription(`Add me to your server using [this invite link](${inviteUrl}).\n\nIf you like my bot, please join my [support server](https://discord.gg/zYfhKn5wbm)!`)
          .setColor(Colors.Blue)
          .setFooter({ text: 'Thank you for using the bot!' });
        return interaction.reply({ embeds: [embed] });
      }
      if (commandName === 'help') {
        const embed = new EmbedBuilder()
          .setTitle('Bot Commands')
          .setDescription('Here are all available commands:')
          .addFields(commandHelp.map(cmd => ({ name: cmd.name, value: cmd.description, inline: true })))
          .setColor(Colors.Blue)
          .setFooter({ text: 'Use /usage for detailed help!' });
        return interaction.reply({ embeds: [embed] });
      }
      if (commandName === 'getserver') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'info') {
          const guild = interaction.guild;
          const embed = new EmbedBuilder()
            .setTitle(guild.name)
            .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
            .addFields(
              { name: 'Members', value: `${guild.memberCount}`, inline: true },
              { name: 'Humans', value: `${guild.members.cache.filter(m => !m.user.bot).size}`, inline: true },
              { name: 'Bots', value: `${guild.members.cache.filter(m => m.user.bot).size}`, inline: true },
              { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
              { name: 'Roles', value: `${guild.roles.cache.size - 1}`, inline: true },
              { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true }
            )
            .setColor(Colors.Blue)
            .setFooter({ text: `Server ID: ${guild.id}` });
          return interaction.reply({ embeds: [embed] });
        } else if (subcommand === 'icon') {
          if (!interaction.guild.iconURL()) {
            return interaction.reply({ content: 'This server has no icon set.' });
          }
          const iconUrl = interaction.guild.iconURL({ dynamic: true, size: 1024 });
          const attachment = new AttachmentBuilder(iconUrl, { name: 'server-icon.png' });
          return interaction.reply({ files: [attachment] });
        }
      }
      if (commandName === 'kick') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
          return interaction.reply({ content: 'You need the Kick Members permission to use this command.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          return interaction.reply({ content: 'User not found in the server.', ephemeral: true });
        }
        if (member.id === interaction.user.id) {
          return interaction.reply({ content: 'You cannot kick yourself.', ephemeral: true });
        }
        if (member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
          return interaction.reply({ content: 'You cannot kick another moderator.', ephemeral: true });
        }
        const reason = interaction.options.getString('reason') || 'No reason provided.';
       
        await sendUserDM(user, interaction.guild, 'kicked', reason);
       
        try {
          await member.kick(reason);
          return interaction.reply({ content: `Successfully kicked ${user.tag} from the server. Reason: ${reason}` });
        } catch (error) {
          console.error('Failed to kick member:', error);
          return interaction.reply({ content: 'Failed to kick the user. Check bot permissions and role hierarchy.', ephemeral: true });
        }
      }
      if (commandName === 'ban') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
          return interaction.reply({ content: 'You need the Ban Members permission to use this command.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided.';
       
        await sendUserDM(user, interaction.guild, 'banned', reason);
       
        try {
          await interaction.guild.members.ban(user, { reason });
          return interaction.reply({ content: `Successfully banned ${user.tag} from the server. Reason: ${reason}` });
        } catch (error) {
          console.error('Failed to ban member:', error);
          return interaction.reply({ content: 'Failed to ban the user. Check bot permissions and role hierarchy.', ephemeral: true });
        }
      }
      if (commandName === 'warn') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You need the Moderate Members permission to use this command.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
       
        if (!member) {
          return interaction.reply({ content: 'User not found in the server.', ephemeral: true });
        }
        if (member.id === interaction.user.id) {
          return interaction.reply({ content: 'You cannot warn yourself.', ephemeral: true });
        }
        if (member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You cannot warn another moderator.', ephemeral: true });
        }
        const warning = addWarning(interaction.guild.id, user.id, reason, interaction.user.id);
        const dmSent = await sendUserDM(user, interaction.guild, 'warned', reason);
        const warnings = getWarnings(interaction.guild.id, user.id);
       
        const embed = new EmbedBuilder()
          .setTitle('User Warned')
          .setDescription(`**User:** ${user.tag} (${user.id})\n**Reason:** ${reason}\n**Total Warnings:** ${warnings.length}`)
          .setColor(Colors.Yellow)
          .setFooter({ text: `Warned by ${interaction.user.tag}` })
          .setTimestamp();
       
        if (!dmSent) {
          embed.addFields({ name: 'Note', value: 'Could not send DM to user.' });
        }
       
        return interaction.reply({ embeds: [embed] });
      }
      if (commandName === 'warnings') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You need the Moderate Members permission to use this command.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const warnings = getWarnings(interaction.guild.id, user.id);
       
        if (warnings.length === 0) {
          return interaction.reply({ content: `${user.tag} has no warnings.`, ephemeral: true });
        }
       
        const embed = new EmbedBuilder()
          .setTitle(`Warnings for ${user.tag}`)
          .setColor(Colors.Yellow)
          .setFooter({ text: `Total: ${warnings.length} warning(s)` });
       
        warnings.forEach((warning, index) => {
          const moderator = interaction.guild.members.cache.get(warning.moderatorId)?.user.tag || 'Unknown';
          embed.addFields({
            name: `Warning #${index + 1}`,
            value: `**Reason:** ${warning.reason}\n**Moderator:** ${moderator}\n**Date:** <t:${Math.floor(warning.timestamp / 1000)}:R>`,
            inline: false
          });
        });
       
        return interaction.reply({ embeds: [embed] });
      }
      if (commandName === 'clearwarnings') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You need the Moderate Members permission to use this command.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const cleared = clearWarnings(interaction.guild.id, user.id);
       
        if (cleared) {
          return interaction.reply({ content: `Cleared all warnings for ${user.tag}.`, ephemeral: true });
        } else {
          return interaction.reply({ content: `${user.tag} has no warnings to clear.`, ephemeral: true });
        }
      }
      if (commandName === 'mute') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You need the Moderate Members permission to use this command.', ephemeral: true });
        }
        const targetUser = interaction.options.getUser('user');
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
          return interaction.reply({ content: 'User not found in the server.', ephemeral: true });
        }
        if (targetMember.id === interaction.user.id) {
          return interaction.reply({ content: 'You cannot mute yourself.', ephemeral: true });
        }
        if (targetMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You cannot mute another moderator.', ephemeral: true });
        }
        const minutes = interaction.options.getInteger('minutes') || 0;
        const hours = interaction.options.getInteger('hours') || 0;
        const days = interaction.options.getInteger('days') || 0;
        const totalMs = (days * 24 * 60 * 60 * 1000) + (hours * 60 * 60 * 1000) + (minutes * 60 * 1000);
        if (totalMs === 0) {
          return interaction.reply({ content: 'You must specify at least one duration (minutes, hours, or days).', ephemeral: true });
        }
        if (totalMs > 28 * 24 * 60 * 60 * 1000) {
          return interaction.reply({ content: 'Timeout duration cannot exceed 28 days.', ephemeral: true });
        }
        const reason = interaction.options.getString('reason') || 'No reason provided.';
        try {
          await targetMember.timeout(totalMs, reason);
          return interaction.reply({ content: `Successfully muted ${targetUser.tag} for ${days} days, ${hours} hours, and ${minutes} minutes. Reason: ${reason}` });
        } catch (error) {
          console.error('Failed to mute member:', error);
          return interaction.reply({ content: 'Failed to mute the user. Check bot permissions and ensure the bot’s role is above the target’s.', ephemeral: true });
        }
      }
      if (commandName === 'unmute') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          return interaction.reply({ content: 'You need the Moderate Members permission to use this command.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          return interaction.reply({ content: 'User not found in the server.', ephemeral: true });
        }
        if (!member.isCommunicationDisabled()) {
          return interaction.reply({ content: 'This user is not currently muted.', ephemeral: true });
        }
        try {
          await member.timeout(null, 'Unmuted');
          return interaction.reply({ content: `Successfully unmuted ${user.tag}.` });
        } catch (error) {
          console.error('Failed to unmute member:', error);
          return interaction.reply({ content: 'Failed to unmute the user. Check bot permissions and ensure the bot’s role is above the target’s.', ephemeral: true });
        }
      }
      if (commandName === 'verify-setup') {
        const channel = interaction.options.getChannel('channel');
        if (!channel.isTextBased()) {
          return interaction.reply({ content: 'The selected channel must be a text-based channel.', ephemeral: true });
        }
        const prompt = interaction.options.getString('prompt') || 'Click Verify to start. You will receive a captcha to solve.';
        const ping = interaction.options.getString('ping') || '';
        const embedTitle = interaction.options.getString('embed_title') || 'VERIFICATION SECTION';
        const embedColor = interaction.options.getString('embed_color') || '#0099ff';
        const imageUrl = interaction.options.getString('image_url') || '';
        const rolesOnJoinStr = interaction.options.getString('roles_on_join') || '';
        const rolesOnVerifyStr = interaction.options.getString('roles_on_verify') || '';
        const rolesOnJoin = rolesOnJoinStr ? rolesOnJoinStr.split(',').map(r => r.trim()).filter(Boolean) : [];
        const rolesOnVerify = rolesOnVerifyStr ? rolesOnVerifyStr.split(',').map(r => r.trim()).filter(Boolean) : [];
        const botMember = await interaction.guild.members.fetch(client.user.id).catch(() => null);
        if (!botMember || !channel.permissionsFor(botMember).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks])) {
          return interaction.reply({ content: 'Bot lacks necessary permissions in the selected channel.', ephemeral: true });
        }
        settingsStore[interaction.guild.id] = settingsStore[interaction.guild.id] || {};
        const oldCfg = settingsStore[interaction.guild.id].verify;
        settingsStore[interaction.guild.id].verify = {
          enabled: true,
          channelId: channel.id,
          prompt: prompt,
          ping: ping,
          embedTitle: embedTitle,
          embedColor: embedColor,
          gifURL: imageUrl,
          rolesOnJoin: rolesOnJoin,
          rolesOnVerify: rolesOnVerify
        };
        if (oldCfg?.messageId && oldCfg.channelId) {
          const oldChannel = await interaction.guild.channels.fetch(oldCfg.channelId).catch(() => null);
          if (oldChannel) {
            try {
              await oldChannel.messages.delete(oldCfg.messageId).catch(() => null);
            } catch (e) {
              console.error(`Failed to delete old verification message:`, e);
            }
          }
        }
        const verifyButton = new ButtonBuilder()
          .setCustomId('verify')
          .setLabel('Verify')
          .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(verifyButton);
        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setDescription(prompt)
          .setColor(embedColor);
        if (imageUrl) embed.setImage(imageUrl);
        try {
          const message = await channel.send({
            content: ping,
            embeds: [embed],
            components: [row]
          });
          settingsStore[interaction.guild.id].verify.messageId = message.id;
          settingsStore[interaction.guild.id].verify.lastSent = Date.now();
          saveSettings();
          return interaction.reply({ content: `Verification setup complete! Message sent to ${channel}.`, ephemeral: true });
        } catch (e) {
          console.error('Failed to send verification message:', e);
          return interaction.reply({ content: 'Failed to send verification message. Check bot permissions.', ephemeral: true });
        }
      }
      if (commandName === 'verify-test') {
        const cfg = settingsStore[interaction.guild.id]?.verify;
        if (!cfg || !cfg.enabled || !cfg.channelId) {
          return interaction.reply({ content: 'Verification is not set up. Use /verify-setup first.', ephemeral: true });
        }
        const channel = await interaction.guild.channels.fetch(cfg.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          return interaction.reply({ content: 'Verification channel is invalid.', ephemeral: true });
        }
        const botMember = await interaction.guild.members.fetch(client.user.id).catch(() => null);
        if (!botMember || !channel.permissionsFor(botMember).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks])) {
          return interaction.reply({ content: 'Bot lacks necessary permissions in the verification channel.', ephemeral: true });
        }
        const prompt = cfg.prompt || 'Click Verify to start. You will receive a captcha to solve.';
        const ping = cfg.ping || '';
        const embedTitle = cfg.embedTitle || 'VERIFICATION SECTION';
        const embedColor = cfg.embedColor || '#0099ff';
        const gifURL = cfg.gifURL || '';
        const verifyButton = new ButtonBuilder()
          .setCustomId('verify')
          .setLabel('Verify')
          .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(verifyButton);
        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setDescription(prompt)
          .setColor(embedColor);
        if (gifURL) embed.setImage(gifURL);
        try {
          await channel.send({
            content: ping,
            embeds: [embed],
            components: [row]
          });
          return interaction.reply({ content: `Test verification message sent to ${channel}!`, ephemeral: true });
        } catch (e) {
          console.error('Failed to send test verification message:', e);
          return interaction.reply({ content: 'Failed to send test message. Check bot permissions.', ephemeral: true });
        }
      }
      if (commandName === 'verify-disable') {
        const cfg = settingsStore[interaction.guild.id]?.verify;
        if (!cfg || !cfg.enabled) {
          return interaction.reply({ content: 'Verification is already disabled.', ephemeral: true });
        }
        if (cfg.messageId && cfg.channelId) {
          const channel = await interaction.guild.channels.fetch(cfg.channelId).catch(() => null);
          if (channel) {
            try {
              await channel.messages.delete(cfg.messageId).catch(() => null);
            } catch (e) {
              console.error(`Failed to delete verification message:`, e);
            }
          }
        }
        settingsStore[interaction.guild.id].verify.enabled = false;
        delete settingsStore[interaction.guild.id].verify.messageId;
        saveSettings();
        return interaction.reply({ content: 'Verification disabled and message deleted.', ephemeral: true });
      }
      if (commandName === 'verification') {
        const type = interaction.options.getString('type');
        const length = interaction.options.getInteger('length');
        const code = randomText(length, type);
        const embed = new EmbedBuilder()
          .setTitle('Verification Code')
          .setDescription(`Your verification code is: **${code}**\n\nPlease use this code to verify your identity.`)
          .setColor(Colors.Blue)
          .setFooter({ text: 'This code is for testing purposes.' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (commandName === 'verification2') {
        const { question, answer } = generateMathQuestion();
        const key = `${interaction.guildId}:${interaction.user.id}:math`;
        captchaMap.set(key, { answer, expires: Date.now() + 1000 * 60 * 5 });
        const modal = new ModalBuilder()
          .setCustomId(`math_modal_${interaction.user.id}`)
          .setTitle('Math Verification')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('math_answer')
                .setLabel(`Solve: ${question}`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        try {
          await interaction.showModal(modal);
        } catch (e) {
          console.error(`Failed to show math modal for user ${interaction.user.id}:`, e);
          return interaction.reply({ content: 'Failed to show math question. Please try again.', ephemeral: true });
        }
      }
      if (commandName === 'cw') {
        const word = interaction.options.getString('word');
        settingsStore[interaction.guild.id] = settingsStore[interaction.guild.id] || {};
        settingsStore[interaction.guild.id].censoredWords = settingsStore[interaction.guild.id].censoredWords || [];
        if (!settingsStore[interaction.guild.id].censoredWords.includes(word)) {
          settingsStore[interaction.guild.id].censoredWords.push(word);
          saveSettings();
          return interaction.reply({ content: `Added "${word}" to censored words.`, ephemeral: true });
        } else {
          return interaction.reply({ content: `"${word}" is already censored.`, ephemeral: true });
        }
      }
      if (commandName === 'ucw') {
        const word = interaction.options.getString('word');
        settingsStore[interaction.guild.id] = settingsStore[interaction.guild.id] || {};
        settingsStore[interaction.guild.id].censoredWords = settingsStore[interaction.guild.id].censoredWords || [];
        const index = settingsStore[interaction.guild.id].censoredWords.indexOf(word);
        if (index !== -1) {
          settingsStore[interaction.guild.id].censoredWords.splice(index, 1);
          saveSettings();
          return interaction.reply({ content: `Removed "${word}" from censored words.`, ephemeral: true });
        } else {
          return interaction.reply({ content: `"${word}" is not censored.`, ephemeral: true });
        }
      }
      if (commandName === 'cwl') {
        settingsStore[interaction.guild.id] = settingsStore[interaction.guild.id] || {};
        const words = settingsStore[interaction.guild.id].censoredWords || [];
        if (words.length === 0) {
          return interaction.reply({ content: 'No censored words.', ephemeral: true });
        }
        const embed = new EmbedBuilder()
          .setTitle('Censored Words')
          .setDescription(words.join(', '))
          .setColor(Colors.Red);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (commandName === 'prefix') {
        const subcommand = interaction.options.getSubcommand();
        settingsStore[interaction.guild.id] = settingsStore[interaction.guild.id] || {};
        settingsStore[interaction.guild.id].prefixes = settingsStore[interaction.guild.id].prefixes || [];
        if (subcommand === 'add') {
          const prefix = interaction.options.getString('prefix');
          if (!settingsStore[interaction.guild.id].prefixes.includes(prefix)) {
            settingsStore[interaction.guild.id].prefixes.push(prefix);
            saveSettings();
            return interaction.reply({ content: `Added prefix "${prefix}".`, ephemeral: true });
          } else {
            return interaction.reply({ content: `Prefix "${prefix}" already exists.`, ephemeral: true });
          }
        } else if (subcommand === 'remove') {
          const prefix = interaction.options.getString('prefix');
          const index = settingsStore[interaction.guild.id].prefixes.indexOf(prefix);
          if (index !== -1) {
            settingsStore[interaction.guild.id].prefixes.splice(index, 1);
            saveSettings();
            return interaction.reply({ content: `Removed prefix "${prefix}".`, ephemeral: true });
          } else {
            return interaction.reply({ content: `Prefix "${prefix}" not found.`, ephemeral: true });
          }
        } else if (subcommand === 'list') {
          const prefixes = settingsStore[interaction.guild.id].prefixes;
          if (prefixes.length === 0) {
            return interaction.reply({ content: 'No prefixes set.', ephemeral: true });
          }
          const embed = new EmbedBuilder()
            .setTitle('Prefixes')
            .setDescription(prefixes.join(', '))
            .setColor(Colors.Blue);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        } else if (subcommand === 'clear') {
          settingsStore[interaction.guild.id].prefixes = [];
          saveSettings();
          return interaction.reply({ content: 'Cleared all prefixes.', ephemeral: true });
        }
      }
      if (commandName === 'usage') {
        const specificCommand = interaction.options.getString('command')?.toLowerCase();
        const embed = new EmbedBuilder()
          .setTitle('Command Usage')
          .setColor(Colors.Green);
        if (specificCommand) {
          const cmd = commandHelp.find(c => c.name.toLowerCase() === specificCommand || c.name.toLowerCase().startsWith(specificCommand));
          if (!cmd) {
            return interaction.reply({ content: `Command "${specificCommand}" not found. Use /usage for all commands.`, ephemeral: true });
          }
          embed.setDescription(`**${cmd.name}**\n${cmd.usage}`);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        const perPage = 5;
        let page = 0;
        const totalPages = Math.ceil(commandHelp.length / perPage);
        const updateEmbed = () => {
          embed.setDescription('');
          const start = page * perPage;
          const end = start + perPage;
          commandHelp.slice(start, end).forEach(cmd => {
            embed.addFields({ name: cmd.name, value: cmd.usage, inline: false });
          });
          embed.setFooter({ text: `Page ${page + 1}/${totalPages}` });
        };
        updateEmbed();
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('prev_usage').setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('next_usage').setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
          );
        try {
          const msg = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true, fetchReply: true });
          const collector = msg.createMessageComponentCollector({ time: 60000 });
          collector.on('collect', async (i) => {
            if (i.user.id !== interaction.user.id) {
              return i.reply({ content: 'This button is not for you.', ephemeral: true });
            }
            if (i.customId === 'prev_usage') page--;
            if (i.customId === 'next_usage') page++;
            updateEmbed();
            try {
              await i.update({ embeds: [embed], components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('prev_usage').setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                  new ButtonBuilder().setCustomId('next_usage').setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
                )
              ] });
            } catch (e) {
              console.error('Failed to update usage embed:', e);
            }
          });
          collector.on('end', () => {
            try {
              msg.edit({ components: [] }).catch(() => {});
            } catch (e) {
              console.error('Failed to disable usage buttons:', e);
            }
          });
        } catch (e) {
          console.error('Failed to send usage embed:', e);
          return interaction.reply({ content: 'Failed to display usage. Check bot permissions.', ephemeral: true });
        }
      }
      if (commandName === 'lock') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
          return interaction.reply({ content: 'You need Manage Channels permission.', ephemeral: true });
        }
        let channel = interaction.options.getChannel('channel') || interaction.channel;
        if (channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Must be a text channel.', ephemeral: true });
        }
        try {
          await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
            SendMessages: false,
            AttachFiles: false
          });
          await channel.send('# CHANNEL LOCK');
          return interaction.reply({ content: `Locked ${channel}.`, ephemeral: true });
        } catch (e) {
          console.error('Failed to lock channel:', e);
          return interaction.reply({ content: 'Failed to lock channel. Check permissions.', ephemeral: true });
        }
      }
      if (commandName === 'unlock') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
          return interaction.reply({ content: 'You need Manage Channels permission.', ephemeral: true });
        }
        let channel = interaction.options.getChannel('channel') || interaction.channel;
        if (channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Must be a text channel.', ephemeral: true });
        }
        try {
          await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
            SendMessages: null,
            AttachFiles: null
          });
          await channel.send('# CHANNEL UNLOCK');
          return interaction.reply({ content: `Unlocked ${channel}.`, ephemeral: true });
        } catch (e) {
          console.error('Failed to unlock channel:', e);
          return interaction.reply({ content: 'Failed to unlock channel. Check permissions.', ephemeral: true });
        }
      }
      if (commandName === 'uptime') {
        const uptime = client.uptime;
        const days = Math.floor(uptime / 86400000);
        const hours = Math.floor(uptime / 3600000) % 24;
        const minutes = Math.floor(uptime / 60000) % 60;
        const seconds = Math.floor(uptime / 1000) % 60;
        return interaction.reply(`Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s`);
      }
      if (commandName === 'dice') {
        const sides = interaction.options.getInteger('sides') || 6;
        const roll = Math.floor(Math.random() * sides) + 1;
        return interaction.reply(`You rolled a ${roll}! (1-${sides})`);
      }
      if (commandName === 'coin') {
        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
        return interaction.reply(`The coin landed on ${result}!`);
      }
      if (commandName === 'role') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.reply({ content: 'You need Manage Roles permission.', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          return interaction.reply({ content: 'User not found.', ephemeral: true });
        }
        try {
          await member.roles.add(role);
          return interaction.reply({ content: `Assigned ${role.name} to ${user.tag}.` });
        } catch (e) {
          console.error('Failed to assign role:', e);
          return interaction.reply({ content: 'Failed to assign role. Check hierarchy.', ephemeral: true });
        }
      }
      if (commandName === 'audit') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
          return interaction.reply({ content: 'You need View Audit Log permission.', ephemeral: true });
        }
        const limit = interaction.options.getInteger('limit') || 10;
        try {
          const logs = await interaction.guild.fetchAuditLogs({ limit });
          const embed = new EmbedBuilder()
            .setTitle('Audit Logs')
            .setColor(Colors.Purple);
          logs.entries.forEach((entry) => {
            embed.addFields({
              name: `${entry.action} by ${entry.executor.tag}`,
              value: `Target: ${entry.target?.tag || 'N/A'}\nReason: ${entry.reason || 'N/A'}\nTime: <t:${Math.floor(entry.createdTimestamp / 1000)}:R>`,
              inline: false
            });
          });
          return interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (e) {
          console.error('Failed to fetch audit logs:', e);
          return interaction.reply({ content: 'Failed to fetch audit logs. Check permissions.', ephemeral: true });
        }
      }
      if (commandName === 'about') {
        try {
          const embed = new EmbedBuilder()
            .setTitle('About Aurox Bot')
            .setDescription('**Aurox Bot** is a multi-purpose Discord bot with moderation, verification, and fun commands.\n\n**Features**:\n- Moderation (kick, ban, mute, warn)\n- Verification with captcha/math\n- Fun commands (dice, coin, poll)\n\nCreated by **aurox.x**.\nJoin the [support server](https://discord.gg/zYfhKn5wbm) for help!')
            .setColor(Colors.Gold)
            .setTimestamp();
          return interaction.reply({ embeds: [embed] });
        } catch (e) {
          console.error('Failed to send about embed:', e);
          return interaction.reply({ content: 'Failed to display bot info. Check bot permissions.', ephemeral: true });
        }
      }
      if (commandName === 'say') {
        const msg = interaction.options.getString('message');
        try {
          await interaction.channel.send(msg);
          return interaction.reply({ content: 'Message sent.', ephemeral: true });
        } catch (e) {
          console.error('Failed to send say message:', e);
          return interaction.reply({ content: 'Failed to send message. Check bot permissions.', ephemeral: true });
        }
      }
      if (commandName === 'poll') {
        const question = interaction.options.getString('question');
        const optionsStr = interaction.options.getString('options');
        const options = optionsStr.split(',').map(o => o.trim());
        try {
          const embed = new EmbedBuilder()
            .setTitle('Poll: ' + question)
            .setDescription(options.map((o, i) => `${i+1}. ${o}`).join('\n'))
            .setColor(Colors.Green);
          const pollMsg = await interaction.reply({ embeds: [embed], fetchReply: true });
          for (let i = 1; i <= Math.min(options.length, 10); i++) {
            await pollMsg.react(`${i}️⃣`);
          }
        } catch (e) {
          console.error('Failed to create poll:', e);
          return interaction.reply({ content: 'Failed to create poll. Check bot permissions.', ephemeral: true });
        }
      }
      if (commandName === 'antiraid') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
        }
        const subcommand = interaction.options.getSubcommand();
        settingsStore[guildId] = settingsStore[guildId] || {};
        settingsStore[guildId].antiraid = settingsStore[guildId].antiraid || { enabled: false, messageLimit: 5, timeWindow: 10000 };
        if (subcommand === 'enable') {
          settingsStore[guildId].antiraid.enabled = true;
          saveSettings();
          return interaction.reply({ content: 'Anti-raid enabled. Spam detection active (5 msgs/10s threshold).', ephemeral: true });
        } else if (subcommand === 'disable') {
          settingsStore[guildId].antiraid.enabled = false;
          saveSettings();
          return interaction.reply({ content: 'Anti-raid disabled.', ephemeral: true });
        }
      }
    }
    if (interaction.isButton() && (interaction.customId === 'prev_usage' || interaction.customId === 'next_usage')) {
      // command coll3ct
      return;
    }
    if (interaction.isButton() && interactionAge > 15000) {
      console.warn(`Interaction expired: type=${interaction.type}, customId=${interaction.customId}, user=${interaction.user.id}, age=${interactionAge}ms`);
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This interaction has expired. Please click Verify again.', ephemeral: true });
      }
      return;
    }
    if (interaction.isButton() && interaction.customId === 'verify') {
      const guildId = interaction.guildId;
      const cfg = settingsStore[guildId];
      if (!cfg || !cfg.verify || !cfg.verify.enabled || !cfg.verify.channelId) {
        console.warn(`Verification not configured or disabled for guild ${guildId}`);
        await interaction.reply({ content: 'Verification is not enabled for this server. Contact an admin.', ephemeral: true });
        return;
      }
      const channel = await interaction.guild.channels.fetch(cfg.verify.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.warn(`Verify channel ${cfg.verify.channelId} invalid for guild ${guildId}`);
        await interaction.reply({ content: 'Verification channel is invalid. Contact an admin.', ephemeral: true });
        return;
      }
      const botMember = await interaction.guild.members.fetch(client.user.id).catch(() => null);
      if (!botMember || !channel.permissionsFor(botMember).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) {
        console.warn(`Bot lacks ViewChannel, SendMessages, or EmbedLinks permissions in channel ${cfg.verify.channelId} for guild ${guildId}`);
        await interaction.reply({ content: 'Bot lacks permissions to send messages in the verification channel.', ephemeral: true });
        return;
      }
      const answer = randomText(4);
      const avatarURL = interaction.user.displayAvatarURL({ extension: 'png', size: 256 });
      let buffer, text;
      try {
        ({ buffer, text } = await createCaptchaImage({ text: answer, avatarURL }));
      } catch (e) {
        console.error(`Failed to generate captcha for ${guildId}:${interaction.user.id}:`, e);
        await interaction.reply({ content: 'Failed to generate captcha. Please try again.', ephemeral: true });
        return;
      }
      const key = `${guildId}:${interaction.user.id}`;
      captchaMap.set(key, { answer, expires: Date.now() + 1000 * 60 * 5 });
      console.log(`Generated captcha for ${key}: ${answer} (length: ${answer.length}, raw: ${JSON.stringify(answer)})`);
      const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });
      const enter = new ButtonBuilder()
        .setCustomId(`enter_${interaction.user.id}`)
        .setLabel('Enter solution')
        .setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(enter);
      await interaction.reply({
        content: 'Solve the captcha shown below and click *Enter solution* to type your answer.',
        files: [attachment],
        components: [row],
        ephemeral: true
      });
      console.log(`Sent captcha response to user ${interaction.user.id} in guild ${guildId}`);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('enter_')) {
      const userId = interaction.customId.split('_')[1];
      if (userId !== interaction.user.id) {
        await interaction.reply({ content: 'This button is not for you.', ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`modal_${interaction.user.id}`)
        .setTitle('Enter Captcha')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('captcha_answer')
              .setLabel('Captcha Answer')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      try {
        await interaction.showModal(modal);
      } catch (e) {
        console.error(`Failed to show captcha modal for user ${interaction.user.id}:`, e);
        await interaction.reply({ content: 'Failed to show captcha input. Please try again.', ephemeral: true });
      }
      return;
    }
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('modal_')) {
      const userId = interaction.customId.split('_')[1];
      if (userId !== interaction.user.id) {
        await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
        return;
      }
      const rawAnswer = interaction.fields.getTextInputValue('captcha_answer');
      const answer = rawAnswer.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const stored = captchaMap.get(key);
      if (!stored) {
        console.warn(`No captcha found for ${key}`);
        await interaction.reply({ content: 'No captcha found or it expired. Please click Verify again.', ephemeral: true });
        return;
      }
      if (Date.now() > stored.expires) {
        console.warn(`Captcha expired for ${key}`);
        captchaMap.delete(key);
        await interaction.reply({ content: 'Captcha expired. Please click Verify again.', ephemeral: true });
        return;
      }
      console.log(`Comparing in guild ${interaction.guildId}: raw='${rawAnswer}', sanitized='${answer}', stored='${stored.answer}'`);
      if (answer === stored.answer.toUpperCase()) {
        const cfg = settingsStore[interaction.guildId];
        const rolesOnJoin = Array.isArray(cfg?.verify?.rolesOnJoin) ? cfg.verify.rolesOnJoin : [];
        const rolesOnVerify = Array.isArray(cfg?.verify?.rolesOnVerify) ? cfg.verify.rolesOnVerify : [];
        const botMember = await interaction.guild.members.fetch(client.user.id).catch(() => null);
        if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          console.error(`Bot lacks ManageRoles permission in guild ${interaction.guildId}`);
          await interaction.reply({ content: 'Bot lacks permission to manage roles. Contact an admin.', ephemeral: true });
          return;
        }
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) {
          console.error(`Member ${interaction.user.id} not found in guild ${interaction.guildId}`);
          await interaction.reply({ content: 'Member not found in guild.', ephemeral: true });
          return;
        }
        for (const r of rolesOnJoin) {
          try {
            const role = interaction.guild.roles.cache.get(r) || interaction.guild.roles.cache.find(x => x.name === r);
            if (role && !rolesOnVerify.includes(role.id) && !rolesOnVerify.includes(role.name)) {
              await member.roles.remove(role).catch(() => null);
              console.log(`Removed role ${r} from member ${interaction.user.id} in guild ${interaction.guildId}`);
            }
          } catch (e) {
            console.error(`Failed to remove role ${r} from member ${interaction.user.id} in guild ${interaction.guildId}:`, e);
          }
        }
        for (const r of rolesOnVerify) {
          try {
            const role = interaction.guild.roles.cache.get(r) || interaction.guild.roles.cache.find(x => x.name === r);
            if (role) {
              await member.roles.add(role).catch(() => null);
              console.log(`Added role ${r} to member ${interaction.user.id} in guild ${interaction.guildId}`);
            } else {
              console.warn(`Role ${r} not found in guild ${interaction.guildId}`);
            }
          } catch (e) {
            console.error(`Failed to add role ${r} to member ${interaction.user.id} in guild ${interaction.guildId}:`, e);
          }
        }
        captchaMap.delete(key);
        await interaction.reply({ content: '✅ Verified! Roles have been updated.', ephemeral: true });
        console.log(`User ${interaction.user.id} verified in guild ${interaction.guildId}`);
      } else {
        captchaMap.delete(key);
        await interaction.reply({ content: '❌ Wrong answer. Click **Verify** again to get a new captcha.', ephemeral: true });
        console.log(`User ${interaction.user.id} failed captcha in guild ${interaction.guildId}: expected ${stored.answer}, got ${answer}`);
      }
      return;
    }
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('math_modal_')) {
      const userId = interaction.customId.split('_')[2];
      if (userId !== interaction.user.id) {
        await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
        return;
      }
      const answer = interaction.fields.getTextInputValue('math_answer');
      const key = `${interaction.guildId}:${interaction.user.id}:math`;
      const stored = captchaMap.get(key);
      if (!stored) {
        console.warn(`No math question found for ${key}`);
        await interaction.reply({ content: 'No math question found or it expired. Use /verification2 again.', ephemeral: true });
        return;
      }
      if (Date.now() > stored.expires) {
        console.warn(`Math question expired for ${key}`);
        captchaMap.delete(key);
        await interaction.reply({ content: 'Math question expired. Use /verification2 again.', ephemeral: true });
        return;
      }
      if (parseInt(answer) === stored.answer) {
        captchaMap.delete(key);
        await interaction.reply({ content: '✅ Correct! You passed the math verification.', ephemeral: true });
        console.log(`User ${interaction.user.id} passed math verification in guild ${interaction.guildId}`);
      } else {
        captchaMap.delete(key);
        await interaction.reply({ content: '❌ Wrong answer. Use /verification2 to try again.', ephemeral: true });
        console.log(`User ${interaction.user.id} failed math verification in guild ${interaction.guildId}: expected ${stored.answer}, got ${answer}`);
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('enter_')) {
      const userId = interaction.customId.split('_')[1];
      if (userId !== interaction.user.id) {
        await interaction.reply({ content: 'This enter button is not for you.', ephemeral: true });
        return;
      }
      if (!interaction.isRepliable()) {
        console.warn(`Cannot show modal: Interaction not repliable for user ${interaction.user.id}, customId=${interaction.customId}, token=${interaction.token.slice(0, 10)}..., age=${interactionAge}ms`);
        await interaction.followUp({ content: 'Unable to show captcha modal. Please try again.', ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`modal_${interaction.user.id}`)
        .setTitle('Enter captcha')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('captcha_answer')
              .setLabel('Captcha text')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      let attempts = 2;
      while (attempts > 0) {
        try {
          await interaction.showModal(modal);
          console.log(`Showed captcha modal to user ${interaction.user.id} in guild ${interaction.guildId}`);
          return;
        } catch (e) {
          console.error(`Attempt ${3 - attempts}/2: Failed to show modal for user ${interaction.user.id} in guild ${interaction.guildId}: ${e.message} (code: ${e.code || 'unknown'})`);
          attempts--;
          if (attempts === 0) {
            await interaction.reply({ content: 'Failed to show captcha modal after retries. Please try again.', ephemeral: true });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  } catch (err) {
    console.error(`Interaction handler error for type=${interaction.type}, customId=${interaction.customId || 'none'}, user=${interaction.user.id}, guild=${interaction.guildId || 'none'}, token=${interaction.token?.slice(0, 10) || 'none'}..., age=${interactionAge}ms: ${err.message} (code: ${err.code || 'unknown'})`);
    if (interaction && !interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true }); } catch (e) {}
    }
  }
});
// ... always same ig
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));
app.use(express.static('.'));
function isAuthenticated(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!allowedUserIds.includes(req.session.user.id)) return res.status(403).json({ error: 'Access denied: Unauthorized user' });
  return next();
}
app.get('/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => { res.redirect('/'); });
});
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided.');
  try {
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const accessToken = tokenRes.data.access_token;
    const me = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } }).then(r => r.data);
    const guilds = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${accessToken}` } }).then(r => r.data);
    if (!allowedUserIds.includes(me.id)) return res.status(403).send('Access denied: Unauthorized user');
    req.session.user = me;
    req.session.guilds = guilds;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err?.response?.data || err);
    res.status(500).send('OAuth failed');
  }
});
app.get('/api/me', isAuthenticated, (req, res) => {
  return res.json({ user: req.session.user, guilds: req.session.guilds || [] });
});
app.get('/api/server/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;
  try {
    const guild = await client.guilds.fetch(id).catch(() => null);
    if (!guild) return res.status(404).json({ error: 'Guild not found or bot not in guild' });
    const members = await guild.members.fetch().catch(() => null);
    const humans = members ? members.filter(m => !m.user.bot).size : 0;
    const bots = members ? members.filter(m => m.user.bot).size : 0;
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
    const channels = guild.channels.cache
      .filter(c => c.isTextBased())
      .map(c => ({ id: c.id, name: c.name, type: c.type }));
    const payload = {
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount || (members ? members.size : 0),
      humans,
      bots,
      roles,
      channels,
      settings: settingsStore[guild.id] || {}
    };
    return res.json(payload);
  } catch (err) {
    console.error(`Fetch guild info error for guild ${id}:`, err);
    return res.status(500).json({ error: 'Failed to fetch guild info' });
  }
});
app.post('/api/settings', isAuthenticated, async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.guildId) return res.status(400).json({ error: 'guildId required' });
    const guildId = body.guildId;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: 'Guild not found or bot not present' });
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member) return res.status(403).json({ error: 'You must be a guild member' });
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return res.status(403).json({ error: 'Manage Guild permission required' });
    }
    settingsStore[guildId] = settingsStore[guildId] || {};
    const oldChannelId = settingsStore[guildId].verify?.channelId;
    settingsStore[guildId].verify = body.verify || settingsStore[guildId].verify || { enabled: false };
    if (settingsStore[guildId].verify.enabled && (!settingsStore[guildId].verify.channelId || body.verify.channelId !== oldChannelId || !settingsStore[guildId].verify.messageId)) {
      const channel = await guild.channels.fetch(body.verify.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return res.status(400).json({ error: `Invalid or non-text channel: ${body.verify.channelId}` });
      }
      const botMember = await guild.members.fetch(client.user.id).catch(() => null);
      if (!botMember || !channel.permissionsFor(botMember).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks])) {
        return res.status(403).json({ error: `Bot lacks ViewChannel, SendMessages, ReadMessageHistory, or EmbedLinks permissions in channel ${body.verify.channelId}` });
      }
      if (settingsStore[guildId].verify.messageId && oldChannelId) {
        const oldChannel = await guild.channels.fetch(oldChannelId).catch(() => null);
        if (oldChannel) {
          try {
            await oldChannel.messages.delete(settingsStore[guildId].verify.messageId).catch(() => null);
            console.log(`Deleted old verification message in guild ${guildId}, channel ${oldChannelId}`);
          } catch (e) {
            console.error(`Failed to delete old verification message in guild ${guildId}:`, e);
          }
        }
      }
      const prompt = body.verify.prompt || 'Click Verify to start. You will receive a captcha to solve.';
      const ping = body.verify.ping || '';
      const embedTitle = body.verify.embedTitle || 'VERIFICATION SECTION';
      const embedColor = body.verify.embedColor || '#0099ff';
      const gifURL = body.verify.gifURL || '';
      const verifyButton = new ButtonBuilder()
        .setCustomId('verify')
        .setLabel('Verify')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(verifyButton);
      const embed = new EmbedBuilder()
        .setTitle(embedTitle)
        .setDescription(prompt)
        .setColor(embedColor);
      if (gifURL) embed.setImage(gifURL);
      try {
        const message = await channel.send({
          content: ping,
          embeds: [embed],
          components: [row]
        });
        settingsStore[guildId].verify.messageId = message.id;
        console.log(`Sent new verification message in guild ${guildId}, channel ${body.verify.channelId}, message ID: ${message.id}`);
      } catch (e) {
        console.error(`Failed to send verification message in guild ${guildId}:`, e);
        return res.status(500).json({ error: 'Failed to send verification message' });
      }
    } else if (!settingsStore[guildId].verify.enabled && settingsStore[guildId].verify.messageId) {
      const channel = await guild.channels.fetch(oldChannelId).catch(() => null);
      if (channel) {
        try {
          await channel.messages.delete(settingsStore[guildId].verify.messageId).catch(() => null);
          console.log(`Deleted verification message in guild ${guildId}, channel ${oldChannelId}`);
        } catch (e) {
          console.error(`Failed to delete verification message in guild ${guildId}:`, e);
        }
      }
      delete settingsStore[guildId].verify.messageId;
    }
    saveSettings();
    return res.json({ success: true });
  } catch (err) {
    console.error(`Save settings error for guild ${req.body?.guildId || 'unknown'}:`, err);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});
app.post('/api/test-verify/:id', isAuthenticated, async (req, res) => {
  const guildId = req.params.id;
  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member) return res.status(403).json({ error: 'You must be a member' });
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return res.status(403).json({ error: 'Manage Guild required' });
    const cfg = settingsStore[guildId];
    if (!cfg || !cfg.verify || !cfg.verify.channelId) return res.status(400).json({ error: 'Verify channel not configured' });
    const channel = await guild.channels.fetch(cfg.verify.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return res.status(404).json({ error: 'Verify channel not found' });
    const botMember = await guild.members.fetch(client.user.id).catch(() => null);
    if (!botMember || !channel.permissionsFor(botMember).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.EmbedLinks])) {
      return res.status(403).json({ error: `Bot lacks ViewChannel, SendMessages, ReadMessageHistory, or EmbedLinks permissions in channel ${cfg.verify.channelId}` });
    }
    let message = cfg.verify.messageId ? await channel.messages.fetch(cfg.verify.messageId).catch(() => null) : null;
    if (!message) {
      const prompt = cfg.verify.prompt || 'Click Verify to start.';
      const ping = cfg.verify.ping || '';
      const embedTitle = cfg.verify.embedTitle || 'VERIFICATION SECTION';
      const embedColor = cfg.verify.embedColor || '#0099ff';
      const gifURL = cfg.verify.gifURL || '';
      const btn = new ButtonBuilder().setCustomId('verify').setLabel('Verify').setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(btn);
      const embed = new EmbedBuilder()
        .setTitle(embedTitle)
        .setDescription(prompt)
        .setColor(embedColor);
      if (gifURL) embed.setImage(gifURL);
      try {
        message = await channel.send({ content: ping, embeds: [embed], components: [row] });
        settingsStore[guildId].verify = settingsStore[guildId].verify || {};
        settingsStore[guildId].verify.messageId = message.id;
        saveSettings();
        console.log(`Sent test verification message in guild ${guildId}, channel ${cfg.verify.channelId}, message ID: ${message.id}`);
      } catch (e) {
        console.error(`Failed to send test verification message in guild ${guildId}:`, e);
        return res.status(500).json({ error: 'Failed to send test message' });
      }
    } else {
      console.log(`Reused existing verification message in guild ${guildId}, message ID: ${message.id}`);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(`Test verify error for guild ${guildId}:`, err);
    return res.status(500).json({ error: 'Failed to send test message' });
  }
});
app.listen(PORT, () => {
  console.log(`Dashboard available at http://localhost:${PORT}`);
});
client.login(BOT_TOKEN);
