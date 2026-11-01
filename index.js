const {
  Client, GatewayIntentBits, PermissionsBitField, AuditLogEvent,
  SlashCommandBuilder, EmbedBuilder, Events, ChannelType, MessageFlags,
  OverwriteType, MessageType
} = require('discord.js');
const fs = require('fs');
const http = require('http');

const TOKEN = process.env.TOKEN;
const OWNER_ID = process.env.OWNER_ID; // Bot kurucusunun Discord ID'si
const DATA_FILE = './data.json';
const PF = PermissionsBitField.Flags;

// ---------- Render için küçük web sunucusu ----------
http
  .createServer((req, res) => res.end('Bot aktif'))
  .listen(process.env.PORT || 3000);

// ---------- Veri ----------
// tam         : Sadece kurucu verir. Başkalarına yetki verip alabilir.
// yetki       : Kurucu veya tam yetkili verir. Dokunulmaz (koruma bunlara işlemez).
// logChannels : { sunucuId: kanalId }
// warns       : { sunucuId: { kullaniciId: [ {sebep, mod, tarih} ] } }
function loadData() {
  const empty = { tam: [], yetki: [], logChannels: {}, warns: {} };
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      tam: d.tam ?? [],
      yetki: [...new Set([...(d.yetki ?? []), ...(d.allowed ?? [])])],
      logChannels: d.logChannels ?? {},
      warns: d.warns ?? {}
    };
  } catch { return empty; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
let data = loadData();

const isOwner = (id) => id === OWNER_ID;
const isTam = (id) => data.tam.includes(id);
// Korumadan muaf mı (dokunulmaz)?
const isAllowed = (id) => isOwner(id) || isTam(id) || data.yetki.includes(id);

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ---------- Yardımcılar ----------
const ephemeral = MessageFlags.Ephemeral;
const reply = (i, content) => i.reply({ content, flags: ephemeral });
const err = (i, msg) => i.reply({ content: `❌ ${msg}`, flags: ephemeral });
const mkEmbed = (color, title, desc) =>
  new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();

async function log(guild, text, color = 'Red') {
  const embed = mkEmbed(color, `🛡️ ${guild.name}`, text);
  const chId = data.logChannels[guild.id];
  if (chId) {
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (ch?.isTextBased()) {
      const ok = await ch.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (ok) return;
    }
  }
  // Log kanalı ayarlı değilse veya yazılamıyorsa kurucuya DM
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send({ embeds: [embed] });
  } catch {}
}

async function findExecutor(guild, type, targetId) {
  await new Promise(r => setTimeout(r, 1000)); // audit log gecikmesi için
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  if (!logs) return null;
  const entry = logs.entries.find(
    e => e.target?.id === targetId && Date.now() - e.createdTimestamp < 10000
  );
  return entry?.executor ?? null;
}

// Moderasyon yapılacak kişi için hiyerarşi kontrolü. Hata varsa mesaj döner.
function checkTarget(i, member) {
  if (!member) return null;
  if (member.id === i.user.id) return 'Kendine işlem yapamazsın.';
  if (member.id === client.user.id) return 'Bana işlem yapamazsın.';
  if (member.id === i.guild.ownerId) return 'Sunucu sahibine işlem yapılamaz.';
  const me = i.guild.members.me;
  if (member.roles.highest.position >= me.roles.highest.position)
    return 'Bu kişinin rolü benim rolümden yüksek veya eşit.';
  const bypass = i.user.id === i.guild.ownerId || isOwner(i.user.id);
  if (!bypass && member.roles.highest.position >= i.member.roles.highest.position)
    return 'Bu kişinin rolü seninkinden yüksek veya eşit.';
  return null;
}

const getMember = (i, user) => i.guild.members.fetch(user.id).catch(() => null);
const sebepOf = (i) => i.options.getString('sebep') ?? 'Sebep belirtilmedi';
const dm = (user, embed) => user.send({ embeds: [embed] }).catch(() => {});

// ---------- Koruma / yetki komutları ----------
const kisiOpt = (o) =>
  o.setName('kisi').setDescription('Kişiyi etiketle veya ID gir').setRequired(true);

const builders = [
  new SlashCommandBuilder()
    .setName('tamyetki-ver')
    .setDescription('Birine tam yetki verir: başkalarına yetki verebilir (sadece kurucu)')
    .addUserOption(kisiOpt),
  new SlashCommandBuilder()
    .setName('tamyetki-al')
    .setDescription('Birinin tam yetkisini alır (sadece kurucu)')
    .addUserOption(kisiOpt),
  new SlashCommandBuilder()
    .setName('yetki-ver')
    .setDescription('Birine dokunulmazlık verir (kurucu ve tam yetkililer)')
    .addUserOption(kisiOpt),
  new SlashCommandBuilder()
    .setName('yetki-al')
    .setDescription('Birinin dokunulmazlığını alır (kurucu ve tam yetkililer)')
    .addUserOption(kisiOpt),
  new SlashCommandBuilder()
    .setName('yetki-liste')
    .setDescription('Tam yetkilileri ve yetkilileri listeler (kurucu ve tam yetkililer)')
].map(c => c.toJSON());

// ---------- Moderasyon komutları ----------
const modCommands = new Map();
function addCmd(name, desc, perm, build, run) {
  const b = new SlashCommandBuilder().setName(name).setDescription(desc).setDMPermission(false);
  if (perm) b.setDefaultMemberPermissions(perm);
  if (build) build(b);
  builders.push(b.toJSON());
  modCommands.set(name, { perm, run });
}

