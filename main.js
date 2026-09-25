const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const client = new Client();
const PREFIX = 'ave';

// Mengambil Token dan Super Owner ID dari Environment Variables
const TOKEN = process.env.DISCORD_TOKEN;
const SUPER_OWNER = process.env.SUPER_OWNER || 'ID_DISCORD_KAMU';

// Menyimpan daftar ID Owner (Super Owner + Whitelisted Owners)
let owners = new Set([SUPER_OWNER]);

// Storage untuk Antrean Musik per Server
const queues = new Map();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}! Bot siap digunakan.`);
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(PREFIX) || message.author.bot) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    // Cek apakah pengirim pesan memiliki akses Owner/Super Owner
    const isOwner = owners.has(message.author.id);
    const isSuperOwner = message.author.id === SUPER_OWNER;

    // ==========================================
    // FITUR: avehelp
    // ==========================================
    if (command === 'help') {
        const helpText = `
**Daftar Perintah Selfbot Music (Prefix: \`${PREFIX}\`)**

**Voice Channel**
• \`${PREFIX}join\` - Meminta bot masuk ke VC kamu.
• \`${PREFIX}leave\` - Mengeluarkan bot dari VC.
**Kontrol Pemutaran Musik**
• \`${PREFIX}play <judul/URL>\` - Memutar lagu atau menambahkannya ke queue.
• \`${PREFIX}skip\` - Melompati lagu yang sedang diputar.
• \`${PREFIX}pause\` / \`${PREFIX}resume\` - Menjeda / melanjutkan lagu.
• \`${PREFIX}stop\` - Menghentikan lagu & membersihkan antrean.
• \`${PREFIX}remove <nomor>\` - Menghapus lagu tertentu dari queue.
• \`${PREFIX}loop\` / \`${PREFIX}loop queue\` - Toggle loop lagu aktif / loop queue.
• \`${PREFIX}autoplay\` - Toggle rekomendasi lagu otomatis.
• \`${PREFIX}shuffle\` - Mengacak urutan lagu di queue.
        `;
        return message.reply(helpText);
    }

    // ==========================================
    // VOICE MANAGEMENT
    // ==========================================
    if (command === 'join') {
        const userVoiceChannel = message.member?.voice.channel;
        if (!userVoiceChannel) {
            return message.reply('Kamu harus masuk ke Voice Channel terlebih dahulu!');
        }

        const currentConnection = getVoiceConnection(message.guild.id);

        if (currentConnection) {
            const currentChannelId = currentConnection.joinConfig.channelId;

            if (currentChannelId === userVoiceChannel.id) {
                return message.reply('Bot sudah berada di Voice Channel ini.');
            }

            // Jika bot sedang di VC lain dan pengirim pesan BUKAN owner
            if (!isOwner) {
                return message.reply('Bot sedang berada di Voice Channel lain. Hanya Owner yang bisa memaksa bot pindah!');
            }
        }

        joinVoiceChannel({
            channelId: userVoiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: true,
        });

        return message.reply(`Berhasil bergabung ke Voice Channel: **${userVoiceChannel.name}**`);
    }

    if (command === 'leave') {
        if (!isOwner) {
            return message.reply('Hanya Owner yang bisa mengeluarkan bot dari Voice Channel!');
        }

        const currentConnection = getVoiceConnection(message.guild.id);
        if (!currentConnection) {
            return message.reply('Bot sedang tidak berada di Voice Channel mana pun.');
        }

        currentConnection.destroy();
        queues.delete(message.guild.id);
        return message.reply('Bot telah keluar dari Voice Channel.');
    }

    // ==========================================
    // OWNER MANAGEMENT
    // ==========================================
    if (command === 'grantowner') {
        if (!isSuperOwner) return message.reply('Hanya Super Owner yang bisa menambah Owner baru!');
        const targetId = args[0];
        if (!targetId) return message.reply('Sebutkan ID Discord target! Contoh: avegrantowner 123456789');
        
        owners.add(targetId);
        return message.reply(`Berhasil menambahkan <@${targetId}> sebagai Owner.`);
    }

    if (command === 'revokeowner') {
        if (!isSuperOwner) return message.reply('Hanya Super Owner yang bisa mencabut akses Owner!');
        const targetId = args[0];
        if (!targetId) return message.reply('Sebutkan ID Discord target!');
        if (targetId === SUPER_OWNER) return message.reply('Tidak dapat mencabut akses Super Owner!');

        owners.delete(targetId);
        return message.reply(`Akses Owner dari <@${targetId}> berhasil dicabut.`);
    }

    // ==========================================
    // MUSIC CONTROLS
    // ==========================================
    if (command === 'stop') {
        const queue = queues.get(message.guild.id);
        if (!queue) return message.reply('Tidak ada musik yang sedang diputar.');

        queue.songs = [];
        if (queue.player) queue.player.stop();

        return message.reply('Musik dihentikan dan seluruh antrean lagu telah dibersihkan.');
    }

    if (command === 'shuffle') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length < 2) return message.reply('Jumlah antrean lagu kurang untuk diacak!');

        const currentSong = queue.songs.shift();
        queue.songs.sort(() => Math.random() - 0.5);
        queue.songs.unshift(currentSong);

        return message.reply('Antrean lagu berhasil diacak!');
    }
});

client.login(TOKEN);
