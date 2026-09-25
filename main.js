const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const client = new Client();
const PREFIX = 'ave';

// Masukkan ID Discord utama kamu di sini
const SUPER_OWNER = 'ID_DISCORD_KAMU_PRIBADI'; 
let owners = new Set([SUPER_OWNER]);

// Simpan antrean musik per guild
const queues = new Map();

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(PREFIX) || message.author.bot) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    // Cek apakah pengirim pesan adalah Owner / Super Owner
    const isOwner = owners.has(message.author.id);

    // ==========================================
    // 1. COMMAND: avejoin
    // ==========================================
    if (command === 'join') {
        const userVoiceChannel = message.member?.voice.channel;
        if (!userVoiceChannel) {
            return message.reply('❌ Kamu harus masuk ke Voice Channel terlebih dahulu!');
        }

        // Cek koneksi voice bot di server ini saat ini
        const currentConnection = getVoiceConnection(message.guild.id);

        if (currentConnection) {
            const currentChannelId = currentConnection.joinConfig.channelId;

            // Jika bot sudah berada di VC yang sama
            if (currentChannelId === userVoiceChannel.id) {
                return message.reply('Bot sudah berada di Voice Channel ini.');
            }

            // Jika bot sedang di VC lain dan yang minta BUKAN Owner
            if (!isOwner) {
                return message.reply('Bot sedang berada di Voice Channel lain. Hanya **Owner** yang bisa memaksa bot pindah!');
            }
        }

        // Jalankan perintah join/pindah (Bisa dilakukan oleh Siapa Saja jika bot kosong, atau oleh Owner jika bot sedang di VC lain)
        joinVoiceChannel({
            channelId: userVoiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: true,
        });

        return message.reply(`Berhasil bergabung ke Voice Channel: **${userVoiceChannel.name}**`);
    }

    // ==========================================
    // 2. COMMAND: aveleave (HANYA OWNER)
    // ==========================================
    if (command === 'leave') {
        if (!isOwner) {
            return message.reply('Hanya **Owner** yang bisa mengeluarkan bot dari Voice Channel!');
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
    // 3. COMMAND: avestop (SEMUA USER)
    // ==========================================
    if (command === 'stop') {
        const queue = queues.get(message.guild.id);
        if (!queue) {
            return message.reply('ℹ️ Tidak ada musik yang sedang diputar.');
        }

        // Kosongkan antrean & stop pemutaran (Bisa dipanggil oleh semua user)
        queue.songs = [];
        if (queue.player) queue.player.stop();

        return message.reply('Musik telah dihentikan dan seluruh antrean lagu telah dibersihkan.');
    }

    // ==========================================
    // 4. MANAGEMENT OWNER (SUPER OWNER ONLY)
    // ==========================================
    if (command === 'grantowner') {
        if (message.author.id !== SUPER_OWNER) return message.reply('⚠️ Hanya Super Owner yang bisa menambah Owner baru!');
        const targetId = args[0];
        if (!targetId) return message.reply('Sebutkan ID Discord target!');
        owners.add(targetId);
        return message.reply(`Berhasil menambahkan <@${targetId}> sebagai Owner.`);
    }

    if (command === 'revokeowner') {
        if (message.author.id !== SUPER_OWNER) return message.reply('Hanya Super Owner yang bisa mencabut akses Owner!');
        const targetId = args[0];
        if (targetId === SUPER_OWNER) return message.reply('Tidak dapat mencabut akses Super Owner!');
        owners.delete(targetId);
        return message.reply(`🗑️ Akses Owner dari <@${targetId}> berhasil dicabut.`);
    }
});

client.login(process.env.DISCORD_TOKEN);