// /log-kanal
addCmd('log-kanal', 'Log kanalını ayarlar (kurucu, tam yetkililer, sunucu sahibi)', null,
  b => b.addChannelOption(o => o.setName('kanal').setDescription('Log kanalı')
    .addChannelTypes(ChannelType.GuildText).setRequired(true)),
  async (i) => {
    if (!isOwner(i.user.id) && !isTam(i.user.id) && i.user.id !== i.guild.ownerId)
      return err(i, 'Bu komutu sadece kurucu, tam yetkililer ve sunucu sahibi kullanabilir.');
    const ch = i.options.getChannel('kanal');
    const test = await ch.send({ embeds: [mkEmbed('Green', '✅ Log kanalı ayarlandı', 'Bot logları artık buraya gelecek.')] })
      .then(() => true).catch(() => false);
    if (!test) return err(i, 'O kanala mesaj gönderemiyorum. Botun kanalı görme ve yazma yetkisini kontrol et.');
    data.logChannels[i.guild.id] = ch.id;
    saveData(data);
    return reply(i, `✅ Log kanalı <#${ch.id}> olarak ayarlandı.`);
  });

// /log-kapat
addCmd('log-kapat', 'Log kanalını kaldırır, loglar kurucunun DM\'ine gider', null, null,
  async (i) => {
    if (!isOwner(i.user.id) && !isTam(i.user.id) && i.user.id !== i.guild.ownerId)
      return err(i, 'Bu komutu sadece kurucu, tam yetkililer ve sunucu sahibi kullanabilir.');
    delete data.logChannels[i.guild.id];
    saveData(data);
    return reply(i, '🗑️ Log kanalı kaldırıldı.');
  });

// /ban
addCmd('ban', 'Bir kişiyi banlar', PF.BanMembers,
  b => b
    .addUserOption(kisiOpt)
    .addStringOption(o => o.setName('sebep').setDescription('Sebep'))
    .addIntegerOption(o => o.setName('gun').setDescription('Kaç günlük mesajı silinsin (0-7)').setMinValue(0).setMaxValue(7)),
  async (i) => {
    const user = i.options.getUser('kisi');
    const sebep = sebepOf(i);
    const gun = i.options.getInteger('gun') ?? 0;
    const member = await getMember(i, user);
    const e = checkTarget(i, member);
    if (e) return err(i, e);
    await dm(user, mkEmbed('Red', `🔨 ${i.guild.name} sunucusundan banlandın`, `**Sebep:** ${sebep}`));
    try {
      await i.guild.members.ban(user.id, { reason: `${i.user.tag}: ${sebep}`, deleteMessageSeconds: gun * 86400 });
    } catch { return err(i, 'Bu kişiyi banlayamadım. Yetkimi ve rol sıramı kontrol et.'); }
    await i.reply({ embeds: [mkEmbed('Red', '🔨 Ban', `**Kişi:** ${user.tag}\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`)] });
    log(i.guild, `🔨 **Ban**\n**Kişi:** ${user.tag} (${user.id})\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`, 'Red');
  });

// /unban
addCmd('unban', 'Bir kişinin banını kaldırır', PF.BanMembers,
  b => b
    .addStringOption(o => o.setName('id').setDescription('Kullanıcı ID').setRequired(true))
    .addStringOption(o => o.setName('sebep').setDescription('Sebep')),
  async (i) => {
    const id = i.options.getString('id').trim();
    const sebep = sebepOf(i);
    try {
      await i.guild.members.unban(id, `${i.user.tag}: ${sebep}`);
    } catch { return err(i, 'Bu ID banlı değil veya kaldıramadım.'); }
    await i.reply({ embeds: [mkEmbed('Green', '✅ Ban kaldırıldı', `**ID:** ${id}\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`)] });
    log(i.guild, `✅ **Unban**\n**ID:** ${id}\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`, 'Green');
  });

// /kick
addCmd('kick', 'Bir kişiyi sunucudan atar', PF.KickMembers,
  b => b.addUserOption(kisiOpt).addStringOption(o => o.setName('sebep').setDescription('Sebep')),
  async (i) => {
    const user = i.options.getUser('kisi');
    const sebep = sebepOf(i);
    const member = await getMember(i, user);
    if (!member) return err(i, 'Bu kişi sunucuda değil.');
    const e = checkTarget(i, member);
    if (e) return err(i, e);
    await dm(user, mkEmbed('Orange', `👢 ${i.guild.name} sunucusundan atıldın`, `**Sebep:** ${sebep}`));
    try { await member.kick(`${i.user.tag}: ${sebep}`); }
    catch { return err(i, 'Bu kişiyi atamadım. Yetkimi ve rol sıramı kontrol et.'); }
    await i.reply({ embeds: [mkEmbed('Orange', '👢 Kick', `**Kişi:** ${user.tag}\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`)] });
    log(i.guild, `👢 **Kick**\n**Kişi:** ${user.tag} (${user.id})\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`, 'Orange');
  });

