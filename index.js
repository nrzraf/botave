js
const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

// Fix friend_source_flags null
const Settings = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
const originalPatch = Settings.prototype._patch;
Settings.prototype._patch = function (data) {
    if (data?.friend_source_flags === null)
        data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
    return originalPatch.call(this, data);
};

const app = express();
const client = new Client({ checkUpdate: false });
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error('ERROR: DISCORD_TOKEN tidak ditemukan!');
    process.exit(1);
}

// Lavalink
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
    client: { id: '100000000000000000' },
    autoSkip: true
});

lavalink.nodeManager.on('error', (node, error) => {
    console.warn(
        `[Lavalink Error] Node ${node.id || node.options.host}:`,
        error.message || error
    );
});

lavalink.nodeManager.on('connect', node => {
    console.log(
        `[Lavalink] Connected: ${node.id || node.options.host}`
    );
});

lavalink.nodeManager.on('disconnect', (node, reason) => {
    console.warn(
        `[Lavalink] Disconnected: ${node.id || node.options.host}`,
        reason
    );
});

// State
let currentVoiceChannel = null;
let savedVoiceChannelId = '';
let isAutoplayEnabled = false;
let repeatMode = 'off'; // off | track | queue
const autoplayHistory = new Set();
const MAX_HISTORY = 100;

// ============================================================
// AUTOPLAY
// ============================================================

function rememberTrack(track) {
    const id = track?.info?.identifier;
    if (!id) return;

    autoplayHistory.add(id);

    if (autoplayHistory.size > MAX_HISTORY) {
        const oldest = autoplayHistory.values().next().value;
        autoplayHistory.delete(oldest);
    }
}

async function getAutoplayTrack(player, previousTrack) {
    if (!player || !previousTrack) return null;

    const artist = previousTrack.info?.author?.trim();
    const previousId = previousTrack.info?.identifier;

    if (!artist) return null;

    const queries = [
        `ytsearch:${artist} top tracks`,
        `ytsearch:${artist} popular songs`,
        `ytsearch:${artist} best songs`,
        `ytsearch:${artist}`
    ];

    for (const query of queries) {
        try {
            console.log(`[Autoplay] Search: ${query}`);

            const result = await player.search({ query }, client.user);
            if (!result?.tracks?.length) continue;

            let candidates = result.tracks.filter(t =>
                t.info?.identifier &&
                t.info.identifier !== previousId &&
                !autoplayHistory.has(t.info.identifier)
            );

            if (!candidates.length) {
                candidates = result.tracks.filter(t =>
                    t.info?.identifier && t.info.identifier !== previousId
                );
            }

            if (!candidates.length) continue;

            const pool = candidates.slice(0, 5);
            const selected = pool[Math.floor(Math.random() * pool.length)];

            console.log(`[Autoplay] Selected: ${selected.info.title}`);
            return selected;
        } catch (err) {
            console.warn(`[Autoplay] Search failed: ${err.message}`);
        }
    }

    return null;
}

async function playAutoplay(player, previousTrack) {
    if (!isAutoplayEnabled || repeatMode !== 'off') return false;
    if (player.queue.tracks.length > 0) return false;

    const next = await getAutoplayTrack(player, previousTrack);
    if (!next) return false;

    rememberTrack(next);
    player.queue.add(next);
    await player.play();

    console.log(`[Autoplay] Playing: ${next.info.title}`);
    return true;
}

// ============================================================
// TRACK EVENTS
// ============================================================

lavalink.on('trackEnd', async (player, track) => {
    if (!track) return;

    console.log(`[Track End] ${track.info.title}`);

    if (repeatMode === 'track') {
        player.queue.add(track);
        return player.play();
    }

    if (repeatMode === 'queue') {
        player.queue.add(track);
        if (!player.playing && !player.paused) await player.play();
        return;
    }

    if (player.queue.tracks.length > 0) return;

    if (isAutoplayEnabled) {
        await playAutoplay(player, track);
    } else {
        console.log('[Track End] Queue kosong, autoplay OFF.');
    }
});

client.on('raw', data => lavalink.sendRawData(data));

// ============================================================
// VOICE
// ============================================================

async function connectToChannel(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);

        if (!channel?.isVoice()) {
            return { success: false, message: 'Bukan Voice Channel!' };
        }

        let player = lavalink.getPlayer(channel.guild.id);

        if (player) {
            try {
                await player.disconnect();
                await player.destroy();
            } catch (e) {
                console.warn('[Voice] Cleanup:', e.message);
            }
        }

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

        console.log(`[Voice] Connected: ${channel.name}`);
        return { success: true };
    } catch (err) {
        console.error('[Voice] Connect error:', err.message);
        return { success: false, message: err.message };
    }
}

