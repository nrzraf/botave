const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

// Fix friend_source_flags null
const Settings = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
const originalPatch = Settings.prototype._patch;

Settings.prototype._patch = function (data) {
    if (data?.friend_source_flags === null) {
        data.friend_source_flags = {
            all: false,
            mutual_friends: false,
            mutual_guilds: false
        };
    }

    return originalPatch.call(this, data);
};

const app = express();
const client = new Client({ checkUpdate: false });

const TOKEN = process.env.DISCORD_TOKEN;

// Railway Web Server
const PORT = Number(process.env.PORT || 3000);

// ============================================================
// ENVIRONMENT
// ============================================================

if (!TOKEN) {
    console.error('ERROR: DISCORD_TOKEN tidak ditemukan!');
    process.exit(1);
}

const LAVALINK_HOST = process.env.LAVALINK_HOST;
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT || 2333);
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD;
const LAVALINK_SECURE =
    String(process.env.LAVALINK_SECURE || 'false').toLowerCase() === 'true';

const LAVALINK_ID = process.env.LAVALINK_ID || 'main';

if (!LAVALINK_HOST) {
    console.error('ERROR: LAVALINK_HOST tidak ditemukan!');
    console.error('Set LAVALINK_HOST ke hostname Lavalink Railway.');
    process.exit(1);
}

if (!LAVALINK_PASSWORD) {
    console.error('ERROR: LAVALINK_PASSWORD tidak ditemukan!');
    process.exit(1);
}

console.log('============================================================');
console.log('[Config] Web Port      : ' + PORT);
console.log('[Config] Lavalink Host : ' + LAVALINK_HOST);
console.log('[Config] Lavalink Port : ' + LAVALINK_PORT);
console.log('[Config] Lavalink ID   : ' + LAVALINK_ID);
console.log('[Config] Lavalink SSL  : ' + LAVALINK_SECURE);
console.log('============================================================');

// ============================================================
// LAVALINK
// ============================================================

const lavalink = new LavalinkManager({
    nodes: [
        {
            id: LAVALINK_ID,
            host: LAVALINK_HOST,
            port: LAVALINK_PORT,
            authorization: LAVALINK_PASSWORD,
            secure: LAVALINK_SECURE,
            retryAmount: 10,
            retryDelay: 5000
        }
    ],

    sendToShard: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);

        if (guild) {
            guild.shard.send(payload);
        }
    },

    client: {
        id: '100000000000000000'
    },

    autoSkip: true
});

// ============================================================
// LAVALINK EVENTS
// ============================================================

lavalink.nodeManager.on('error', (node, error) => {
    console.warn(
        `[Lavalink Error] Node ${node?.id || node?.options?.host || 'unknown'}:`,
        error?.message || error
    );
});

lavalink.nodeManager.on('connect', node => {
    console.log(
        `[Lavalink] Connected: ${node?.id || node?.options?.host || 'unknown'}`
    );
});

lavalink.nodeManager.on('disconnect', (node, reason) => {
    console.warn(
        `[Lavalink] Disconnected: ${node?.id || node?.options?.host || 'unknown'}`,
        reason || ''
    );
});

// ============================================================
// STATE
// ============================================================

let currentVoiceChannel = null;
let savedVoiceChannelId = '';
let isAutoplayEnabled = false;
let repeatMode = 'off';

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

        if (oldest) {
            autoplayHistory.delete(oldest);
        }
    }
}

async function getAutoplayTrack(player, previousTrack) {
    if (!player || !previousTrack) {
        return null;
    }

    const artist = previousTrack.info?.author?.trim();
    const previousId = previousTrack.info?.identifier;

    if (!artist) {
        return null;
    }

    const queries = [
        `ytsearch:${artist} top tracks`,
        `ytsearch:${artist} popular songs`,
        `ytsearch:${artist} best songs`,
        `ytsearch:${artist}`
    ];

    for (const query of queries) {
        try {
            console.log(`[Autoplay] Search: ${query}`);

            const result = await player.search(
                { query },
                client.user
            );

            if (!result?.tracks?.length) {
                continue;
            }

            let candidates = result.tracks.filter(track =>
                track.info?.identifier &&
                track.info.identifier !== previousId &&
                !autoplayHistory.has(track.info.identifier)
            );

            if (!candidates.length) {
                candidates = result.tracks.filter(track =>
                    track.info?.identifier &&
                    track.info.identifier !== previousId
                );
            }

            if (!candidates.length) {
                continue;
            }

            const pool = candidates.slice(0, 5);

            const selected =
                pool[Math.floor(Math.random() * pool.length)];

            console.log(
                `[Autoplay] Selected: ${selected.info.title}`
            );

            return selected;

        } catch (err) {
            console.warn(
                `[Autoplay] Search failed:`,
                err?.message || err
            );
        }
    }

    return null;
}