// /sustur
addCmd('sustur', 'Bir kişiyi süreli susturur (timeout)', PF.ModerateMembers,
  b => b
    .addUserOption(kisiOpt)
    .addIntegerOption(o => o.setName('sure').setDescription('Dakika (en fazla 40320 = 28 gün)').setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName('sebep').setDescription('Sebep')),
  async (i) => {
    const user = i.options.getUser('kisi');
    const dakika = i.options.getInteger('sure');
    const sebep = sebepOf(i);
    const member = await getMember(i, user);
    if (!member) return err(i, 'Bu kişi sunucuda değil.');
    const e = checkTarget(i, member);
    if (e) return err(i, e);
    try { await member.timeout(dakika * 60 * 1000, `${i.user.tag}: ${sebep}`); }
    catch { return err(i, 'Bu kişiyi susturamadım. Yetkimi ve rol sıramı kontrol et.'); }
    await dm(user, mkEmbed('Yellow', `🔇 ${i.guild.name} sunucusunda susturuldun`, `**Süre:** ${dakika} dakika\n**Sebep:** ${sebep}`));
    await i.reply({ embeds: [mkEmbed('Yellow', '🔇 Susturma', `**Kişi:** ${user.tag}\n**Süre:** ${dakika} dakika\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`)] });
    log(i.guild, `🔇 **Susturma**\n**Kişi:** ${user.tag} (${user.id})\n**Süre:** ${dakika} dk\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}`, 'Yellow');
  });

// /susturma-kaldir
addCmd('susturma-kaldir', 'Bir kişinin susturmasını kaldırır', PF.ModerateMembers,
  b => b.addUserOption(kisiOpt),
  async (i) => {
    const user = i.options.getUser('kisi');
    const member = await getMember(i, user);
    if (!member) return err(i, 'Bu kişi sunucuda değil.');
    try { await member.timeout(null, `${i.user.tag}: susturma kaldırıldı`); }
    catch { return err(i, 'Susturmayı kaldıramadım.'); }
    await i.reply({ embeds: [mkEmbed('Green', '🔊 Susturma kaldırıldı', `**Kişi:** ${user.tag}\n**Yetkili:** <@${i.user.id}>`)] });
    log(i.guild, `🔊 **Susturma kaldırıldı**\n**Kişi:** ${user.tag} (${user.id})\n**Yetkili:** <@${i.user.id}>`, 'Green');
  });

// /uyar
addCmd('uyar', 'Bir kişiyi uyarır', PF.ModerateMembers,
  b => b
    .addUserOption(kisiOpt)
    .addStringOption(o => o.setName('sebep').setDescription('Sebep').setRequired(true)),
  async (i) => {
    const user = i.options.getUser('kisi');
    const sebep = sebepOf(i);
    const member = await getMember(i, user);
    const e = checkTarget(i, member);
    if (e) return err(i, e);
    const g = (data.warns[i.guild.id] ??= {});
    const list = (g[user.id] ??= []);
    list.push({ sebep, mod: i.user.id, tarih: Date.now() });
    saveData(data);
    await dm(user, mkEmbed('Yellow', `⚠️ ${i.guild.name} sunucusunda uyarıldın`, `**Sebep:** ${sebep}\n**Toplam uyarın:** ${list.length}`));
    await i.reply({ embeds: [mkEmbed('Yellow', '⚠️ Uyarı', `**Kişi:** ${user.tag}\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}\n**Toplam uyarı:** ${list.length}`)] });
    log(i.guild, `⚠️ **Uyarı**\n**Kişi:** ${user.tag} (${user.id})\n**Yetkili:** <@${i.user.id}>\n**Sebep:** ${sebep}\n**Toplam:** ${list.length}`, 'Yellow');
  });

// /uyarilar
addCmd('uyarilar', 'Bir kişinin uyarılarını gösterir', PF.ModerateMembers,
  b => b.addUserOption(kisiOpt),
  async (i) => {
    const user = i.options.getUser('kisi');
    const list = data.warns[i.guild.id]?.[user.id] ?? [];
    if (!list.length) return reply(i, `✅ ${user.tag} kişisinin uyarısı yok.`);
    const text = list.slice(-10).map((w, n) =>
      `**${list.length - Math.min(list.length, 10) + n + 1}.** ${w.sebep} (<@${w.mod}>, <t:${Math.floor(w.tarih / 1000)}:R>)`
    ).join('\n');
    return i.reply({ embeds: [mkEmbed('Yellow', `⚠️ ${user.tag} uyarıları (${list.length})`, text)], flags: ephemeral });
  });

// /uyari-sil
addCmd('uyari-sil', 'Bir kişinin tüm uyarılarını siler', PF.ModerateMembers,
  b => b.addUserOption(kisiOpt),
  async (i) => {
    const user = i.options.getUser('kisi');
    if (data.warns[i.guild.id]) delete data.warns[i.guild.id][user.id];
    saveData(data);
    await reply(i, `🗑️ ${user.tag} kişisinin uyarıları silindi.`);
    log(i.guild, `🗑️ **Uyarılar silindi**\n**Kişi:** ${user.tag} (${user.id})\n**Yetkili:** <@${i.user.id}>`, 'Blue');
  });

