let user, guilds, selectedGuild;

async function init() {
  const res = await fetch('/api/me');
  if (!res.ok) return window.location.href = '/login';
  const data = await res.json();
  user = data.user;
  guilds = data.guilds.filter(g => (parseInt(g.permissions || '0', 16) & 0x20) !== 0); // Manage Guild
  populateGuildList();
}

function populateGuildList() {
  const list = document.getElementById('guildList');
  list.innerHTML = '';
  guilds.forEach(g => {
    const div = document.createElement('div');
    div.textContent = g.name;
    div.className = 'guild-item';
    div.onclick = () => loadGuild(g.id);
    list.appendChild(div);
  });
  if (guilds.length > 0) loadGuild(guilds[0].id);
}

async function loadGuild(id) {
  const res = await fetch(`/api/server/${id}`);
  if (!res.ok) return alert('Failed to load guild');
  const g = await res.json();
  selectedGuild = g;

  document.getElementById('guildPanel').classList.remove('hidden');
  document.getElementById('guildName').textContent = g.name;

  const verify = g.settings.verify || {};
  document.getElementById('verifyEnabled').checked = verify.enabled || false;
  document.getElementById('verifyPrompt').value = verify.prompt || '';
  document.getElementById('verifyPing').value = verify.ping || '@Visitor';
  document.getElementById('embedTitle').value = verify.embedTitle || 'VERIFICATION SECTION';
  document.getElementById('embedColor').value = verify.embedColor || '#0099ff';
  document.getElementById('gifURL').value = verify.gifURL || '';

  // Populate roles & channels
  const rolesSel = document.getElementById('rolesOnJoin');
  const rolesVer = document.getElementById('rolesOnVerify');
  const channelSel = document.getElementById('verifyChannel');

  rolesSel.innerHTML = '';
  rolesVer.innerHTML = '';
  channelSel.innerHTML = '';

  // Roles
  g.roles.forEach(r => {
    const o1 = document.createElement('option');
    o1.value = r.id;
    o1.textContent = r.name;
    if (verify.rolesOnJoin?.includes(r.id)) o1.selected = true;
    rolesSel.appendChild(o1);

    const o2 = document.createElement('option');
    o2.value = r.id;
    o2.textContent = r.name;
    if (verify.rolesOnVerify?.includes(r.id)) o2.selected = true;
    rolesVer.appendChild(o2);
  });

  // Channels (text only)
  g.channels
    .filter(c => c.type === 0)
    .forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (verify.channelId === c.id) o.selected = true;
      channelSel.appendChild(o);
    });
}

async function saveSettings() {
  if (!selectedGuild) return;
  const payload = {
    guildId: selectedGuild.id,
    verify: {
      enabled: document.getElementById('verifyEnabled').checked,
      prompt: document.getElementById('verifyPrompt').value,
      ping: document.getElementById('verifyPing').value,
      embedTitle: document.getElementById('embedTitle').value,
      embedColor: document.getElementById('embedColor').value,
      gifURL: document.getElementById('gifURL').value,
      rolesOnJoin: Array.from(document.getElementById('rolesOnJoin').selectedOptions).map(o => o.value),
      rolesOnVerify: Array.from(document.getElementById('rolesOnVerify').selectedOptions).map(o => o.value),
      channelId: document.getElementById('verifyChannel').value
    }
  };

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (data.success) alert('Settings saved!');
  else alert('Failed to save: ' + (data.error || 'Unknown error'));
}

async function testVerify() {
  if (!selectedGuild) return;
  const res = await fetch(`/api/test-verify/${selectedGuild.id}`, { method: 'POST' });
  const data = await res.json();
  if (data.success) alert('Test verify sent!');
  else alert('Failed: ' + (data.error || 'Unknown error'));
}

// Logout button
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  await fetch('/logout');
  window.location.href = '/';
});

// Save button
document.getElementById('saveBtn')?.addEventListener('click', saveSettings);
document.getElementById('testBtn')?.addEventListener('click', testVerify);

init();
