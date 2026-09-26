const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

// Patch Friend Source Flags Null Error pada discord.js-selfbot-v13
const ClientUserSettingManager = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
const originalPatch = ClientUserSettingManager.prototype._patch;
ClientUserSettingManager.prototype._patch = function (data) {
    if (data && data.friend_source_flags === null) {
        data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
    }
    return originalPatch.call(this, data);
};

const app = express();
const client = new Client({ checkUpdate: false });

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error("ERROR: DISCORD_TOKEN tidak ditemukan di Environment Variables!");
    process.exit(1);
}

// Inisialisasi Lavalink Manager dengan Public Nodes Aktif
const lavalink = new LavalinkManager({
    nodes: [
        {
            id: 'node-jirayu',
            host: 'lavalink.jirayu.net',
            port: 443,
            authorization: 'youshallnotpass',
            secure: true,
            retryAmount: 10,
            retryDelay: 5000
        },
        {
            id: 'node-freelavalink',
            host: 'lavalink.v4.lavalink.is-a.dev',
            port: 443,
            authorization: 'youshallnotpass',
            secure: true,
            retryAmount: 10,
            retryDelay: 5000
        }
    ],
    sendToShard: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild) guild.shard.send(payload);
    },
    client: {
        id: '100000000000000000'
    }
});

lavalink.nodeManager.on('error', (node, error) => {
    console.warn(`[Lavalink Error] Node ${node.id || node.options.host}:`, error.message || error);
});

lavalink.nodeManager.on('connect', (node) => {
    console.log(`[Lavalink Connected] Berhasil terhubung ke Node: ${node.id || node.options.host}`);
});

lavalink.nodeManager.on('disconnect', (node, reason) => {
    console.warn(`[Lavalink Disconnected] Terputus dari Node ${node.id || node.options.host}. Alasan:`, reason);
});

let savedVoiceChannelId = "";
let currentVoiceChannel = null;

client.on('raw', (d) => {
    lavalink.sendRawData(d);
});

// Fungsi Menghubungkan & Berpindah Voice Channel secara Bersih
async function connectToChannel(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isVoice()) {
            return { success: false, message: 'Channel tidak ditemukan atau bukan Voice Channel!' };
        }

        // Jika sudah ada player di server ini, putuskan dan hapus player lama
        let player = lavalink.getPlayer(channel.guild.id);
        if (player) {
            try {
                await player.disconnect();
                await player.destroy();
            } catch (e) {
                console.log('Error membersihkan player lama:', e.message);
            }
        }

        // Buat player baru untuk channel tujuan
        player = await lavalink.createPlayer({
            guildId: channel.guild.id,
            voiceChannelId: channel.id,
            textChannelId: channel.id,
            selfDeaf: false,
            selfMute: false
        });

        await player.connect();
        currentVoiceChannel = channel;
        savedVoiceChannelId = channel.id;
        console.log(`Lavalink berpindah & terhubung ke VC: ${channel.name} (${channel.guild.name})`);
        return { success: true };
    } catch (err) {
        console.error('Gagal koneksi Voice:', err.message);
        return { success: false, message: err.message };
    }
}