// /sil
addCmd('sil', 'Kanalda toplu mesaj siler', PF.ManageMessages,
  b => b
    .addIntegerOption(o => o.setName('miktar').setDescription('Silinecek mesaj sayısı (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption(o => o.setName('kisi').setDescription('Sadece bu kişinin mesajları')),
  async (i) => {
    const miktar = i.options.getInteger('miktar');
    const user = i.options.getUser('kisi');
    await i.deferReply({ flags: ephemeral });
    try {
      let deleted;
      if (user) {
        const msgs = await i.channel.messages.fetch({ limit: 100 });
        const filtered = msgs.filter(m => m.author.id === user.id).first(miktar);
        if (!filtered.length) return i.editReply('Silinecek mesaj bulunamadı.');
        deleted = await i.channel.bulkDelete(filtered, true);
      } else {
        deleted = await i.channel.bulkDelete(miktar, true);
      }
      await i.editReply(`🧹 ${deleted.size} mesaj silindi. (14 günden eski mesajlar silinemez.)`);
      log(i.guild, `🧹 **Mesaj silme**\n**Kanal:** <#${i.channel.id}>\n**Adet:** ${deleted.size}${user ? `\n**Kişi:** ${user.tag}` : ''}\n**Yetkili:** <@${i.user.id}>`, 'Blue');
    } catch { await i.editReply('❌ Mesajları silemedim. Yetkimi kontrol et.'); }
  });

// /yavasmod
addCmd('yavasmod', 'Kanalın yavaş modunu ayarlar (0 = kapat)', PF.ManageChannels,
  b => b.addIntegerOption(o => o.setName('saniye').setDescription('Saniye (0-21600)').setMinValue(0).setMaxValue(21600).setRequired(true)),
  async (i) => {
    const sn = i.options.getInteger('saniye');
    try { await i.channel.setRateLimitPerUser(sn, `${i.user.tag}`); }
    catch { return err(i, 'Yavaş mod ayarlanamadı.'); }
    await reply(i, sn ? `🐌 Yavaş mod **${sn} saniye** yapıldı.` : '✅ Yavaş mod kapatıldı.');
    log(i.guild, `🐌 **Yavaş mod**\n**Kanal:** <#${i.channel.id}>\n**Süre:** ${sn} sn\n**Yetkili:** <@${i.user.id}>`, 'Blue');
  });

// /kilitle
addCmd('kilitle', 'Bulunduğun kanalı herkese yazmaya kapatır', PF.ManageChannels, null,
  async (i) => {
    try { await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false }); }
    catch { return err(i, 'Kanal kilitlenemedi.'); }
    await i.reply({ embeds: [mkEmbed('Red', '🔒 Kanal kilitlendi', `<#${i.channel.id}> artık yazmaya kapalı.`)] });
    log(i.guild, `🔒 **Kanal kilitlendi:** <#${i.channel.id}>\n**Yetkili:** <@${i.user.id}>`, 'Red');
  });

// /kilit-ac
addCmd('kilit-ac', 'Bulunduğun kanalın kilidini açar', PF.ManageChannels, null,
  async (i) => {
    try { await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null }); }
    catch { return err(i, 'Kilit açılamadı.'); }
    await i.reply({ embeds: [mkEmbed('Green', '🔓 Kanal kilidi açıldı', `<#${i.channel.id}> tekrar yazmaya açık.`)] });
    log(i.guild, `🔓 **Kanal kilidi açıldı:** <#${i.channel.id}>\n**Yetkili:** <@${i.user.id}>`, 'Green');
  });

// /rol-ver ve /rol-al
function roleCheck(i, role) {
  if (role.managed) return 'Bu rol bir bot/entegrasyon rolü, verilip alınamaz.';
  if (role.id === i.guild.id) return 'Bu rol verilemez.';
  const me = i.guild.members.me;
  if (role.position >= me.roles.highest.position) return 'Bu rol benim rolümden yüksek veya eşit.';
  const bypass = i.user.id === i.guild.ownerId || isOwner(i.user.id);
  if (!bypass && role.position >= i.member.roles.highest.position) return 'Bu rol senin rolünden yüksek veya eşit.';
  if (!bypass && role.permissions.has(PF.Administrator)) return 'Yönetici yetkili rolleri sadece sunucu sahibi verebilir.';
  return null;
}
for (const [name, desc, give] of [['rol-ver', 'Bir kişiye rol verir', true], ['rol-al', 'Bir kişiden rol alır', false]]) {
  addCmd(name, desc, PF.ManageRoles,
    b => b.addUserOption(kisiOpt).addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)),
    async (i) => {
      const user = i.options.getUser('kisi');
      const role = i.options.getRole('rol');
      const member = await getMember(i, user);
      if (!member) return err(i, 'Bu kişi sunucuda değil.');
      const e = roleCheck(i, role);
      if (e) return err(i, e);
      try {
        if (give) await member.roles.add(role.id, i.user.tag);
        else await member.roles.remove(role.id, i.user.tag);
      } catch { return err(i, 'İşlem yapılamadı.'); }
      await reply(i, `${give ? '✅' : '🗑️'} <@${user.id}> kişisine ${give ? 'verildi' : 'alındı'}: **${role.name}**`);
      log(i.guild, `${give ? '➕ **Rol verildi**' : '➖ **Rol alındı**'}\n**Kişi:** ${user.tag} (${user.id})\n**Rol:** ${role.name}\n**Yetkili:** <@${i.user.id}>`, 'Blue');
    });
}

