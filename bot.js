const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, InteractionType, Events } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const axios = require('axios');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// Simple in-memory storage (replace with JSON for persistence)
const settingsStore = {}; // guildId -> {verify: {enabled, channelId, messageId, rolesOnVerify}}
const captchaMap = new Map(); // "guildId:userId" -> {answer, expires}

function randomText(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: len}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

async function createCaptchaImage({ text, avatarURL }) {
  const width = 500, height = 200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#0B1B2A';
  ctx.fillRect(0,0,width,height);

  // avatar circle
  if (avatarURL) {
    try {
      const buf = await axios.get(avatarURL, {responseType:'arraybuffer'}).then(r => r.data);
      const img = await loadImage(buf);
      const size = 120;
      ctx.save();
      ctx.beginPath();
      ctx.arc(60+size/2, height/2, size/2, 0, Math.PI*2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, 60, height/2-size/2, size, size);
      ctx.restore();
    } catch {}
  }

  // captcha text
  const startX = 200, baseY = height/2+12;
  for (let i=0;i<text.length;i++){
    const ch = text[i];
    const fontSize = 40 + Math.floor(Math.random()*16);
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = ['#dbefff','#bfe3d8','#ffd7a8'][i%3];
    const x = startX + i*45 + (Math.random()*8-4);
    const angle = (Math.random()*30-15) * Math.PI/180;
    ctx.save();
    ctx.translate(x, baseY);
    ctx.rotate(angle);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }

  // noise
  for (let i=0;i<60;i++){
    ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.08})`;
    ctx.beginPath();
    ctx.arc(Math.random()*width, Math.random()*height, Math.random()*2+0.5,0,Math.PI*2);
    ctx.fill();
  }

  return { buffer: canvas.toBuffer('image/png'), text };
}

// Send or fetch the verify message
async function sendVerifyMessage(guild) {
  const cfg = settingsStore[guild.id]?.verify;
  if (!cfg || !cfg.enabled || !cfg.channelId) return;

  const channel = await guild.channels.fetch(cfg.channelId).catch(()=>null);
  if (!channel || !channel.isTextBased()) return;

  let message;
  if (cfg.messageId) {
    message = await channel.messages.fetch(cfg.messageId).catch(()=>null);
  }

  if (!message) {
    const btn = new ButtonBuilder().setCustomId('verify').setLabel('Verify').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(btn);
    message = await channel.send({ content: `@here Click Verify to start.`, components: [row] });
    settingsStore[guild.id].verify.messageId = message.id;
  }
}

// Bot ready
client.once(Events.ClientReady, async () => {
  console.log('Bot ready as', client.user.tag);
  for (const guild of client.guilds.cache.values()) {
    if (!settingsStore[guild.id]) continue;
    await sendVerifyMessage(guild);
  }
});

// Button / Modal interactions
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton() && interaction.customId === 'verify') {
      await interaction.deferReply({ephemeral:true});
      const answer = randomText(6);
      const { buffer } = await createCaptchaImage({ text: answer, avatarURL: interaction.user.displayAvatarURL({extension:'png',size:256}) });
      const key = `${interaction.guildId}:${interaction.user.id}`;
      captchaMap.set(key, { answer, expires: Date.now()+1000*60*5 });

      const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });
      const enter = new ButtonBuilder().setCustomId(`enter_${interaction.user.id}`).setLabel('Enter solution').setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(enter);

      await interaction.editReply({ content: 'Solve the captcha and click Enter solution.', files:[attachment], components:[row] });
    }

    if (interaction.isButton() && interaction.customId.startsWith('enter_')) {
      if (interaction.customId.split('_')[1] !== interaction.user.id) {
        await interaction.reply({ content: 'Not for you.', ephemeral:true });
        return;
      }
      await interaction.showModal(new ModalBuilder()
        .setCustomId(`modal_${interaction.user.id}`)
        .setTitle('Enter captcha')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('captcha_answer').setLabel('Captcha text').setStyle(TextInputStyle.Short).setRequired(true)
        ))
      );
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('modal_')) {
      const userId = interaction.customId.split('_')[1];
      if (userId !== interaction.user.id) return interaction.reply({ content:'Not for you.', ephemeral:true });

      const raw = interaction.fields.getTextInputValue('captcha_answer');
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const stored = captchaMap.get(key);
      if (!stored || Date.now()>stored.expires) return interaction.reply({ content:'Captcha expired, click Verify again.', ephemeral:true });

      if (raw.replace(/[^A-Za-z0-9]/g,'').toUpperCase() === stored.answer.toUpperCase()) {
        captchaMap.delete(key);
        const cfg = settingsStore[interaction.guildId]?.verify;
        if (cfg?.rolesOnVerify) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          for (const r of cfg.rolesOnVerify) {
            const role = interaction.guild.roles.cache.get(r);
            if (role) await member.roles.add(role).catch(()=>null);
          }
        }
        await interaction.reply({ content:'✅ Verified!', ephemeral:true });
      } else {
        captchaMap.delete(key);
        await interaction.reply({ content:'❌ Wrong captcha, click Verify again.', ephemeral:true });
      }
    }

  } catch (e) {
    console.error('Interaction error:', e);
    if (!interaction.replied) await interaction.reply({ content:'Error occurred.', ephemeral:true });
  }
});

client.login(process.env.DISCORD_TOKEN);