// Fungsi Leave Voice Channel
async function leaveChannel() {
    if (!currentVoiceChannel) return;
    try {
        let player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        if (player) {
            await player.disconnect();
            await player.destroy();
        }
        console.log(`Bot keluar dari Voice Channel: ${currentVoiceChannel.name}`);
    } catch (err) {
        console.error('Gagal keluar dari Voice Channel:', err.message);
    } finally {
        currentVoiceChannel = null;
        savedVoiceChannelId = "";
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

function renderDashboard() {
    let player = currentVoiceChannel ? lavalink.getPlayer(currentVoiceChannel.guild.id) : null;
    let currentTrack = player && player.queue.current ? player.queue.current.info.title : 'Tidak ada';
    let queueList = player ? player.queue.tracks.map((song, i) => `<li>${i + 1}. ${song.info.title}</li>`).join('') : '';

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Voicecord Controller (Lavalink Engine)</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1015; color: #e1e1e6; padding: 20px; max-width: 480px; margin: auto; }
                .card { background: #181920; padding: 18px; border-radius: 12px; margin-bottom: 16px; border: 1px solid #282a36; }
                h2, h3 { margin-top: 0; color: #fff; }
                input, button { padding: 12px; margin: 6px 0; width: 100%; box-sizing: border-box; border-radius: 8px; border: none; font-size: 14px; }
                input { background: #222431; color: #fff; border: 1px solid #323546; }
                input:focus { border-color: #5865F2; outline: none; }
                button { background: #5865F2; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; }
                button:hover { opacity: 0.9; }
                button.alt { background: #2b2d3c; }
                button.danger { background: #ed4245; }
            </style>
        </head>
        <body>
            <h2>Voicecord Controller</h2>

            <div class="card">
                <h3>Voice Channel Target</h3>
                <p style="font-size: 13px; margin: 4px 0 12px 0; color: #a0a0b0;">
                    Status VC: <strong>${currentVoiceChannel ? `${currentVoiceChannel.name} (${currentVoiceChannel.guild.name})` : '<span style="color:#ed4245;">Belum Terhubung</span>'}</strong>
                </p>
                <form action="/api/connect" method="POST">
                    <input type="text" name="channelId" placeholder="Masukkan Voice Channel ID" value="${savedVoiceChannelId}" required />
                    <button type="submit" class="alt">Set / Pindah Voice Channel</button>
                </form>
                ${currentVoiceChannel ? `
                <form action="/api/leave" method="POST" style="margin-top: 4px;">
                    <button type="submit" class="danger">Leave Voice Channel</button>
                </form>
                ` : ''}
            </div>

            <div class="card">
                <h3>Music Player (Lavalink Engine)</h3>
                <p style="font-size: 13px; margin-bottom: 12px;">
                    <strong>Sedang Diputar:</strong><br>
                    <span style="color: #5865F2; font-weight: bold;">${currentTrack}</span>
                </p>

                <form action="/api/play" method="POST">
                    <input type="text" name="query" placeholder="Judul Lagu / Link YouTube / Spotify / SoundCloud" required />
                    <button type="submit">Play / Add Queue</button>
                </form>

                <div style="display: flex; gap: 8px; margin-top: 6px;">
                    <form action="/api/pause" method="POST" style="flex:1;"><button type="submit" class="alt">Pause</button></form>
                    <form action="/api/resume" method="POST" style="flex:1;"><button type="submit" class="alt">Resume</button></form>
                    <form action="/api/skip" method="POST" style="flex:1;"><button type="submit" class="alt">Skip</button></form>
                </div>
            </div>

            <div class="card">
                <h3>Antrean Lagu</h3>
                <ol style="padding-left: 20px; font-size: 14px; margin: 0;">${queueList || '<li>Antrean kosong</li>'}</ol>
            </div>
        </body>
        </html>
    `;
}

app.get('/', (req, res) => {
    res.send(renderDashboard());
});

app.post('/api/connect', async (req, res) => {
    const { channelId } = req.body;
    if (channelId) {
        await connectToChannel(channelId.trim());
    }
    res.redirect('/');
});

app.post('/api/leave', async (req, res) => {
    await leaveChannel();
    res.redirect('/');
});

app.post('/api/play', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.redirect('/');

    if (!currentVoiceChannel) {
        return res.send('<script>alert("Atur Voice Channel ID terlebih dahulu!"); window.location.href="/";</script>');
    }

    try {
        let player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        if (!player) {
            await connectToChannel(currentVoiceChannel.id);
            player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        }

        const resSearch = await player.search({ query: query.trim() }, client.user);
        if (resSearch && resSearch.tracks && resSearch.tracks.length > 0) {
            player.queue.add(resSearch.tracks[0]);
            if (!player.playing && !player.paused) {
                await player.play();
            }
            console.log(`Lavalink menambahkan lagu: ${resSearch.tracks[0].info.title}`);
        } else {
            console.log('Lagu tidak ditemukan via Lavalink.');
        }
    } catch (e) {
        console.error('Error Lavalink Play:', e.message);
    }
    res.redirect('/');
});

app.post('/api/pause', async (req, res) => {
    if (currentVoiceChannel) {
        const player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        if (player) await player.pause();
    }
    res.redirect('/');
});

app.post('/api/resume', async (req, res) => {
    if (currentVoiceChannel) {
        const player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        if (player) await player.resume();
    }
    res.redirect('/');
});

app.post('/api/skip', async (req, res) => {
    if (currentVoiceChannel) {
        const player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        if (player) await player.skip();
    }
    res.redirect('/');
});

app.get('*', (req, res) => {
    res.send(renderDashboard());
});

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    lavalink.options.client.id = client.user.id;
    await lavalink.init(client.user);
});

// Guardrail Anti-crash global
process.on('unhandledRejection', (reason) => {
    console.warn('Unhandled Rejection Ignored:', reason);
});
process.on('uncaughtException', (err) => {
    console.warn('Uncaught Exception Ignored:', err.message || err);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web Controller berjalan di port ${PORT}`);
});

client.login(TOKEN);