// /takma-ad
addCmd('takma-ad', 'Bir kişinin takma adını değiştirir (boş bırakırsan sıfırlanır)', PF.ManageNicknames,
  b => b.addUserOption(kisiOpt).addStringOption(o => o.setName('isim').setDescription('Yeni isim').setMaxLength(32)),
  async (i) => {
    const user = i.options.getUser('kisi');
    const isim = i.options.getString('isim') ?? null;
    const member = await getMember(i, user);
    if (!member) return err(i, 'Bu kişi sunucuda değil.');
    const e = checkTarget(i, member);
    if (e) return err(i, e);
    try { await member.setNickname(isim, i.user.tag); }
    catch { return err(i, 'Takma ad değiştirilemedi.'); }
    return reply(i, isim ? `✅ <@${user.id}> adı **${isim}** yapıldı.` : `✅ <@${user.id}> takma adı sıfırlandı.`);
  });

// /kullanici-bilgi
addCmd('kullanici-bilgi', 'Bir kişi hakkında bilgi gösterir', null,
  b => b.addUserOption(o => o.setName('kisi').setDescription('Kişi (boşsa sen)')),
  async (i) => {
    const user = i.options.getUser('kisi') ?? i.user;
    const member = await getMember(i, user);
    const e = new EmbedBuilder()
      .setColor('Blue')
      .setTitle(user.tag)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: user.id, inline: true },
        { name: 'Hesap açılışı', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Sunucuya katılış', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Sunucuda değil', inline: true },
        { name: 'En yüksek rol', value: member ? `${member.roles.highest}` : '-', inline: true },
        { name: 'Uyarı sayısı', value: `${data.warns[i.guild.id]?.[user.id]?.length ?? 0}`, inline: true }
      );
    return i.reply({ embeds: [e] });
  });

// /avatar
addCmd('avatar', 'Bir kişinin profil fotoğrafını gösterir', null,
  b => b.addUserOption(o => o.setName('kisi').setDescription('Kişi (boşsa sen)')),
  async (i) => {
    const user = i.options.getUser('kisi') ?? i.user;
    return i.reply({ embeds: [new EmbedBuilder().setColor('Blue').setTitle(user.tag).setImage(user.displayAvatarURL({ size: 1024 }))] });
  });

// ---------- Hazır olunca komutları kaydet ----------
client.once(Events.ClientReady, async () => {
  await client.application.commands.set(builders);
  console.log(`${client.user.tag} aktif!`);
  // Yedekleme sistemini arka planda başlat
  for (const g of client.guilds.cache.values()) setupGuild(g).catch(console.error);
});

// ---------- Slash komutları ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  const uid = i.user.id;
  const cmd = i.commandName;

  // --- Moderasyon / log komutları ---
  const mod = modCommands.get(cmd);
  if (mod) {
    if (!i.guild) return err(i, 'Bu komut sadece sunucuda kullanılabilir.');
    if (mod.perm && !isOwner(uid) && !i.memberPermissions.has(mod.perm))
      return err(i, 'Bu komut için yetkin yok.');
    try { return await mod.run(i); }
    catch (e) {
      console.error(`/${cmd} hatası:`, e);
      const msg = '❌ Bir hata oluştu.';
      return i.replied || i.deferred ? i.followUp({ content: msg, flags: ephemeral }).catch(() => {}) : reply(i, msg);
    }
  }

  // --- Sadece kurucu ---
  if (cmd === 'tamyetki-ver' || cmd === 'tamyetki-al') {
    if (!isOwner(uid)) return reply(i, '❌ Bu komutu sadece bot kurucusu kullanabilir.');

    const user = i.options.getUser('kisi');

    if (cmd === 'tamyetki-ver') {
      if (!data.tam.includes(user.id)) { data.tam.push(user.id); saveData(data); }
      if (i.guild) log(i.guild, `👑 <@${user.id}> **tam yetki** aldı.`, 'Blue');
      return reply(i, `✅ <@${user.id}> artık **tam yetkili**. Başkalarına yetki verip alabilir.`);
    }

    data.tam = data.tam.filter(x => x !== user.id);
    saveData(data);
    if (i.guild) log(i.guild, `🗑️ <@${user.id}> kişisinin **tam yetkisi** alındı.`, 'Blue');
    return reply(i, `🗑️ <@${user.id}> kişisinin tam yetkisi alındı.`);
  }

  // --- Kurucu ve tam yetkililer ---
  if (cmd === 'yetki-ver' || cmd === 'yetki-al' || cmd === 'yetki-liste') {
    if (!isOwner(uid) && !isTam(uid)) {
      return reply(i, '❌ Bu komutu sadece bot kurucusu ve tam yetkililer kullanabilir.');
    }

    if (cmd === 'yetki-liste') {
      const tam = data.tam.length ? data.tam.map(x => `<@${x}> (${x})`).join('\n') : 'Kimse yok.';
      const yetki = data.yetki.length ? data.yetki.map(x => `<@${x}> (${x})`).join('\n') : 'Kimse yok.';
      return reply(i, `**👑 Tam yetkililer:**\n${tam}\n\n**🛡️ Yetkililer (dokunulmaz):**\n${yetki}`);
    }

    const user = i.options.getUser('kisi');

    if (cmd === 'yetki-ver') {
      if (!data.yetki.includes(user.id)) { data.yetki.push(user.id); saveData(data); }
      if (i.guild) log(i.guild, `🛡️ <@${user.id}> kişisine <@${uid}> **yetki** verdi.`, 'Blue');
      return reply(i, `✅ <@${user.id}> artık **dokunulmaz**. Kanal/rol silebilir, ban ve kick atabilir.`);
    }

    // yetki-al: tam yetkili birinin yetkisini sadece kurucu alabilir
    if (isTam(user.id) && !isOwner(uid)) {
      return reply(i, '❌ Tam yetkili birinin yetkisini sadece bot kurucusu alabilir.');
    }
    if (isOwner(user.id)) {
      return reply(i, '❌ Bot kurucusunun yetkisi alınamaz.');
    }
    data.yetki = data.yetki.filter(x => x !== user.id);
    saveData(data);
    if (i.guild) log(i.guild, `🗑️ <@${user.id}> kişisinin yetkisi <@${uid}> tarafından alındı.`, 'Blue');
    return reply(i, `🗑️ <@${user.id}> kişisinin yetkisi alındı.`);
  }
});

