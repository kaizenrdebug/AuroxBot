// bot.js — Full verifier + dashboard backend
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, AttachmentBuilder, Events, PermissionsBitField } = require('discord.js');

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

// Simple JSON file persistence for settings
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let settingsStore = {};
try {
  settingsStore = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
} catch (e) {
  settingsStore = {};
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore, null, 2));
}

// ephemeral captcha answers (in-memory) map: key = guildId:userId -> {answer, expires}
const captchaMap = new Map();

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log('Bot ready as', client.user.tag);
});

// ---------- CAPTCHA generation helper ----------
/**
 * Generates a random alphanumeric string
 */
function randomText(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid confusing chars
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Create a captcha image buffer that includes user's avatar
 * Returns: { buffer, text }
 */
async function createCaptchaImage({ text, avatarURL }) {
  const width = 500;
  const height = 200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#0B1B2A';
  ctx.fillRect(0, 0, width, height);

  // noisy lines
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = `rgba(${Math.floor(Math.random()*120+50)},${Math.floor(Math.random()*120+50)},${Math.floor(Math.random()*120+50)},0.25)`;
    ctx.beginPath();
    ctx.moveTo(Math.random()*width, Math.random()*height);
    ctx.lineTo(Math.random()*width, Math.random()*height);
    ctx.stroke();
  }

  // draw avatar circle on left
  try {
    if (avatarURL) {
      const avatarBuf = await axios.get(avatarURL, { responseType: 'arraybuffer', timeout: 5000 }).then(r => r.data);
      const img = await loadImage(avatarBuf);
      const avSize = 120;
      const avX = 30;
      const avY = (height - avSize) / 2;
      // circle clip
      ctx.save();
      ctx.beginPath();
      ctx.arc(avX + avSize/2, avY + avSize/2, avSize/2, 0, Math.PI*2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, avX, avY, avSize, avSize);
      ctx.restore();
      // border
      ctx.strokeStyle = '#12323b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(avX + avSize/2, avY + avSize/2, avSize/2 + 2, 0, Math.PI*2);
      ctx.stroke();
    }
  } catch (e) {
    // ignore avatar load errors
    console.warn('Avatar load failed:', e?.message || e);
  }

  // draw the captcha text on the right
  // random font size + rotation per char
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

  // more noise dots
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.08})`;
    ctx.beginPath();
    ctx.arc(Math.random()*width, Math.random()*height, Math.random()*2+0.5, 0, Math.PI*2);
    ctx.fill();
  }

  const buffer = canvas.toBuffer('image/png');
  return { buffer, text };
}

// ---------- Discord event: member joins ----------
client.on('guildMemberAdd', async (member) => {
  try {
    const guildId = member.guild.id;
    const cfg = settingsStore[guildId];
    if (!cfg || !cfg.verify || !cfg.verify.enabled) return;

    // assign Roles On Join
    const rolesOnJoin = Array.isArray(cfg.verify.rolesOnJoin) ? cfg.verify.rolesOnJoin : [];
    for (const r of rolesOnJoin) {
      try {
        const role = member.guild.roles.cache.get(r) || member.guild.roles.cache.find(x => x.name === r);
        if (role) await member.roles.add(role).catch(() => null);
      } catch (e) {}
    }

    // send verify message to configured channel
    const channelId = cfg.verify.channelId;
    const channel = channelId ? await member.guild.channels.fetch(channelId).catch(() => null) : null;
    const prompt = cfg.verify.prompt || 'Click Verify to start. You will receive a captcha to solve.';
    if (!channel || !channel.isTextBased()) {
      console.warn('Verify channel not available for guild', guildId);
      return;
    }

    const verifyButton = new ButtonBuilder()
      .setCustomId('verify')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(verifyButton);

    await channel.send({
      content: `@here ${prompt}`,
      components: [row]
    });
  } catch (err) {
    console.error('Error on guildMemberAdd:', err);
  }
});

// ---------- Interaction handling (buttons + modal) ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      // verify button clicked
      const custom = interaction.customId; // expected: verify
      if (custom !== 'verify') return;

      const guildId = interaction.guildId;
      const cfg = settingsStore[guildId];
      if (!cfg || !cfg.verify || !cfg.verify.enabled) {
        await interaction.reply({ content: 'Verification is not enabled for this server.', ephemeral: true });
        return;
      }

      // generate captcha and store answer
      const answer = randomText(6);
      const avatarURL = interaction.user.displayAvatarURL({ extension: 'png', size: 256 });
      const { buffer, text } = await createCaptchaImage({ text: answer, avatarURL }).catch(e=>{ throw e; });

      // store captcha
      const key = `${guildId}:${interaction.user.id}`;
      captchaMap.set(key, { answer, expires: Date.now() + 1000 * 60 * 5 }); // 5min

      // send ephemeral with image and a modal trigger
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

      return;
    }

    // discord.js sends modals through isModalSubmit
    if (interaction.type === InteractionType.ModalSubmit) {
      const custom = interaction.customId; // expected: modal_<userId>
      if (!custom.startsWith('modal_')) return;
      const userId = custom.split('_')[1];
      if (userId !== interaction.user.id) {
        await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
        return;
      }
      const answer = interaction.fields.getTextInputValue('captcha_answer').trim();
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const stored = captchaMap.get(key);
      if (!stored) {
        await interaction.reply({ content: 'No captcha found or it expired. Please click Verify again.', ephemeral: true });
        return;
      }
      if (Date.now() > stored.expires) {
        captchaMap.delete(key);
        await interaction.reply({ content: 'Captcha expired. Please click Verify again.', ephemeral: true });
        return;
      }

      if (answer.toUpperCase() === stored.answer.toUpperCase()) {
        // success: assign rolesOnVerify, remove rolesOnJoin (unless also in onVerify)
        const cfg = settingsStore[interaction.guildId];
        const rolesOnJoin = (cfg?.verify?.rolesOnJoin) || [];
        const rolesOnVerify = (cfg?.verify?.rolesOnVerify) || [];

        // fetch member
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        if (!member) {
          await interaction.reply({ content: 'Member not found in guild.', ephemeral: true });
          return;
        }

        // remove rolesOnJoin unless also in verify
        for (const r of rolesOnJoin) {
          try {
            const role = interaction.guild.roles.cache.get(r) || interaction.guild.roles.cache.find(x => x.name === r);
            if (role && !rolesOnVerify.includes(role.id) && !rolesOnVerify.includes(role.name)) {
              await member.roles.remove(role).catch(()=>null);
            }
          } catch(e){}
        }

        // add rolesOnVerify
        for (const r of rolesOnVerify) {
          try {
            const role = interaction.guild.roles.cache.get(r) || interaction.guild.roles.cache.find(x => x.name === r);
            if (role) await member.roles.add(role).catch(()=>null);
          } catch(e){}
        }

        captchaMap.delete(key);
        await interaction.reply({ content: '✅ Verified! Roles have been updated.', ephemeral: true });
      } else {
        // wrong answer: keep attempts? For simplicity, allow retry
        captchaMap.delete(key);
        await interaction.reply({ content: '❌ Wrong answer. Click **Verify** again to get a new captcha.', ephemeral: true });
      }
      return;
    }

    // Fallback: if it's a button "enter_" we show a modal
    if (interaction.isButton() && interaction.customId.startsWith('enter_')) {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`modal_${interaction.user.id}`)
          .setTitle('Enter captcha')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('captcha_answer').setLabel('Captcha text').setStyle(TextInputStyle.Short).setRequired(true)
            )
          )
      );
    }
  } catch (err) {
    console.error('Interaction handler error:', err);
    if (interaction && !interaction.replied) {
      try { await interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch(e){}
    }
  }
});

// Because some action paths rely on showing a modal after the ephemeral image + button,
// we add a small listener: when a user clicks the ephemeral 'Enter solution' button, open the modal.
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId;
    if (id.startsWith('enter_')) {
      // user clicked ephemeral enter
      if (id.split('_')[1] && id.split('_')[1] !== interaction.user.id) {
        await interaction.reply({ content: 'This enter button is not for you.', ephemeral: true });
        return;
      }
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`modal_${interaction.user.id}`)
          .setTitle('Enter captcha')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('captcha_answer').setLabel('Captcha text').setStyle(TextInputStyle.Short).setRequired(true)
            )
          )
      );
    }
  } catch (e) {
    // silent
  }
});

// ---------- Express dashboard + OAuth routes ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24 } // 1 day
}));

// serve dashboard static
app.use(express.static('.'));

// helper: require auth
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// OAuth login
app.get('/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/logout', (req, res) => {
  req.session.destroy(()=>{ res.redirect('/'); });
});

// OAuth callback
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
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
    const accessToken = tokenRes.data.access_token;
    // fetch user and guilds
    const me = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } }).then(r=>r.data);
    const guilds = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${accessToken}` } }).then(r=>r.data);
    req.session.user = me;
    req.session.guilds = guilds;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error', err?.response?.data || err);
    res.status(500).send('OAuth failed');
  }
});

