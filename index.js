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
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    NoSubscriberBehavior
} = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const play = require('play-dl');

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

// Inisialisasi Audio Player
const audioPlayer = createAudioPlayer({
    behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
    }
});

let queue = [];
let isPlaying = false;
let currentTrack = null;
let savedVoiceChannelId = ""; // Menyimpan ID VC secara konsisten
let currentVoiceChannel = null;
let voiceConnection = null;

// Menghubungkan ke Voice Channel
async function connectToChannel(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isVoice()) {
            return { success: false, message: 'Channel tidak ditemukan atau bukan Voice Channel!' };
        }

        // Putuskan koneksi lama jika berpindah VC
        if (voiceConnection) {
            try { voiceConnection.destroy(); } catch (e) {}
        }

        voiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: false
        });

        voiceConnection.subscribe(audioPlayer);
        currentVoiceChannel = channel;
        savedVoiceChannelId = channel.id;
        console.log(`Bot terhubung ke VC: ${channel.name} (${channel.guild.name})`);

        voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5000),
                ]);
            } catch (error) {
                console.log("Bot terputus dari VC.");
                try { voiceConnection.destroy(); } catch (e) {}
                currentVoiceChannel = null;
                voiceConnection = null;
            }
        });

        return { success: true };
    } catch (err) {
        console.error('Gagal koneksi Voice:', err.message);
        return { success: false, message: err.message };
    }
}

// Stream Audio dengan Handling Error Anti-Crash
async function playNext() {
    if (queue.length === 0) {
        isPlaying = false;
        currentTrack = null;
        return;
    }

    currentTrack = queue.shift();
    isPlaying = true;

    try {
        let stream;

        // Mengutamakan stream yang aman dari blokir bot YouTube
        if (currentTrack.url.includes('soundcloud.com')) {
            stream = await play.stream(currentTrack.url);
        } else {
            stream = await play.stream(currentTrack.url, {
                discordPlayerCompatibility: true,
                seek: 0,
                quality: 2
            });
        }

        const resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: false
        });

        audioPlayer.play(resource);
        console.log(`Sedang memutar: ${currentTrack.title}`);
    } catch (error) {
        console.error('Error streaming lagu:', error.message);
        isPlaying = false;
        currentTrack = null;

        // Jika terbalik/terblokir, lanjut ke antrean lagu berikutnya
        if (queue.length > 0) {
            setTimeout(playNext, 1000);
        }
    }
}

audioPlayer.on(AudioPlayerStatus.Idle, () => {
    playNext();
});

audioPlayer.on('error', (err) => {
    console.error('Audio Player Error Event:', err.message);
    playNext();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Render UI Controller
function renderDashboard() {
    const queueList = queue.map((song, i) => `<li>${i + 1}. ${song.title}</li>`).join('');
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Voicecord Controller</title>
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
                    Status VC: <strong>${currentVoiceChannel ? `${currentVoiceChannel.name} (${currentVoiceChannel.guild.name})` : '<span style="color:#ed4245;">Belum Terhubung</span>'}</strong>
                </p>
                <form action="/api/connect" method="POST">
                    <input type="text" name="channelId" placeholder="Masukkan Voice Channel ID" value="${savedVoiceChannelId}" required />
                    <button type="submit" class="alt">Set / Pindah Voice Channel</button>
                </form>
            </div>

            <div class="card">
                <h3>Music Player</h3>
                <p style="font-size: 13px; margin-bottom: 12px;">
                    <strong>Sedang Diputar:</strong><br>
                    <span style="color: #5865F2; font-weight: bold;">${currentTrack ? currentTrack.title : 'Tidak ada'}</span><br>
                    <small style="color:#a0a0b0;">Status: ${audioPlayer.state.status}</small>
                </p>

                <form action="/api/play" method="POST">
                    <input type="text" name="query" placeholder="Judul Lagu / URL YouTube / SoundCloud" required />
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
        return res.send('<script>alert("Atur Voice Channel ID terlebih dahulu di bagian atas!"); window.location.href="/";</script>');
    }

    try {
        let songInfo = {};

        // 1. Jika input berupa URL
        if (query.startsWith('http://') || query.startsWith('https://')) {
            if (play.yt_validate(query) === 'video') {
                const info = await play.video_info(query);
                songInfo = { title: info.video_details.title, url: info.video_details.url };
            } else if (query.includes('soundcloud.com')) {
                const info = await play.soundcloud(query);
                songInfo = { title: info.name, url: info.url };
            }
        } else {
            // 2. Pencarian Judul: Coba SoundCloud dulu (Bebas Blokir Bot IP Cloud)
            try {
                const scResults = await play.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
                if (scResults && scResults.length > 0) {
                    songInfo = { title: scResults[0].name, url: scResults[0].url };
                }
            } catch (scErr) {
                console.log('Pencarian SoundCloud gagal, mencoba YouTube...');
            }

            // Fallback ke YouTube
            if (!songInfo.url) {
                const ytResults = await play.search(query, { limit: 1 });
                if (ytResults && ytResults.length > 0) {
                    songInfo = { title: ytResults[0].title, url: ytResults[0].url };
                }
            }
        }

        if (songInfo.url) {
            queue.push(songInfo);
            if (!isPlaying && audioPlayer.state.status !== AudioPlayerStatus.Paused) {
                playNext();
            }
        }
    } catch (e) {
        console.error('Error saat menambah lagu:', e.message);
    }
    res.redirect('/');
});

// Handling Pause Aman
app.post('/api/pause', (req, res) => {
    try {
        if (audioPlayer.state.status === AudioPlayerStatus.Playing) {
            audioPlayer.pause(true);
        }
    } catch (e) {
        console.error('Error Pause:', e.message);
    }
    res.redirect('/');
});

// Handling Resume Aman
app.post('/api/resume', (req, res) => {
    try {
        if (
            audioPlayer.state.status === AudioPlayerStatus.Paused || 
            audioPlayer.state.status === AudioPlayerStatus.AutoPaused
        ) {
            audioPlayer.unpause();
        }
    } catch (e) {
        console.error('Error Resume:', e.message);
    }
    res.redirect('/');
});

app.post('/api/skip', (req, res) => {
    try {
        audioPlayer.stop();
    } catch (e) {
        console.error('Error Skip:', e.message);
    }
    res.redirect('/');
});

app.get('*', (req, res) => {
    res.send(renderDashboard());
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Mencegah aplikasi crash total akibat unhandled error dari luar
process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection Ignored:', error.message || error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception Ignored:', error.message || error);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web Controller berjalan di port ${PORT}`);
});

client.login(TOKEN);