async function leaveChannel() {
    if (!currentVoiceChannel) return;

    try {
        const player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        if (player) {
            await player.disconnect();
            await player.destroy();
        }
    } catch (err) {
        console.error('[Voice] Leave error:', err.message);
    }

    currentVoiceChannel = null;
    savedVoiceChannelId = '';
    autoplayHistory.clear();
}

// ============================================================
// DASHBOARD
// ============================================================

function renderDashboard() {
    const player = currentVoiceChannel
        ? lavalink.getPlayer(currentVoiceChannel.guild.id)
        : null;

    const current = player?.queue?.current?.info?.title || 'Tidak ada';

    const queue = player?.queue?.tracks?.length
        ? player.queue.tracks.map((song, i) => `
            <li class="queue-item">
                <span>${i + 1}. ${song.info.title}</span>
                <form action="/api/delete-queue-item" method="POST">
                    <input type="hidden" name="index" value="${i}">
                    <button class="danger small">X</button>
                </form>
            </li>
        `).join('')
        : '<li>Antrean kosong</li>';

    return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voicecord Controller</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#0f1015;color:#e1e1e6;padding:20px;max-width:480px;margin:auto}
.card{background:#181920;padding:18px;border-radius:12px;margin-bottom:16px;border:1px solid #282a36}
h2,h3{margin-top:0;color:#fff}
input,button{padding:11px;margin:5px 0;width:100%;border:0;border-radius:8px;font-size:14px}
input{background:#222431;color:#fff;border:1px solid #323546}
button{background:#5865f2;color:#fff;font-weight:bold;cursor:pointer}
button.alt{background:#2b2d3c}
button.danger{background:#ed4245}
button.active{background:#57f287;color:#000}
button.small{width:auto;padding:4px 9px;margin:0}
.controls{display:flex;gap:8px}
.controls form{flex:1}
.queue{padding:0;list-style:none}
.queue-item{display:flex;justify-content:space-between;align-items:center;margin:7px 0;gap:8px}
.queue-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.current{color:#5865f2;font-weight:bold}
.status{font-size:13px;color:#aaa}
</style>
</head>
<body>

<h2>Voicecord Controller</h2>

<div class="card">
<h3>Voice Channel</h3>
<p class="status">
Status:
<strong>
${currentVoiceChannel
    ? `${currentVoiceChannel.name} (${currentVoiceChannel.guild.name})`
    : '<span style="color:#ed4245">Belum Terhubung</span>'}
</strong>
</p>

<form action="/api/connect" method="POST">
<input name="channelId" placeholder="Voice Channel ID" value="${savedVoiceChannelId}" required>
<button class="alt">Set / Pindah Voice Channel</button>
</form>

${currentVoiceChannel ? `
<form action="/api/leave" method="POST">
<button class="danger">Leave Voice Channel</button>
</form>` : ''}
</div>

<div class="card">
<h3>Music Player</h3>
<p class="status">Sedang Diputar:</p>
<p class="current">${current}</p>

<form action="/api/play" method="POST">
<input name="query" placeholder="Judul / YouTube / Spotify / SoundCloud" required>
<button>Play / Add Queue</button>
</form>

<div class="controls">
<form action="/api/pause" method="POST"><button class="alt">Pause</button></form>
<form action="/api/resume" method="POST"><button class="alt">Resume</button></form>
<form action="/api/skip" method="POST"><button class="alt">Skip</button></form>
</div>

<div class="controls">
<form action="/api/loop-track" method="POST">
<button class="${repeatMode === 'track' ? 'active' : 'alt'}">
Loop Track: ${repeatMode === 'track' ? 'ON' : 'OFF'}
</button>
</form>

<form action="/api/loop-queue" method="POST">
<button class="${repeatMode === 'queue' ? 'active' : 'alt'}">
Loop Queue: ${repeatMode === 'queue' ? 'ON' : 'OFF'}
</button>
</form>
</div>

<form action="/api/toggle-autoplay" method="POST">
<button class="${isAutoplayEnabled ? 'active' : 'alt'}">
Autoplay: ${isAutoplayEnabled ? 'ON' : 'OFF'}
</button>
</form>
</div>

<div class="card">
<h3>Antrean Lagu</h3>
<ol class="queue">${queue}</ol>
</div>

</body>
</html>`;
}

// ============================================================
// API
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/favicon.ico', (_, res) => res.status(204).end());

app.get('/', (_, res) => res.send(renderDashboard()));

app.post('/api/connect', async (req, res) => {
    if (req.body.channelId) await connectToChannel(req.body.channelId.trim());
    res.redirect('/');
});

app.post('/api/leave', async (_, res) => {
    await leaveChannel();
    res.redirect('/');
});

app.post('/api/play', async (req, res) => {
    const query = req.body.query?.trim();

    if (!query) return res.redirect('/');

    if (!currentVoiceChannel) {
        return res.send(`
            <script>
                alert("Atur Voice Channel ID terlebih dahulu!");
                location.href="/";
            </script>
        `);
    }

    try {
        let player = lavalink.getPlayer(currentVoiceChannel.guild.id);

        if (!player) {
            await connectToChannel(currentVoiceChannel.id);
            player = lavalink.getPlayer(currentVoiceChannel.guild.id);
        }

        const result = await player.search({ query }, client.user);

        if (result?.tracks?.length) {
            const track = result.tracks[0];
            player.queue.add(track);

            console.log(`[Play] ${track.info.title}`);

            if (!player.playing && !player.paused)
                await player.play();
        }
    } catch (err) {
        console.error('[Play Error]:', err.message);
    }

    res.redirect('/');
});

app.post('/api/pause', async (_, res) => {
    const player = currentVoiceChannel &&
        lavalink.getPlayer(currentVoiceChannel.guild.id);

    if (player) await player.pause();
    res.redirect('/');
});

app.post('/api/resume', async (_, res) => {
    const player = currentVoiceChannel &&
        lavalink.getPlayer(currentVoiceChannel.guild.id);

    if (player) await player.resume();
    res.redirect('/');
});

app.post('/api/skip', async (_, res) => {
    const player = currentVoiceChannel &&
        lavalink.getPlayer(currentVoiceChannel.guild.id);

    if (!player) return res.redirect('/');

    try {
        const current = player.queue.current;

        if (!current) return res.redirect('/');

        // Queue punya lagu berikutnya
        if (player.queue.tracks.length > 0) {
            console.log('[Skip] Next queue track.');
            await player.skip();
            return res.redirect('/');
        }

        // Queue kosong + autoplay OFF
        if (!isAutoplayEnabled) {
            console.log('[Skip] Queue kosong + autoplay OFF.');
            await player.stop();
            return res.redirect('/');
        }

        // Queue kosong + autoplay ON
        console.log(`[Skip] Searching next after: ${current.info.title}`);

        const next = await getAutoplayTrack(player, current);

        if (!next) {
            console.log('[Skip] Recommendation tidak ditemukan.');
            await player.stop();
            return res.redirect('/');
        }

        rememberTrack(next);
        player.queue.add(next);

        console.log(`[Skip] Next: ${next.info.title}`);
        await player.skip();
    } catch (err) {
        console.error('[Skip Error]:', err.message);
    }

    res.redirect('/');
});

app.post('/api/loop-track', (req, res) => {
    repeatMode = repeatMode === 'track' ? 'off' : 'track';
    console.log(`[Repeat] ${repeatMode}`);
    res.redirect('/');
});

app.post('/api/loop-queue', (req, res) => {
    repeatMode = repeatMode === 'queue' ? 'off' : 'queue';
    console.log(`[Repeat] ${repeatMode}`);
    res.redirect('/');
});

app.post('/api/toggle-autoplay', (_, res) => {
    isAutoplayEnabled = !isAutoplayEnabled;
    console.log(`[Autoplay] ${isAutoplayEnabled ? 'ON' : 'OFF'}`);
    res.redirect('/');
});

app.post('/api/delete-queue-item', (req, res) => {
    const player = currentVoiceChannel &&
        lavalink.getPlayer(currentVoiceChannel.guild.id);

    const index = Number.parseInt(req.body.index);

    if (player && Number.isInteger(index) && player.queue.tracks[index]) {
        const removed = player.queue.tracks.splice(index, 1)[0];
        console.log(`[Queue] Removed: ${removed.info.title}`);
    }

    res.redirect('/');
});

app.get('*', (_, res) => res.send(renderDashboard()));

// ============================================================
// START
// ============================================================

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    lavalink.options.client.id = client.user.id;
    await lavalink.init(client.user);
});

process.on('unhandledRejection', reason =>
    console.warn('[Unhandled Rejection]', reason)
);

process.on('uncaughtException', err =>
    console.warn('[Uncaught Exception]', err.message || err)
);

app.listen(PORT, '0.0.0.0', () =>
    console.log(`Web Controller berjalan di port ${PORT}`)
);

client.login(TOKEN);
