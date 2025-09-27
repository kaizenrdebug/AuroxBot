require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  AttachmentBuilder,
  Events,
  PermissionsBitField
} = require('discord.js');

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

// Simple JSON file persistence
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let settingsStore = {};
try { settingsStore = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}'); } catch (e) { settingsStore = {}; }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore, null, 2)); } catch (e) { console.error('Failed to save settings:', e); } }

// Ephemeral captcha map
const captchaMap = new Map();

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// CAPTCHA generator
function randomText(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createCaptchaImage({ text, avatarURL }) {
  const width = 500, height = 200;
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

  try {
    if (avatarURL) {
      const avatarBuf = await axios.get(avatarURL, { responseType: 'arraybuffer', timeout: 5000 }).then(r => r.data);
      const img = await loadImage(avatarBuf);
      const avSize = 120, avX = 30, avY = (height - avSize) / 2;
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
    }
  } catch (e) { console.warn('Avatar load failed:', e?.message || e); }

  const startX = 200, baseY = height/2 + 12;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], fontSize = 40 + Math.floor(Math.random()*16);
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = ['#dbefff','#bfe3d8','#ffd7a8'][i%3];
    const x = startX + i*45 + (Math.random()*8 - 4);
    const angle = (Math.random()*30 - 15) * Math.PI/180;
    ctx.save();
    ctx.translate(x, baseY);
    ctx.rotate(angle);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }

  for (let i=0; i<60; i++){
    ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.08})`;
    ctx.beginPath();
    ctx.arc(Math.random()*width, Math.random()*height, Math.random()*2+0.5, 0, Math.PI*2);
    ctx.fill();
  }

  return { buffer: canvas.toBuffer('image/png'), text };
}

// Startup: one @here verification message per guild
client.once(Events.ClientReady, async () => {
  console.log('Bot ready as', client.user.tag);

  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;
    const cfg = settingsStore[guildId];
    if (!cfg?.verify?.enabled || !cfg.verify.channelId) continue;

    const channel = await guild.channels.fetch(cfg.verify.channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const botMember = await guild.members.fetch(client.user.id).catch(() => null);
    if (!botMember || !channel.permissionsFor(botMember).has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) continue;

    let message;
    if (cfg.verify.messageId) message = await channel.messages.fetch(cfg.verify.messageId).catch(() => null);

    if (!message) {
      const prompt = ':arrow_orange: Click Verify to start. You will receive a captcha to solve. :thumbsup~1:';
      const verifyButton = new ButtonBuilder().setCustomId('verify').setLabel('Verify').setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(verifyButton);
      try {
        message = await channel.send({ content: `@here ${prompt}`, components: [row] });
        settingsStore[guildId] = settingsStore[guildId] || {};
        settingsStore[guildId].verify = settingsStore[guildId].verify || {};
        settingsStore[guildId].verify.messageId = message.id;
        saveSettings();
        console.log(`Sent verification message for guild ${guildId}, message ID: ${message.id}`);
      } catch (e) { console.error(`Failed to send verification message in guild ${guildId}:`, e); }
    }
  }
});

// Handle member join roles
client.on('guildMemberAdd', async member => {
  try {
    const cfg = settingsStore[member.guild.id];
    if (!cfg?.verify?.enabled) return;
    const rolesOnJoin = Array.isArray(cfg.verify.rolesOnJoin) ? cfg.verify.rolesOnJoin : [];
    for (const r of rolesOnJoin) {
      const role = member.guild.roles.cache.get(r) || member.guild.roles.cache.find(x => x.name===r);
      if (role) await member.roles.add(role).catch(()=>null);
    }
  } catch (e) { console.error('guildMemberAdd error', e); }
});

// Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton() || interaction.isModalSubmit()) await interaction.deferReply({ ephemeral: true });

    // Click verify
    if (interaction.isButton() && interaction.customId === 'verify') {
      const guildId = interaction.guildId;
      const cfg = settingsStore[guildId];
      if (!cfg?.verify?.enabled) return interaction.editReply({ content: 'Verification is not enabled.' });

      const answer = randomText(6);
      const avatarURL = interaction.user.displayAvatarURL({ extension: 'png', size: 256 });
      const { buffer } = await createCaptchaImage({ text: answer, avatarURL });

      const key = `${guildId}:${interaction.user.id}`;
      captchaMap.set(key, { answer, expires: Date.now() + 1000*60*5 });

      const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });
      const enterBtn = new ButtonBuilder().setCustomId(`enter_${interaction.user.id}`).setLabel('Enter solution').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(enterBtn);

      return interaction.editReply({
        content: 'Solve the captcha shown below and click *Enter solution* to type your answer.',
        files: [attachment],
        components: [row]
      });
    }

    // Enter solution button
    if (interaction.isButton() && interaction.customId.startsWith('enter_')) {
      if (interaction.customId.split('_')[1] !== interaction.user.id) return interaction.editReply({ content: 'This button is not for you.' });
      return interaction.showModal(
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

    // Modal submit
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('modal_')) {
      const userId = interaction.customId.split('_')[1];
      if (userId !== interaction.user.id) return interaction.editReply({ content: 'This modal is not for you.' });

      const rawAnswer = interaction.fields.getTextInputValue('captcha_answer');
      const answer = rawAnswer.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const stored = captchaMap.get(key);

      if (!stored || Date.now() > stored.expires) {
        captchaMap.delete(key);
        return interaction.editReply({ content: 'Captcha expired. Click Verify again.' });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) return interaction.editReply({ content: 'Member not found.' });

      if (answer === stored.answer.toUpperCase()) {
        const cfg = settingsStore[interaction.guildId];
        const rolesOnJoin = cfg?.verify?.rolesOnJoin || [];
        const rolesOnVerify = cfg?.verify?.rolesOnVerify || [];

        // Remove join roles
        for (const r of rolesOnJoin) {
          if (!rolesOnVerify.includes(r)) {
            const role = interaction.guild.roles.cache.get(r) || interaction.guild.roles.cache.find(x=>x.name===r);
            if (role) await member.roles.remove(role).catch(()=>null);
          }
        }
        // Add verify roles
        for (const r of rolesOnVerify) {
          const role = interaction.guild.roles.cache.get(r) || interaction.guild.roles.cache.find(x=>x.name===r);
          if (role) await member.roles.add(role).catch(()=>null);
        }

        captchaMap.delete(key);
        return interaction.editReply({ content: '✅ Verified! Roles updated.' });
      } else {
        captchaMap.delete(key);
        return interaction.editReply({ content: '❌ Wrong answer. Click **Verify** again.' });
      }
    }
  } catch (err) {
    console.error('Interaction error', err);
    try {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'An error occurred.', ephemeral: true });
      else if (interaction.deferred) await interaction.editReply({ content: 'An error occurred.' });
    } catch {}
  }
});

// --- Express dashboard ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000*60*60*24 } }));
app.use(express.static('.'));

function isAuthenticated(req,res,next){if(req.session?.user) return next(); return res.status(401).json({ error:'Not authenticated' });}

app.get('/login',(req,res)=>{
  const url=`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});
app.get('/logout',(req,res)=>{ req.session.destroy(()=>res.redirect('/')); });

app.get('/callback', async (req,res)=>{
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided.');
  try {
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('grant_type','authorization_code');
    params.append('code',code);
    params.append('redirect_uri', REDIRECT_URI);
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', params, { headers:{ 'Content-Type':'application/x-www-form-urlencoded' } });
    const accessToken = tokenRes.data.access_token;
    const me = await axios.get('https://discord.com/api/users/@me',{ headers:{ Authorization:`Bearer ${accessToken}` } }).then(r=>r.data);
    const guilds = await axios.get('https://discord.com/api/users/@me/guilds',{ headers:{ Authorization:`Bearer ${accessToken}` } }).then(r=>r.data);
    req.session.user = me;
    req.session.guilds = guilds;
    res.redirect('/');
  } catch (err) { console.error('OAuth callback error', err?.response?.data || err); res.status(500).send('OAuth failed'); }
});

// Basic API routes
app.get('/api/me', isAuthenticated, (req,res)=>res.json({ user:req.session.user, guilds:req.session.guilds || [] }));

app.listen(PORT, ()=>console.log(`Dashboard available at http://localhost:${PORT}`));

client.login(BOT_TOKEN);