// api/me
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  return res.json({ user: req.session.user, guilds: req.session.guilds || [] });
});

// api/server/:id - returns guild info + roles + channels
app.get('/api/server/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;
  try {
    const guild = await client.guilds.fetch(id).catch(() => null);
    if (!guild) return res.status(404).json({ error: 'Guild not found or bot not in guild' });

    // fetch all members (optional, for stats)
    const members = await guild.members.fetch().catch(() => null);
    const humans = members ? members.filter(m => !m.user.bot).size : 0;
    const bots = members ? members.filter(m => m.user.bot).size : 0;

    // fetch roles
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor }));

    // fetch text channels
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
    console.error('Fetch guild info error:', err);
    return res.status(500).json({ error: 'Failed to fetch guild info' });
  }
});

// save settings (body: { guildId, verify: { enabled, channelId, rolesOnJoin, rolesOnVerify, prompt } })
app.post('/api/settings', isAuthenticated, async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.guildId) return res.status(400).json({ error: 'guildId required' });

    const guildId = body.guildId;
    // permission check: ensure the logged-in user is a guild manager
    const guild = await client.guilds.fetch(guildId).catch(()=>null);
    if (!guild) return res.status(404).json({ error: 'Guild not found or bot not present' });

    const member = await guild.members.fetch(req.session.user.id).catch(()=>null);
    if (!member) return res.status(403).json({ error: 'You must be a guild member' });
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return res.status(403).json({ error: 'Manage Guild permission required' });
    }

    // store settings (only verify section)
    settingsStore[guildId] = settingsStore[guildId] || {};
    settingsStore[guildId].verify = body.verify || settingsStore[guildId].verify || { enabled: false };
    saveSettings();
    return res.json({ success: true });
  } catch (err) {
    console.error('Save settings error', err);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Send test verify message
app.post('/api/test-verify/:id', isAuthenticated, async (req, res) => {
  const guildId = req.params.id;
  try {
    const guild = await client.guilds.fetch(guildId).catch(()=>null);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const member = await guild.members.fetch(req.session.user.id).catch(()=>null);
    if (!member) return res.status(403).json({ error: 'You must be a member' });
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return res.status(403).json({ error: 'Manage Guild required' });

    const cfg = settingsStore[guildId];
    if (!cfg || !cfg.verify || !cfg.verify.channelId) return res.status(400).json({ error: 'Verify channel not configured' });

    const channel = await guild.channels.fetch(cfg.verify.channelId).catch(()=>null);
    if (!channel || !channel.isTextBased()) return res.status(404).json({ error: 'Verify channel not found' });

    const prompt = cfg.verify.prompt || 'Click Verify to start.';
    const btn = new ButtonBuilder().setCustomId('verify').setLabel('Verify').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(btn);
    await channel.send({ content: `@here ${prompt}`, components: [row] });
    return res.json({ success: true });
  } catch (err) {
    console.error('test verify error', err);
    return res.status(500).json({ error: 'Failed to send test message' });
  }
});

// start express
app.listen(PORT, () => {
  console.log(`Dashboard available at http://localhost:${PORT}`);
});

// login discord bot
client.login(BOT_TOKEN);