async function playAutoplay(player, previousTrack) {
    if (!isAutoplayEnabled) {
        return false;
    }

    if (repeatMode !== 'off') {
        return false;
    }

    if (!player) {
        return false;
    }

    if (player.queue.tracks.length > 0) {
        return false;
    }

    const next = await getAutoplayTrack(
        player,
        previousTrack
    );

    if (!next) {
        console.log(
            '[Autoplay] Tidak menemukan rekomendasi.'
        );

        return false;
    }

    rememberTrack(next);

    player.queue.add(next);

    await player.play();

    console.log(
        `[Autoplay] Playing: ${next.info.title}`
    );

    return true;
}

// ============================================================
// TRACK EVENTS
// ============================================================

lavalink.on('trackEnd', async (player, track) => {
    if (!track) {
        return;
    }

    console.log(
        `[Track End] ${track.info.title}`
    );

    // Loop current track
    if (repeatMode === 'track') {
        try {
            player.queue.add(track);

            await player.play();
        } catch (err) {
            console.error(
                '[Repeat Track Error]:',
                err?.message || err
            );
        }

        return;
    }

    // Loop queue
    if (repeatMode === 'queue') {
        try {
            player.queue.add(track);

            if (!player.playing && !player.paused) {
                await player.play();
            }
        } catch (err) {
            console.error(
                '[Repeat Queue Error]:',
                err?.message || err
            );
        }

        return;
    }

    // Queue masih punya lagu
    if (player.queue.tracks.length > 0) {
        return;
    }

    // Autoplay
    if (isAutoplayEnabled) {
        await playAutoplay(
            player,
            track
        );
    } else {
        console.log(
            '[Track End] Queue kosong, autoplay OFF.'
        );
    }
});

// Forward Discord voice events ke Lavalink
client.on('raw', data => {
    lavalink.sendRawData(data);
});

// ============================================================
// VOICE
// ============================================================