// =====================================================================
//  YEDEKLEME SİSTEMİ  (silinen kanal/rol "hiç silinmemiş gibi" geri gelsin)
//  Her şey bellekte tutulur, diske yazılmaz.
// =====================================================================
const MESAJ_LIMIT = Number(process.env.MESAJ_LIMIT) || 500; // kanal başına yedeklenen mesaj
const msgStore = new Map();        // kanalId -> [mesaj, ...]
const roleMembers = new Map();     // rolId   -> Set(üyeId)
const roleOverwrites = new Map();  // rolId   -> Map(kanalId -> {allow, deny})
const chanParent = new Map();      // kanalId -> kategoriId
const chanMap = new Map();         // eski kanalId -> yeni kanalId
const roleMap = new Map();         // eski rolId   -> yeni rolId
const hookIds = new Set();         // geri yükleme webhook'ları (yedeğe alınmaz)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function isStorable(m) {
  return !m.partial && m.guild && TEXT_TYPES.includes(m.channel?.type) &&
    (m.type === MessageType.Default || m.type === MessageType.Reply) &&
    !(m.webhookId && hookIds.has(m.webhookId));
}

function toStore(m) {
  return {
    id: m.id,
    author: m.member?.displayName ?? m.author?.globalName ?? m.author?.username ?? 'Bilinmeyen',
    avatar: m.member?.displayAvatarURL?.() ?? m.author?.displayAvatarURL?.(),
    content: m.content ?? '',
    files: [...m.attachments.values()].map(a => ({ url: a.url, name: a.name, size: a.size })),
    embeds: m.embeds.filter(e => e.data?.type === 'rich').map(e => e.toJSON()),
    ts: m.createdTimestamp,
    pinned: m.pinned
  };
}

function pushMsg(chId, rec) {
  const arr = msgStore.get(chId) ?? [];
  if (arr.some(x => x.id === rec.id)) return;
  arr.push(rec);
  if (arr.length > MESAJ_LIMIT) arr.splice(0, arr.length - MESAJ_LIMIT);
  msgStore.set(chId, arr);
}

client.on(Events.MessageCreate, (m) => { if (isStorable(m)) pushMsg(m.channel.id, toStore(m)); });

client.on(Events.MessageUpdate, (o, n) => {
  if (!isStorable(n)) return;
  const arr = msgStore.get(n.channel.id);
  const idx = arr ? arr.findIndex(x => x.id === n.id) : -1;
  if (idx >= 0) arr[idx] = toStore(n);
  else pushMsg(n.channel.id, toStore(n));
});

client.on(Events.MessageDelete, (m) => {
  const arr = msgStore.get(m.channelId);
  if (arr) msgStore.set(m.channelId, arr.filter(x => x.id !== m.id));
});

client.on(Events.MessageBulkDelete, (msgs, ch) => {
  const arr = msgStore.get(ch.id);
  if (arr) msgStore.set(ch.id, arr.filter(x => !msgs.has(x.id)));
});

// ---- Rol üyeleri ve kanal izinleri anlık görüntüsü ----
function trackMember(m) {
  for (const id of m.roles.cache.keys()) {
    if (id === m.guild.id) continue;
    if (!roleMembers.has(id)) roleMembers.set(id, new Set());
    roleMembers.get(id).add(m.id);
  }
}

function snapChannel(ch) {
  if (!ch.guild || ch.isThread?.()) return;
  const prev = chanParent.get(ch.id);
  // Kategori silinince çocukların parent'ı null olur; eski değeri koru
  if (ch.parentId || !prev || ch.guild.channels.cache.has(prev)) chanParent.set(ch.id, ch.parentId);
  if (!ch.permissionOverwrites) return;
  const present = new Set();
  for (const o of ch.permissionOverwrites.cache.values()) {
    if (o.type !== OverwriteType.Role || o.id === ch.guild.id) continue;
    present.add(o.id);
    if (!roleOverwrites.has(o.id)) roleOverwrites.set(o.id, new Map());
    roleOverwrites.get(o.id).set(ch.id, { allow: o.allow, deny: o.deny });
  }
  // Rol hâlâ varken izin kaldırıldıysa kaydı sil (rol silindiyse koru)
  for (const [roleId, map] of roleOverwrites) {
    if (map.has(ch.id) && !present.has(roleId) && ch.guild.roles.cache.has(roleId)) map.delete(ch.id);
  }
}

client.on(Events.GuildMemberAdd, trackMember);
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  trackMember(newM);
  if (oldM && !oldM.partial) {
    for (const id of oldM.roles.cache.keys()) {
      // Rol hâlâ sunucuda varsa üyeden gerçekten alınmıştır
      if (!newM.roles.cache.has(id) && newM.guild.roles.cache.has(id)) roleMembers.get(id)?.delete(newM.id);
    }
  }
});
client.on(Events.ChannelCreate, snapChannel);
client.on(Events.ChannelUpdate, (o, n) => snapChannel(n));

