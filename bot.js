
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, AttachmentBuilder, Events, PermissionsBitField, EmbedBuilder } = require('discord.js');

const PORT = process.env.DASHBOARD_PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN) {
  console.error('Please set DISCORD_TOKEN, CLIENT_ID, and CLIENT_SECRET in .env');
  process.exit(1);
}

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let settingsStore = {};
try {
  settingsStore = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
  for (const guildId in settingsStore) {
    if (!settingsStore[guildId]?.verify || typeof settingsStore[guildId].verify.enabled !== 'boolean' || !settingsStore[guildId].verify.channelId) {
      console.warn(`Invalid settings for guild ${guildId}, resetting verify config`);
      delete settingsStore[guildId].verify;
    }
  }
} catch (e) {
  console.error('Failed to load settings.json:', e);
  settingsStore = {};
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

const captchaMap = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  console.log('Bot ready as', client.user.tag);

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
    const verifyButton = new ButtonBuilder()
      .setCustomId('verify')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(verifyButton);
    const embed = new EmbedBuilder()
      .setTitle('VERIFICATION SECTION')
      .setDescription(prompt)
      .setColor('#0099ff');

    if (cfg.verify.gifURL) {
  embed.setImage(cfg.verify.gifURL);
}

    try {
      message = await channel.send({
        content: '@here',
        embeds: [embed],
        components: [row]
      });
      settingsStore[guildId].verify.messageId = message.id;
      settingsStore[guildId].verify.lastSent = Date.now(); // save last sent time
      saveSettings();
      console.log(`Sent verification message for guild ${guildId}, message ID: ${message.id}`);
    } catch (e) {
      console.error(`Failed to send verification message in guild ${guildId}:`, e);
    }
  }
});

// CAPTCHA 
function randomText(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const interactionAge = Date.now() - interaction.createdTimestamp;
    console.log(`Processing interaction: type=${interaction.type}, customId=${interaction.customId || 'none'}, user=${interaction.user.id}, guild=${interaction.guildId || 'none'}, isRepliable=${interaction.isRepliable()}, token=${interaction.token.slice(0, 10)}..., age=${interactionAge}ms`);

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

      const answer = randomText(6);
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

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('modal_')) {
      const userId = interaction.customId.split('_')[1];
      if (userId !== interaction.user.id) {
        await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
        return;
      }
      const rawAnswer = interaction.fields.getTextInputValue('captcha_answer');
      const rawAnswerHex = Buffer.from(rawAnswer, 'utf8').toString('hex');
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

      console.log(`Comparing in guild ${interaction.guildId}: raw='${rawAnswer}' (length: ${rawAnswer.length}, hex: ${rawAnswerHex}), sanitized='${answer}' (length: ${answer.length}), stored='${stored.answer}' (length: ${stored.answer.length}, raw: ${JSON.stringify(stored.answer)})`);
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

// Oauth no one even use this lmao
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
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
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
    req.session.user = me;
    req.session.guilds = guilds;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err?.response?.data || err);
    res.status(500).send('OAuth failed');
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
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
      const verifyButton = new ButtonBuilder()
        .setCustomId('verify')
        .setLabel('Verify')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(verifyButton);
      const embed = new EmbedBuilder()
        .setTitle('VERIFICATION SECTION')
        .setDescription(prompt)
        .setColor('#0099ff');
      try {
        const message = await channel.send({
          content: '@here',
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
      const btn = new ButtonBuilder().setCustomId('verify').setLabel('Verify').setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(btn);
      const embed = new EmbedBuilder()
        .setTitle('VERIFICATION SECTION')
        .setDescription(prompt)
        .setColor('#0099ff');
      try {
        message = await channel.send({ content: '@here', embeds: [embed], components: [row] });
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



