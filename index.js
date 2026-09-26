// Polyfill Web APIs
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

// Patch Friend Source Flags Null Error
const ClientUserSettingManager = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
const originalPatch = ClientUserSettingManager.prototype._patch;
ClientUserSettingManager.prototype._patch = function (data) {
    if (data && data.friend_source_flags === null) {
        data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
    }
    return originalPatch.call(this, data);
};

const express = require('express');
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

const app = express();
const client = new Client();

const TOKEN = process.env.DISCORD_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // ID VC default
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let audioPlayer = createAudioPlayer();
let queue = [];
let isPlaying = false;
let currentTrack = null;

// Mengubungkan Bot ke VC
async function initVoice() {
    try {
        const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
        if (!channel) return console.error('Voice channel tidak ditemukan.');

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: false
        });

        connection.subscribe(audioPlayer);
        console.log(`Bot berhasil terhubung ke VC: ${channel.name}`);
    } catch (err) {
        console.error('Gagal koneksi Voice:', err);
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

// ==========================================
// ENDPOINT DASHBOARD WEB (INTERFACE)
// ==========================================

app.get('/', (req, res) => {
    const queueList = queue.map((song, i) => `<li>${i + 1}. ${song.title}</li>`).join('');
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Ave Web Controller</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; background: #121212; color: #fff; padding: 20px; max-width: 500px; margin: auto; }
                input, button { padding: 12px; margin: 5px 0; width: 100%; box-sizing: border-box; border-radius: 6px; border: none; }
                input { background: #222; color: #fff; border: 1px solid #444; }
                button { background: #5865F2; color: #fff; font-weight: bold; cursor: pointer; }
                button.alt { background: #444; }
                .status { background: #1e1e1e; padding: 15px; border-radius: 8px; margin-bottom: 15px; }
            </style>
        </head>
        <body>
            <h2>Ave Music Controller</h2>
            <div class="status">
                <strong>Sedang Diputar:</strong> <br>${currentTrack ? currentTrack.title : 'Tidak ada'}<br><br>
                <strong>Status:</strong> ${isPlaying ? 'Playing' : 'Paused/Stopped'}
            </div>

            <form action="/api/play" method="POST">
                <input type="text" name="query" placeholder="Masukkan Judul Lagu / URL YouTube" required />
                <button type="submit">Play / Add Queue</button>
            </form>

            <div style="display: flex; gap: 10px;">
                <form action="/api/pause" method="POST" style="flex:1;"><button type="submit" class="alt">Pause</button></form>
                <form action="/api/resume" method="POST" style="flex:1;"><button type="submit" class="alt">Resume</button></form>
                <form action="/api/skip" method="POST" style="flex:1;"><button type="submit" class="alt">Skip</button></form>
            </div>

            <h3>Antrean Lagu</h3>
            <ul>${queueList || '<li>Antrean kosong</li>'}</ul>
        </body>
        </html>
    `);
});

// REST APIs
app.post('/api/play', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.redirect('/');

    try {
        let songInfo = {};
        if (ytdl.validateURL(query)) {
            const info = await ytdl.getBasicInfo(query);
            songInfo = { title: info.videoDetails.title, url: info.videoDetails.video_url };
        } else {
            const searchResults = await play.search(query, { limit: 1 });
            if (searchResults.length > 0) {
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

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    initVoice();
});

app.listen(PORT, () => {
    console.log(`Web Controller berjalan di port ${PORT}`);
});

client.login(TOKEN);