// ---- Geçmiş mesajları yedeğe al (bot açılınca) ----
async function backfill(ch) {
  const perms = ch.permissionsFor(ch.guild.members.me);
  if (!perms?.has([PF.ViewChannel, PF.ReadMessageHistory])) return;
  const all = [];
  let before;
  while (all.length < MESAJ_LIMIT) {
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  const fetched = all.filter(isStorable).map(toStore);
  const live = msgStore.get(ch.id) ?? [];
  const byId = new Map([...fetched, ...live].map(x => [x.id, x]));
  const sorted = [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-MESAJ_LIMIT);
  msgStore.set(ch.id, sorted);
}

async function setupGuild(guild) {
  try { await guild.members.fetch(); } catch (e) { console.error('Üyeler çekilemedi:', e.message); }
  guild.members.cache.forEach(trackMember);
  guild.channels.cache.forEach(snapChannel);
  for (const ch of guild.channels.cache.values()) {
    if (TEXT_TYPES.includes(ch.type)) {
      await backfill(ch).catch(() => {});
      await sleep(300);
    }
  }
  console.log(`${guild.name}: yedekleme hazır`);
}
client.on(Events.GuildCreate, (g) => setupGuild(g).catch(console.error));

// ---- Mesajları webhook ile geri yükle ----
const cleanName = (n) => {
  let s = String(n || 'Bilinmeyen').replace(/discord/gi, 'Dıscord').replace(/clyde/gi, 'Clyd3').slice(0, 80);
  if (s.length < 2) s += ' ·';
  return s;
};

async function download(f) {
  try {
    if (f.size > 8 * 1024 * 1024) return null;
    const r = await fetch(f.url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return { attachment: Buffer.from(await r.arrayBuffer()), name: f.name };
  } catch { return null; }
}

async function restoreMessages(channel, msgs) {
  if (!msgs?.length || !TEXT_TYPES.includes(channel.type)) return 0;
  let hook;
  try {
    hook = await channel.createWebhook({ name: 'Geri Yükleme', reason: 'Koruma: mesajlar geri yükleniyor' });
  } catch (e) { console.error('Webhook oluşturulamadı:', e.message); return 0; }
  hookIds.add(hook.id);

  let count = 0;
  for (const m of msgs) {
    if (!m.content && !m.files.length && !m.embeds.length) continue;
    try {
      const notes = [];
      const files = [];
      for (const f of m.files) {
        const d = await download(f);
        if (d) files.push(d); else notes.push(`📎 ${f.name} (dosya geri yüklenemedi)`);
      }
      const stamp = `-# 🕒 <t:${Math.floor(m.ts / 1000)}:f>`;
      const body = [m.content.slice(0, 1700), ...notes, stamp].filter(Boolean).join('\n').slice(0, 2000);
      const sent = await hook.send({
        username: cleanName(m.author),
        avatarURL: m.avatar,
        content: body,
        embeds: m.embeds.slice(0, 10),
        files,
        allowedMentions: { parse: [] }
      });
      count++;
      if (m.pinned) { try { await sent.pin(); } catch {} }
    } catch (e) { console.error('Mesaj yüklenemedi:', e.message); }
  }
  await hook.delete().catch(() => {});
  return count;
}

// Silinen kanalın izinlerini (silinmiş rolleri yeni rollerle eşleyerek) hazırla
function buildOverwrites(guild, channel) {
  const out = [];
  for (const o of channel.permissionOverwrites.cache.values()) {
    let id = o.id;
    if (o.type === OverwriteType.Role) {
      id = roleMap.get(id) ?? id;
      if (!guild.roles.cache.has(id)) continue;
    } else if (!guild.members.cache.has(id)) continue;
    out.push({ id, type: o.type, allow: o.allow, deny: o.deny });
  }
  return out;
}

// ---------- Kanal silinirse ----------
client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild || channel.isThread?.()) return;
  const guild = channel.guild;
  const backup = msgStore.get(channel.id);
  const childIds = [...chanParent.entries()].filter(([, p]) => p === channel.id).map(([id]) => id);

  const executor = await findExecutor(guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!executor || executor.id === client.user.id || isAllowed(executor.id)) {
    msgStore.delete(channel.id);
    return;
  }

  const parent = chanMap.get(channel.parentId) ?? (guild.channels.cache.has(channel.parentId) ? channel.parentId : null);
  let newCh;
  try {
    newCh = await guild.channels.create({
      name: channel.name,
      type: channel.type,
      parent,
      topic: channel.topic ?? undefined,
      nsfw: channel.nsfw,
      bitrate: channel.bitrate,
      userLimit: channel.userLimit,
      rateLimitPerUser: channel.rateLimitPerUser,
      permissionOverwrites: buildOverwrites(guild, channel),
      reason: 'Koruma: silinen kanal geri yüklendi'
    });
    chanMap.set(channel.id, newCh.id);
    chanParent.set(newCh.id, parent);
    await newCh.setPosition(channel.position).catch(() => {});

    // Silinen kanal log kanalıysa yenisini log kanalı yap
    if (data.logChannels[guild.id] === channel.id) {
      data.logChannels[guild.id] = newCh.id;
      saveData(data);
    }

    // Kategori silindiyse altındaki kanalları geri taşı
    if (channel.type === ChannelType.GuildCategory) {
      for (const cid of childIds) {
        const target = guild.channels.cache.get(chanMap.get(cid) ?? cid);
        if (target && target.parentId !== newCh.id) {
          await target.setParent(newCh.id, { lockPermissions: false }).catch(() => {});
        }
      }
    }
  } catch (e) { console.error('Kanal geri yükleme hatası:', e.message); }

  log(guild, `**${channel.name}** kanalı <@${executor.id}> tarafından silindi. Kanal ve izinleri geri yüklendi${backup?.length ? `, **${backup.length}** mesaj yükleniyor...` : '.'}`);

  // Mesajları arka planda geri yükle
  if (newCh && backup?.length) {
    msgStore.set(newCh.id, [...backup]);
    msgStore.delete(channel.id);
    restoreMessages(newCh, backup)
      .then(n => log(guild, `📨 **${channel.name}** kanalına **${n}** mesaj geri yüklendi.`, 'Green'))
      .catch(e => console.error('Mesaj geri yükleme hatası:', e.message));
  }
});