async function connectToChannel(channelId) {
    try {
        const channel =
            await client.channels.fetch(channelId);

        if (!channel?.isVoice()) {
            return {
                success: false,
                message: 'Bukan Voice Channel!'
            };
        }

        let player =
            lavalink.getPlayer(channel.guild.id);

        if (player) {
            try {
                await player.disconnect();
            } catch (_) {}

            try {
                await player.destroy();
            } catch (_) {}
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

        console.log(
            `[Voice] Connected: ${channel.name}`
        );

        return {
            success: true
        };

    } catch (err) {
        console.error(
            '[Voice] Connect error:',
            err?.message || err
        );

        return {
            success: false,
            message: err?.message || 'Unknown error'
        };
    }
}

async function leaveChannel() {
    if (!currentVoiceChannel) {
        return;
    }

    try {
        const player =
            lavalink.getPlayer(
                currentVoiceChannel.guild.id
            );

        if (player) {
            try {
                await player.disconnect();
            } catch (_) {}

            try {
                await player.destroy();
            } catch (_) {}
        }

    } catch (err) {
        console.error(
            '[Voice] Leave error:',
            err?.message || err
        );
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
        ? lavalink.getPlayer(
            currentVoiceChannel.guild.id
        )
        : null;

    const current =
        player?.queue?.current?.info?.title ||
        'Tidak ada';

    const queue =
        player?.queue?.tracks?.length
            ? player.queue.tracks.map((song, i) => `
                <li class="queue-item">
                    <span>
                        ${i + 1}. ${song.info.title}
                    </span>

                    <form
                        action="/api/delete-queue-item"
                        method="POST"
                    >
                        <input
                            type="hidden"
                            name="index"
                            value="${i}"
                        >

                        <button class="danger small">
                            X
                        </button>
                    </form>
                </li>
            `).join('')

            : '<li>Antrean kosong</li>';

    return `<!DOCTYPE html>
<html>

<head>
<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>Voicecord Controller</title>

<style>

*{
    box-sizing:border-box
}

body{
    font-family:Arial,sans-serif;
    background:#0f1015;
    color:#e1e1e6;
    padding:20px;
    max-width:480px;
    margin:auto
}

.card{
    background:#181920;
    padding:18px;
    border-radius:12px;
    margin-bottom:16px;
    border:1px solid #282a36
}

h2,h3{
    margin-top:0;
    color:#fff
}

input,button{
    padding:11px;
    margin:5px 0;
    width:100%;
    border:0;
    border-radius:8px;
    font-size:14px
}

input{
    background:#222431;
    color:#fff;
    border:1px solid #323546
}

button{
    background:#5865f2;
    color:#fff;
    font-weight:bold;
    cursor:pointer
}

button.alt{
    background:#2b2d3c
}

button.danger{
    background:#ed4245
}

button.active{
    background:#57f287;
    color:#000
}

button.small{
    width:auto;
    padding:4px 9px;
    margin:0
}

.controls{
    display:flex;
    gap:8px
}

.controls form{
    flex:1
}

.queue{
    padding:0;
    list-style:none
}

.queue-item{
    display:flex;
    justify-content:space-between;
    align-items:center;
    margin:7px 0;
    gap:8px
}

.queue-item span{
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap
}

.current{
    color:#5865f2;
    font-weight:bold
}

.status{
    font-size:13px;
    color:#aaa
}

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
    : '<span style="color:#ed4245">Belum Terhubung</span>'
}

</strong>

</p>

<form
    action="/api/connect"
    method="POST"
>

<input
    name="channelId"
    placeholder="Voice Channel ID"
    value="${savedVoiceChannelId}"
    required
>

<button class="alt">
    Set / Pindah Voice Channel
</button>

</form>

${
    currentVoiceChannel
        ? `
<form
    action="/api/leave"
    method="POST"
>

<button class="danger">
    Leave Voice Channel
</button>

</form>
`
        : ''
}

</div>

<div class="card">

<h3>Music Player</h3>

<p class="status">
    Sedang Diputar:
</p>

<p class="current">
    ${current}
</p>

<form
    action="/api/play"
    method="POST"
>

<input
    name="query"
    placeholder="Judul / YouTube / Spotify / SoundCloud"
    required
>

<button>
    Play / Add Queue
</button>

</form>

<div class="controls">

<form
    action="/api/pause"
    method="POST"
>

<button class="alt">
    Pause
</button>

</form>

<form
    action="/api/resume"
    method="POST"
>

<button class="alt">
    Resume
</button>

</form>

<form
    action="/api/skip"
    method="POST"
>

<button class="alt">
    Skip
</button>

</form>

</div>

<div class="controls">

<form
    action="/api/loop-track"
    method="POST"
>

<button
    class="${repeatMode === 'track'
        ? 'active'
        : 'alt'}"
>

Loop Track:
${repeatMode === 'track'
    ? 'ON'
    : 'OFF'}

</button>

</form>

<form
    action="/api/loop-queue"
    method="POST"
>

<button
    class="${repeatMode === 'queue'
        ? 'active'
        : 'alt'}"
>

Loop Queue:
${repeatMode === 'queue'
    ? 'ON'
    : 'OFF'}

</button>

</form>

</div>

<form
    action="/api/toggle-autoplay"
    method="POST"
>

<button
    class="${isAutoplayEnabled
        ? 'active'
        : 'alt'}"
>

Autoplay:
${isAutoplayEnabled
    ? 'ON'
    : 'OFF'}

</button>

</form>

</div>

<div class="card">

<h3>Antrean Lagu</h3>

<ol class="queue">

${queue}

</ol>

</div>

</body>

</html>`;
}

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);

app.get(
    '/favicon.ico',
    (_, res) => res.status(204).end()
);

app.get(
    '/',
    (_, res) => res.send(renderDashboard())
);

// ============================================================
// CONNECT
// ============================================================

app.post(
    '/api/connect',
    async (req, res) => {

        if (req.body.channelId) {
            await connectToChannel(
                req.body.channelId.trim()
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// LEAVE
// ============================================================

app.post(
    '/api/leave',
    async (_, res) => {

        await leaveChannel();

        res.redirect('/');
    }
);

// ============================================================
// PLAY
// ============================================================

app.post(
    '/api/play',
    async (req, res) => {

        const query =
            req.body.query?.trim();

        if (!query) {
            return res.redirect('/');
        }

        if (!currentVoiceChannel) {
            return res.send(`
                <script>
                    alert(
                        "Atur Voice Channel ID terlebih dahulu!"
                    );
                    location.href="/";
                </script>
            `);
        }

        try {

            let player =
                lavalink.getPlayer(
                    currentVoiceChannel.guild.id
                );

            if (!player) {

                await connectToChannel(
                    currentVoiceChannel.id
                );

                player =
                    lavalink.getPlayer(
                        currentVoiceChannel.guild.id
                    );
            }

            if (!player) {
                return res.redirect('/');
            }

            const result =
                await player.search(
                    { query },
                    client.user
                );

            if (result?.tracks?.length) {

                const track =
                    result.tracks[0];

                player.queue.add(track);

                console.log(
                    `[Play] ${track.info.title}`
                );

                if (
                    !player.playing &&
                    !player.paused
                ) {
                    await player.play();
                }
            }

        } catch (err) {

            console.error(
                '[Play Error]:',
                err?.message || err
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// PAUSE
// ============================================================

app.post(
    '/api/pause',
    async (_, res) => {

        const player =
            currentVoiceChannel &&
            lavalink.getPlayer(
                currentVoiceChannel.guild.id
            );

        if (player) {
            await player.pause();
        }

        res.redirect('/');
    }
);

// ============================================================
// RESUME
// ============================================================

app.post(
    '/api/resume',
    async (_, res) => {

        const player =
            currentVoiceChannel &&
            lavalink.getPlayer(
                currentVoiceChannel.guild.id
            );

        if (player) {
            await player.resume();
        }

        res.redirect('/');
    }
);

// ============================================================
// SKIP
// ============================================================

app.post(
    '/api/skip',
    async (_, res) => {

        const player =
            currentVoiceChannel &&
            lavalink.getPlayer(
                currentVoiceChannel.guild.id
            );

        if (!player) {
            return res.redirect('/');
        }

        try {

            const current =
                player.queue.current;

            if (!current) {
                return res.redirect('/');
            }

            // Queue masih punya lagu berikutnya
            if (player.queue.tracks.length > 0) {

                console.log(
                    '[Skip] Next queue track.'
                );

                await player.skip();

                return res.redirect('/');
            }

            // Queue kosong + autoplay OFF
            if (!isAutoplayEnabled) {

                console.log(
                    '[Skip] Queue kosong + autoplay OFF.'
                );

                await player.stop();

                return res.redirect('/');
            }

            // Queue kosong + autoplay ON
            console.log(
                `[Skip] Searching next after: ${current.info.title}`
            );

            const next =
                await getAutoplayTrack(
                    player,
                    current
                );

            if (!next) {

                console.log(
                    '[Skip] Recommendation tidak ditemukan.'
                );

                await player.stop();

                return res.redirect('/');
            }

            rememberTrack(next);

            player.queue.add(next);

            console.log(
                `[Skip] Next: ${next.info.title}`
            );

            await player.skip();

        } catch (err) {

            console.error(
                '[Skip Error]:',
                err?.message || err
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// LOOP TRACK
// ============================================================

app.post(
    '/api/loop-track',
    (req, res) => {

        repeatMode =
            repeatMode === 'track'
                ? 'off'
                : 'track';

        console.log(
            `[Repeat] ${repeatMode}`
        );

        res.redirect('/');
    }
);

// ============================================================
// LOOP QUEUE
// ============================================================

app.post(
    '/api/loop-queue',
    (req, res) => {

        repeatMode =
            repeatMode === 'queue'
                ? 'off'
                : 'queue';

        console.log(
            `[Repeat] ${repeatMode}`
        );

        res.redirect('/');
    }
);

// ============================================================
// AUTOPLAY TOGGLE
// ============================================================

app.post(
    '/api/toggle-autoplay',
    (_, res) => {

        isAutoplayEnabled =
            !isAutoplayEnabled;

        console.log(
            `[Autoplay] ${
                isAutoplayEnabled
                    ? 'ON'
                    : 'OFF'
            }`
        );

        res.redirect('/');
    }
);

// ============================================================
// DELETE QUEUE ITEM
// ============================================================

app.post(
    '/api/delete-queue-item',
    (req, res) => {

        const player =
            currentVoiceChannel &&
            lavalink.getPlayer(
                currentVoiceChannel.guild.id
            );

        const index =
            Number.parseInt(
                req.body.index
            );

        if (
            player &&
            Number.isInteger(index) &&
            player.queue.tracks[index]
        ) {

            const removed =
                player.queue.tracks.splice(
                    index,
                    1
                )[0];

            console.log(
                `[Queue] Removed: ${removed.info.title}`
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// FALLBACK
// ============================================================

app.get(
    '*',
    (_, res) =>
        res.send(renderDashboard())
);

// ============================================================
// START
// ============================================================

client.on(
    'ready',
    async () => {

        console.log(
            `Logged in as ${client.user.tag}`
        );

        // Gunakan Discord user ID asli
        lavalink.options.client.id =
            client.user.id;

        try {

            await lavalink.init(
                client.user
            );

            console.log(
                '[Lavalink] Manager initialized.'
            );

        } catch (err) {

            console.error(
                '[Lavalink] Init error:',
                err?.message || err
            );
        }
    }
);

// ============================================================
// ERROR HANDLING
// ============================================================

process.on(
    'unhandledRejection',
    reason =>
        console.warn(
            '[Unhandled Rejection]',
            reason
        )
);

process.on(
    'uncaughtException',
    err =>
        console.warn(
            '[Uncaught Exception]',
            err?.message || err
        )
);

// ============================================================
// WEB SERVER
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () =>
        console.log(
            `Web Controller berjalan di port ${PORT}`
        )
);

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
