// Polyfill Web APIs untuk undici / play-dl
const { Blob, File } = require('buffer');
const { fetch, Headers, Request, Response, FormData } = require('undici');

if (!globalThis.File) globalThis.File = File;
if (!globalThis.Blob) globalThis.Blob = Blob;
if (!globalThis.FormData) globalThis.FormData = FormData;
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
}

const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus 
} = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const play = require('play-dl');

// Patch Friend Source Flags Null Error
const ClientUserSettingManager = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
const originalPatch = ClientUserSettingManager.prototype._patch;
ClientUserSettingManager.prototype._patch = function (data) {
    if (data && data.friend_source_flags === null) {
        data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
    }
    return originalPatch.call(this, data);
};

const app = express();
// Menonaktifkan warning update versi di terminal
const client = new Client({ checkUpdate: false });

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error("ERROR: DISCORD_TOKEN tidak ditemukan di Environment Variables!");
    process.exit(1);
}

let audioPlayer = createAudioPlayer();
let queue = [];
let isPlaying = false;
let currentTrack = null;
let currentVoiceChannel = null;

async function connectToChannel(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isVoice()) {
            return { success: false, message: 'ID Channel tidak ditemukan atau bukan Voice Channel!' };
        }

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: false
        });

        connection.subscribe(audioPlayer);
        currentVoiceChannel = channel;
        console.log(`Bot terhubung ke VC: ${channel.name} (${channel.guild.name})`);
        return { success: true, name: channel.name, guild: channel.guild.name };
    } catch (err) {
        console.error('Gagal koneksi Voice:', err);
        return { success: false, message: err.message };
    }
}

async function playNext() {
    if (queue.length === 0) {
        isPlaying = false;
        currentTrack = null;
        return;
    }

    currentTrack = queue.shift();
    isPlaying = true;

    try {
        const stream = await ytdl(currentTrack.url, {
            filter: 'audioonly',
            highWaterMark: 1 << 25,
            quality: 'highestaudio'
        });

        const resource = createAudioResource(stream);
        audioPlayer.play(resource);
    } catch (error) {
        console.error('Error stream:', error);
        playNext();
    }
}

audioPlayer.on(AudioPlayerStatus.Idle, () => {
    playNext();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// RENDER HTML CONTROLLER
// ==========================================
function renderDashboard() {
    const queueList = queue.map((song, i) => `<li>${i + 1}. ${song.title}</li>`).join('');
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Voicecord Web Controller</title>
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
            </style>
        </head>
        <body>
            <h2>Voicecord Controller</h2>

            <div class="card">
                <h3>Voice Channel Target</h3>
                <p style="font-size: 13px; margin: 4px 0 12px 0; color: #a0a0b0;">
                    Status VC: <strong>${currentVoiceChannel ? `${currentVoiceChannel.name} (${currentVoiceChannel.guild.name})` : 'Belum Terhubung'}</strong>
                </p>
                <form action="/api/connect" method="POST">
                    <input type="text" name="channelId" placeholder="Masukkan Voice Channel ID" value="${currentVoiceChannel ? currentVoiceChannel.id : ''}" required />
                    <button type="submit" class="alt">Set / Pindah Voice Channel</button>
                </form>
            </div>

            <div class="card">
                <h3>Music Player</h3>
                <p style="font-size: 13px; margin-bottom: 12px;">
                    <strong>Sedang Diputar:</strong><br>
                    <span style="color: #5865F2; font-weight: bold;">${currentTrack ? currentTrack.title : 'Tidak ada'}</span>
                </p>

                <form action="/api/play" method="POST">
                    <input type="text" name="query" placeholder="Judul Lagu / URL YouTube" required />
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

app.post('/api/play', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.redirect('/');

    if (!currentVoiceChannel) {
        return res.send('<script>alert("Atur Voice Channel ID terlebih dahulu!"); window.location.href="/";</script>');
    }

    try {
        let songInfo = {};
        if (ytdl.validateURL(query)) {
            const info = await ytdl.getBasicInfo(query);
            songInfo = { title: info.videoDetails.title, url: info.videoDetails.video_url };
        } else {
            const searchResults = await play.search(query, { limit: 1 });
            if (searchResults && searchResults.length > 0) {
                songInfo = { title: searchResults[0].title, url: searchResults[0].url };
            }
        }

        if (songInfo.url) {
            queue.push(songInfo);
            if (!isPlaying) {
                playNext();
            }
        }
    } catch (e) {
        console.error(e);
    }
    res.redirect('/');
});

app.post('/api/pause', (req, res) => {
    audioPlayer.pause();
    res.redirect('/');
});

app.post('/api/resume', (req, res) => {
    audioPlayer.unpause();
    res.redirect('/');
});

app.post('/api/skip', (req, res) => {
    audioPlayer.stop();
    res.redirect('/');
});

// Wildcard Route agar semua path mengarahkan ke Dashboard (Mencegah Railway 404)
app.get('*', (req, res) => {
    res.send(renderDashboard());
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web Controller berjalan di port ${PORT}`);
});

client.login(TOKEN);