// ---------- Rol silinirse ----------
client.on(Events.GuildRoleDelete, async (role) => {
  if (role.managed) return; // bot/entegrasyon rolleri geri oluşturulamaz
  const guild = role.guild;
  const members = roleMembers.has(role.id) ? [...roleMembers.get(role.id)] : [];
  const overwrites = roleOverwrites.get(role.id);

  const executor = await findExecutor(guild, AuditLogEvent.RoleDelete, role.id);
  if (!executor || executor.id === client.user.id || isAllowed(executor.id)) {
    roleMembers.delete(role.id);
    roleOverwrites.delete(role.id);
    return;
  }

  let newRole;
  let permCount = 0;
  try {
    newRole = await guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions,
      mentionable: role.mentionable,
      reason: 'Koruma: silinen rol geri yüklendi'
    });
    roleMap.set(role.id, newRole.id);
    await newRole.setPosition(role.position).catch(() => {});

    // Kanallardaki rol izinlerini yeniden uygula
    if (overwrites) {
      for (const [chId, ov] of overwrites) {
        const ch = guild.channels.cache.get(chanMap.get(chId) ?? chId);
        if (!ch?.permissionOverwrites) continue;
        const cur = [...ch.permissionOverwrites.cache.values()].map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
        if (cur.some(o => o.id === newRole.id)) continue;
        const ok = await ch.permissionOverwrites
          .set([...cur, { id: newRole.id, type: OverwriteType.Role, allow: ov.allow, deny: ov.deny }])
          .then(() => true).catch(() => false);
        if (ok) permCount++;
      }
    }

    // Anlık görüntüleri yeni role taşı
    roleMembers.set(newRole.id, new Set(members));
    roleMembers.delete(role.id);
    roleOverwrites.set(newRole.id, overwrites ?? new Map());
    roleOverwrites.delete(role.id);
  } catch (e) { console.error('Rol geri yükleme hatası:', e.message); }

  log(guild, `**${role.name}** rolü <@${executor.id}> tarafından silindi. Rol geri yüklendi, **${permCount}** kanalda izinleri yeniden uygulandı${members.length ? `, **${members.length}** üyeye rol geri veriliyor...` : '.'}`);

  // Rol üyelerine rolü geri ver (arka planda)
  if (newRole && members.length) {
    (async () => {
      let n = 0;
      for (const id of members) {
        const m = guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
        if (!m) continue;
        await m.roles.add(newRole, 'Koruma: rol üyeleri geri yüklendi').then(() => n++).catch(() => {});
      }
      log(guild, `👥 **${role.name}** rolü **${n}** üyeye geri verildi.`, 'Green');
    })().catch(e => console.error('Rol üyeleri hatası:', e.message));
  }
});

// ---------- Ban atılırsa otomatik unban ----------
client.on(Events.GuildBanAdd, async (ban) => {
  const executor = await findExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (!executor || executor.id === client.user.id || isAllowed(executor.id)) return;

  try {
    await ban.guild.members.unban(ban.user.id, 'Koruma: izinsiz ban geri alındı');
  } catch (e) { console.error('Unban hatası:', e.message); }

  log(ban.guild, `<@${executor.id}>, **${ban.user.tag}** kişisini banladı. Ban otomatik kaldırıldı.`);
});

// ---------- Kick atılırsa davet gönder ----------
client.on(Events.GuildMemberRemove, async (member) => {
  const executor = await findExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
  if (!executor || executor.id === client.user.id || isAllowed(executor.id)) return;

  let sent = false;
  try {
    const ch = member.guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(member.guild.members.me)?.has(PF.CreateInstantInvite)
    );
    if (ch) {
      const invite = await ch.createInvite({ maxAge: 86400, maxUses: 1, unique: true });
      await member.user.send(
        `**${member.guild.name}** sunucusundan izinsiz atıldın. Geri dönmek için: ${invite.url}`
      );
      sent = true;
    }
  } catch (e) { console.error('Davet gönderilemedi:', e.message); }

  log(
    member.guild,
    `<@${executor.id}>, **${member.user.tag}** kişisini kickledi. ${
      sent ? 'Kişiye davet linki gönderildi.' : 'Davet gönderilemedi (DM kapalı olabilir).'
    }`
  );
});

client.login(TOKEN);
