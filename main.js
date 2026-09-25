const { Client } = require('discord.js-selfbot-v13');
const { 
    joinVoiceChannel, 
    getVoiceConnection, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus 
} = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const play = require('play-dl');

const client = new Client();
const PREFIX = 'ave';

const TOKEN = process.env.DISCORD_TOKEN;
const SUPER_OWNER = process.env.SUPER_OWNER || 'ID_DISCORD_KAMU';

let owners = new Set([SUPER_OWNER]);

// Queue storage per server
const queues = new Map();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

// Fungsi untuk memutar lagu berikutnya di antrean
async function playSong(guildId) {
    const queue = queues.get(guildId);
    if (!queue) return;

    if (queue.songs.length === 0) {
        queue.textChannel.send('Antrean lagu telah habis.');
        return;
    }

    const currentSong = queue.songs[0];

    try {
        const stream = await ytdl(currentSong.url, {
            filter: 'audioonly',
            highWaterMark: 1 << 25,
            quality: 'highestaudio'
        });

        const resource = createAudioResource(stream);
        queue.player.play(resource);
        queue.connection.subscribe(queue.player);

        queue.textChannel.send(`Playing: **${currentSong.title}**`);
    } catch (error) {
        console.error(error);
        queue.textChannel.send(`Gagal memutar lagu: **${currentSong.title}**`);
        queue.songs.shift();
        playSong(guildId);
    }
}

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(PREFIX) || message.author.bot) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const isOwner = owners.has(message.author.id);
    const isSuperOwner = message.author.id === SUPER_OWNER;

    // ==========================================
    // HELP COMMAND
    // ==========================================
    if (command === 'help') {
        const helpText = `
**Daftar Perintah Selfbot Music (Prefix: \`${PREFIX}\`)**

**Voice Channel**
• \`${PREFIX}join\` - Meminta bot masuk ke VC kamu (Owner bisa memaksa bot pindah VC).
• \`${PREFIX}leave\` - Mengeluarkan bot dari VC (Owner Only).

**Kontrol Pemutaran Musik**
• \`${PREFIX}play <judul/URL>\` - Memutar lagu atau menambahkannya ke queue.
• \`${PREFIX}skip\` - Melompati lagu yang sedang diputar.
• \`${PREFIX}pause\` / \`${PREFIX}resume\` - Menjeda / melanjutkan lagu.
• \`${PREFIX}stop\` - Menghentikan lagu & membersihkan antrean.
• \`${PREFIX}remove <nomor>\` - Menghapus lagu tertentu dari queue.
• \`${PREFIX}loop\` / \`${PREFIX}loop queue\` - Toggle loop lagu aktif / loop queue.
• \`${PREFIX}autoplay\` - Toggle rekomendasi lagu otomatis.
• \`${PREFIX}shuffle\` - Mengacak urutan lagu di queue.
• \`${PREFIX}help\` - Menampilkan daftar perintah ini.
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

            if (!isOwner) {
                return message.reply('Bot sedang berada di Voice Channel lain. Hanya Owner yang bisa memaksa bot pindah!');
            }
        }

        const connection = joinVoiceChannel({
            channelId: userVoiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: false, // Set false agar tidak deafen di awal
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
    // MUSIC PLAYBACK
    // ==========================================
    if (command === 'play') {
        const userVoiceChannel = message.member?.voice.channel;
        if (!userVoiceChannel) {
            return message.reply('Kamu harus masuk ke Voice Channel terlebih dahulu!');
        }

        const query = args.join(' ');
        if (!query) {
            return message.reply('Masukkan judul lagu atau link YouTube! Contoh: `aveplay silver lining laufey`');
        }

        let connection = getVoiceConnection(message.guild.id);
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: userVoiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfMute: false,
                selfDeaf: false
            });
        }

        message.reply(`Mencari lagu: **${query}**...`);

        try {
            let songInfo = {};
            if (ytdl.validateURL(query)) {
                const info = await ytdl.getBasicInfo(query);
                songInfo = { title: info.videoDetails.title, url: info.videoDetails.video_url };
            } else {
                const searchResults = await play.search(query, { limit: 1 });
                if (!searchResults || searchResults.length === 0) {
                    return message.reply('Lagu tidak ditemukan.');
                }
                songInfo = { title: searchResults[0].title, url: searchResults[0].url };
            }

            let queue = queues.get(message.guild.id);

            if (!queue) {
                const player = createAudioPlayer();
                queue = {
                    textChannel: message.channel,
                    connection: connection,
                    player: player,
                    songs: [],
                    loopTrack: false,
                    loopQueue: false
                };

                queues.set(message.guild.id, queue);
                queue.songs.push(songInfo);

                // Event ketika lagu selesai
                player.on(AudioPlayerStatus.Idle, () => {
                    const currentQueue = queues.get(message.guild.id);
                    if (!currentQueue) return;

                    if (currentQueue.loopTrack) {
                        playSong(message.guild.id);
                    } else if (currentQueue.loopQueue) {
                        const lastSong = currentQueue.songs.shift();
                        currentQueue.songs.push(lastSong);
                        playSong(message.guild.id);
                    } else {
                        currentQueue.songs.shift();
                        playSong(message.guild.id);
                    }
                });

                playSong(message.guild.id);
            } else {
                queue.songs.push(songInfo);
                message.reply(`Added to queue: **${songInfo.title}**`);
            }

        } catch (err) {
            console.error(err);
            message.reply('Terjadi kesalahan saat mengambil lagu.');
        }
    }

    if (command === 'pause') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.player) return message.reply('Tidak ada lagu yang sedang diputar.');
        
        queue.player.pause();
        return message.reply('Track paused.');
    }

    if (command === 'resume') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.player) return message.reply('Tidak ada lagu yang sedang di-pause.');

        queue.player.unpause();
        return message.reply('Track resumed.');
    }

    if (command === 'skip') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length === 0) return message.reply('Tidak ada lagu untuk di-skip.');

        message.reply('Skipped track.');
        queue.player.stop(); // Mentriggers AudioPlayerStatus.Idle untuk memutar lagu selanjutnya
    }

    if (command === 'stop') {
        const queue = queues.get(message.guild.id);
        if (!queue) return message.reply('Tidak ada musik yang sedang diputar.');

        queue.songs = [];
        if (queue.player) queue.player.stop();

        return message.reply('Stopped playback and cleared queue.');
    }

    if (command === 'loop') {
        const queue = queues.get(message.guild.id);
        if (!queue) return message.reply('Tidak ada musik yang sedang diputar.');

        const subCommand = args[0]?.toLowerCase();
        if (subCommand === 'queue') {
            queue.loopQueue = !queue.loopQueue;
            queue.loopTrack = false;
            return message.reply(`Looping queue: **${queue.loopQueue ? 'ENABLED' : 'DISABLED'}**`);
        } else {
            queue.loopTrack = !queue.loopTrack;
            queue.loopQueue = false;
            return message.reply(`Looping track: **${queue.loopTrack ? 'ENABLED' : 'DISABLED'}**`);
        }
    }

    if (command === 'remove') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length <= 1) return message.reply('Tidak ada lagu dalam antrean untuk dihapus.');

        const index = parseInt(args[0]) - 1;
        if (isNaN(index) || index < 1 || index >= queue.songs.length) {
            return message.reply('Masukkan nomor antrean yang valid (mulai dari angka 2 ke atas).');
        }

        const removed = queue.songs.splice(index, 1);
        return message.reply(`Removed from queue: **${removed[0].title}**`);
    }

    if (command === 'shuffle') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length < 2) return message.reply('Jumlah antrean lagu kurang untuk diacak!');

        const currentSong = queue.songs.shift();
        queue.songs.sort(() => Math.random() - 0.5);
        queue.songs.unshift(currentSong);

        return message.reply('Queue shuffled.');
    }

    // ==========================================
    // OWNER MANAGEMENT
    // ==========================================
    if (command === 'grantowner') {
        if (!isSuperOwner) return message.reply('Hanya Super Owner yang bisa menambah Owner baru!');
        const targetId = args[0];
        if (!targetId) return message.reply('Sebutkan ID Discord target!');

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
});

client.login(TOKEN);
