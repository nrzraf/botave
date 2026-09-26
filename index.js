const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

const Settings = require(
    'discord.js-selfbot-v13/src/managers/ClientUserSettingManager'
);

/* =========================================================
   PATCH discord.js-selfbot-v13
========================================================= */

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

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);

/* =========================================================
   ENVIRONMENT
========================================================= */

const TOKEN = process.env.DISCORD_TOKEN;

const PORT =
    Number(process.env.PORT || 3000);

/*
 * Railway:
 *
 * Botave:
 * LAVALINK_HOST=${{lavalink.RAILWAY_PRIVATE_DOMAIN}}
 *
 * Lavalink:
 * SERVER_PORT=2333
 */

const LAVALINK_HOST =
    process.env.LAVALINK_HOST;

const LAVALINK_PORT =
    Number(
        process.env.LAVALINK_PORT || 2333
    );

const LAVALINK_PASSWORD =
    process.env.LAVALINK_PASSWORD;

const LAVALINK_SECURE =
    String(
        process.env.LAVALINK_SECURE || 'false'
    ).toLowerCase() === 'true';

const LAVALINK_ID =
    process.env.LAVALINK_ID || 'main';

const LAVALINK_RETRY_AMOUNT =
    Number(
        process.env.LAVALINK_RETRY_AMOUNT || 10
    );

const LAVALINK_RETRY_DELAY =
    Number(
        process.env.LAVALINK_RETRY_DELAY || 5000
    );

/* =========================================================
   TOKEN CHECK
========================================================= */

if (!TOKEN) {
    console.error(
        '======================================'
    );

    console.error(
        'ERROR: DISCORD_TOKEN tidak ditemukan!'
    );

    console.error(
        '======================================'
    );

    process.exit(1);
}

/*
 * Jangan fallback ke localhost.
 *
 * Kalau host tidak ada, lebih baik aplikasi
 * memberitahu kesalahan konfigurasi secara jelas.
 */

if (!LAVALINK_HOST) {
    console.error(
        '======================================'
    );

    console.error(
        'ERROR: LAVALINK_HOST tidak ditemukan!'
    );

    console.error(
        'Set:',
        '${{lavalink.RAILWAY_PRIVATE_DOMAIN}}'
    );

    console.error(
        '======================================'
    );

    process.exit(1);
}

if (!LAVALINK_PASSWORD) {
    console.error(
        '======================================'
    );

    console.error(
        'ERROR: LAVALINK_PASSWORD tidak ditemukan!'
    );

    console.error(
        '======================================'
    );

    process.exit(1);
}

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
    checkUpdate: false
});

/* =========================================================
   LAVALINK CONFIG
========================================================= */

console.log(
    '======================================'
);

console.log(
    '[Lavalink] Configuration'
);

console.log(
    '======================================'
);

console.log(
    'Host       :',
    LAVALINK_HOST
);

console.log(
    'Port       :',
    LAVALINK_PORT
);

console.log(
    'Secure     :',
    LAVALINK_SECURE
);

console.log(
    'Node ID    :',
    LAVALINK_ID
);

console.log(
    'Retry      :',
    LAVALINK_RETRY_AMOUNT
);

console.log(
    'Retry Delay:',
    LAVALINK_RETRY_DELAY
);

console.log(
    '======================================'
);

/* =========================================================
   LAVALINK
========================================================= */

const lavalink = new LavalinkManager({

    nodes: [
        {
            id: LAVALINK_ID,

            host: LAVALINK_HOST,

            port: LAVALINK_PORT,

            authorization:
                LAVALINK_PASSWORD,

            /*
             * false = ws://
             * true  = wss://
             */

            secure:
                LAVALINK_SECURE,

            retryAmount:
                LAVALINK_RETRY_AMOUNT,

            retryDelay:
                LAVALINK_RETRY_DELAY,

            requestSignalTimeoutMS:
                10000,

            closeOnError:
                false,

            heartBeatInterval:
                30000,

            enablePingOnStatsCheck:
                true
        }
    ],

    sendToShard: (
        guildId,
        payload
    ) => {

        try {

            const guild =
                client.guilds.cache.get(
                    guildId
                );

            if (guild?.shard) {
                guild.shard.send(
                    payload
                );
            }

        } catch (error) {

            console.warn(
                '[Lavalink] sendToShard error:',
                error?.message || error
            );
        }
    },

    client: {
        id:
            '100000000000000000',

        username:
            'Botave'
    },

    autoSkip: true,

    autoMove: false
});

/* =========================================================
   LAVALINK EVENTS
========================================================= */

lavalink.nodeManager.on(
    'connect',
    node => {

        console.log(
            '[Lavalink] Connected:',
            node?.id ||
            node?.options?.host ||
            'unknown'
        );
    }
);

lavalink.nodeManager.on(
    'disconnect',
    (node, reason) => {

        console.warn(
            '[Lavalink] Disconnected:',
            node?.id ||
            node?.options?.host ||
            'unknown'
        );

        console.warn(
            '[Lavalink] Reason:',
            reason || 'unknown'
        );
    }
);

lavalink.nodeManager.on(
    'error',
    (node, error) => {

        console.warn(
            '[Lavalink Error] Node:',
            node?.id ||
            node?.options?.host ||
            'unknown'
        );

        console.warn(
            '[Lavalink Error]',
            error?.message || error
        );
    }
);

/* =========================================================
   STATE
========================================================= */

let currentVoiceChannel = null;

let savedVoiceChannelId = '';

let isAutoplayEnabled = false;

let repeatMode = 'off';

let volume = 100;

let autoplayActionInProgress = false;

let manualSkipInProgress = false;

const autoplayHistory =
    new Set();

const MAX_HISTORY = 100;

/* =========================================================
   HELPERS
========================================================= */

function getCurrentPlayer() {

    if (!currentVoiceChannel) {
        return null;
    }

    try {

        return lavalink.getPlayer(
            currentVoiceChannel.guild.id
        );

    } catch {

        return null;
    }
}

function getPlayerVolume(player) {

    if (!player) {
        return volume;
    }

    const currentVolume =
        Number(player.volume);

    if (
        Number.isFinite(currentVolume) &&
        currentVolume >= 0
    ) {

        return Math.min(
            100,
            currentVolume
        );
    }

    return volume;
}

function getTrackTitle(track) {

    return (
        track?.info?.title ||
        'Tidak ada'
    );
}

function getTrackId(track) {

    return (
        track?.info?.identifier ||
        null
    );
}

function escapeHtml(value) {

    return String(value ?? '')
        .replaceAll(
            '&',
            '&amp;'
        )
        .replaceAll(
            '<',
            '&lt;'
        )
        .replaceAll(
            '>',
            '&gt;'
        )
        .replaceAll(
            '"',
            '&quot;'
        )
        .replaceAll(
            "'",
            '&#039;'
        );
}

function rememberTrack(track) {

    const id =
        getTrackId(track);

    if (!id) {
        return;
    }

    autoplayHistory.add(id);

    if (
        autoplayHistory.size >
        MAX_HISTORY
    ) {

        const oldest =
            autoplayHistory
                .values()
                .next()
                .value;

        if (oldest) {
            autoplayHistory.delete(
                oldest
            );
        }
    }
}

/* =========================================================
   AUTOPLAY SEARCH
========================================================= */

async function getAutoplayTrack(
    player,
    previousTrack
) {

    if (
        !player ||
        !previousTrack
    ) {
        return null;
    }

    const artist =
        previousTrack.info?.author?.trim();

    const previousId =
        previousTrack.info?.identifier;

    if (!artist) {

        console.log(
            '[Autoplay] Artist tidak tersedia.'
        );

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

            console.log(
                '[Autoplay] Search:',
                query
            );

            const result =
                await player.search(
                    { query },
                    client.user
                );

            if (
                !result?.tracks?.length
            ) {
                continue;
            }

            let candidates =
                result.tracks.filter(
                    track => {

                        const id =
                            track?.info?.identifier;

                        return (
                            id &&
                            id !== previousId &&
                            !autoplayHistory.has(
                                id
                            )
                        );
                    }
                );

            if (!candidates.length) {

                candidates =
                    result.tracks.filter(
                        track => {

                            const id =
                                track?.info?.identifier;

                            return (
                                id &&
                                id !== previousId
                            );
                        }
                    );
            }

            if (!candidates.length) {
                continue;
            }

            const pool =
                candidates.slice(0, 5);

            const selected =
                pool[
                    Math.floor(
                        Math.random() *
                        pool.length
                    )
                ];

            console.log(
                '[Autoplay] Selected:',
                getTrackTitle(selected)
            );

            return selected;

        } catch (error) {

            console.warn(
                '[Autoplay] Search failed:',
                error?.message || error
            );
        }
    }

    return null;
}

/* =========================================================
   AUTOPLAY PLAY
========================================================= */

async function playAutoplay(
    player,
    previousTrack
) {

    if (
        !isAutoplayEnabled ||
        repeatMode !== 'off' ||
        !player ||
        autoplayActionInProgress
    ) {

        return false;
    }

    autoplayActionInProgress = true;

    try {

        if (
            player.queue.tracks.length >
            0
        ) {

            return false;
        }

        const next =
            await getAutoplayTrack(
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
            '[Autoplay] Playing:',
            getTrackTitle(next)
        );

        return true;

    } catch (error) {

        console.error(
            '[Autoplay Error]:',
            error?.message || error
        );

        return false;

    } finally {

        autoplayActionInProgress = false;
    }
}

/* =========================================================
   TRACK END
========================================================= */

lavalink.on(
    'trackEnd',
    async (
        player,
        track
    ) => {

        if (!track) {
            return;
        }

        console.log(
            '[Track End]',
            getTrackTitle(track)
        );

        /*
         * REPEAT TRACK
         */

        if (
            repeatMode === 'track'
        ) {

            try {

                await player.play({
                    track
                });

            } catch (error) {

                console.error(
                    '[Repeat Track Error]:',
                    error?.message || error
                );
            }

            return;
        }

        /*
         * REPEAT QUEUE
         */

        if (
            repeatMode === 'queue'
        ) {

            try {

                player.queue.add(
                    track
                );

                if (
                    !player.playing &&
                    !player.paused
                ) {

                    await player.play();
                }

            } catch (error) {

                console.error(
                    '[Repeat Queue Error]:',
                    error?.message || error
                );
            }

            return;
        }

        /*
         * Kalau masih ada queue,
         * jangan autoplay.
         */

        if (
            player.queue.tracks.length >
            0
        ) {

            return;
        }

        /*
         * AUTOPLAY
         */

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
    }
);

/* =========================================================
   RAW DISCORD VOICE DATA
========================================================= */

client.on(
    'raw',
    data => {

        try {

            lavalink.sendRawData(
                data
            );

        } catch (error) {

            console.warn(
                '[Lavalink Raw Error]:',
                error?.message || error
            );
        }
    }
);

/* =========================================================
   CONNECT VOICE
========================================================= */

async function connectToChannel(
    channelId
) {

    try {

        const channel =
            await client.channels.fetch(
                channelId
            );

        if (!channel) {

            return {
                success: false,
                message:
                    'Channel tidak ditemukan!'
            };
        }

        if (!channel.isVoice()) {

            return {
                success: false,
                message:
                    'Bukan Voice Channel!'
            };
        }

        /*
         * Pastikan Lavalink tersedia.
         */

        const node =
            lavalink.nodeManager.nodes.get(
                LAVALINK_ID
            );

        if (
            !node ||
            !node.connected
        ) {

            console.warn(
                '[Voice] Lavalink node belum tersedia.'
            );

            return {
                success: false,
                message:
                    'Lavalink belum terhubung!'
            };
        }

        /*
         * Destroy player lama.
         */

        let player =
            lavalink.getPlayer(
                channel.guild.id
            );

        if (player) {

            try {
                await player.disconnect();
            } catch (_) {}

            try {
                await player.destroy();
            } catch (_) {}
        }

        /*
         * Buat player baru.
         */

        player =
            await lavalink.createPlayer({

                guildId:
                    channel.guild.id,

                voiceChannelId:
                    channel.id,

                textChannelId:
                    channel.id,

                selfDeaf:
                    false,

                selfMute:
                    false,

                volume
            });

        await player.connect();

        try {

            await player.setVolume(
                volume
            );

        } catch (error) {

            console.warn(
                '[Volume] Initial set failed:',
                error?.message || error
            );
        }

        currentVoiceChannel =
            channel;

        savedVoiceChannelId =
            channel.id;

        console.log(
            '[Voice] Connected:',
            channel.name
        );

        return {
            success: true
        };

    } catch (error) {

        console.error(
            '[Voice] Connect error:',
            error?.message || error
        );

        return {
            success: false,
            message:
                error?.message ||
                'Unknown error'
        };
    }
}

/* =========================================================
   LEAVE CHANNEL
========================================================= */

async function leaveChannel() {

    try {

        if (currentVoiceChannel) {

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
        }

    } catch (error) {

        console.warn(
            '[Voice] Leave error:',
            error?.message || error
        );
    }

    currentVoiceChannel =
        null;

    savedVoiceChannelId =
        '';

    console.log(
        '[Voice] Disconnected.'
    );
}

/* =========================================================
   STOP PLAYER
========================================================= */

async function stopPlayer(
    player
) {

    if (!player) {
        return;
    }

    /*
     * Hapus seluruh queue.
     */

    try {

        if (
            typeof player.queue.clear ===
            'function'
        ) {

            player.queue.clear();

        } else {

            player.queue.tracks.length = 0;
        }

    } catch (error) {

        console.warn(
            '[Stop] Queue clear failed:',
            error?.message || error
        );
    }

    /*
     * Hentikan lagu yang sedang dimainkan.
     */

    try {

        if (
            typeof player.stopPlaying ===
            'function'
        ) {

            await player.stopPlaying();

        } else if (
            typeof player.stop ===
            'function'
        ) {

            await player.stop();
        }

    } catch (error) {

        console.warn(
            '[Stop] Stop playing failed:',
            error?.message || error
        );
    }

    /*
     * Jangan disconnect.
     */

    console.log(
        '[Stop] Semua musik dihentikan, tetap di Voice Channel.'
    );
}

/* =========================================================
   VOLUME
========================================================= */

async function setPlayerVolume(
    player,
    requestedVolume
) {

    if (!player) {
        return;
    }

    let newVolume =
        Number(requestedVolume);

    if (
        !Number.isFinite(
            newVolume
        )
    ) {

        return;
    }

    newVolume =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(
                    newVolume
                )
            )
        );

    volume =
        newVolume;

    try {

        await player.setVolume(
            newVolume
        );

    } catch (error) {

        console.error(
            '[Volume Error]:',
            error?.message || error
        );
    }
}

/* =========================================================
   API STATE
========================================================= */

app.get(
    '/api/state',
    (req, res) => {

        const player =
            getCurrentPlayer();

        const current =
            player?.queue?.current ||
            null;

        res.json({

            connected:
                Boolean(
                    currentVoiceChannel
                ),

            voiceChannel:
                currentVoiceChannel
                    ? {
                        id:
                            currentVoiceChannel.id,

                        name:
                            currentVoiceChannel.name
                    }
                    : null,

            playing:
                Boolean(
                    player?.playing
                ),

            paused:
                Boolean(
                    player?.paused
                ),

            current:
                current
                    ? {

                        title:
                            current.info?.title ||
                            'Tidak ada',

                        author:
                            current.info?.author ||
                            '',

                        identifier:
                            current.info?.identifier ||
                            null,

                        uri:
                            current.info?.uri ||
                            null,

                        duration:
                            current.info?.duration ||
                            0,

                        position:
                            player?.position ||
                            0
                    }
                    : null,

            queue:
                player?.queue?.tracks?.map(
                    (
                        track,
                        index
                    ) => ({

                        index,

                        title:
                            track.info?.title ||
                            'Tidak ada',

                        author:
                            track.info?.author ||
                            '',

                        identifier:
                            track.info?.identifier ||
                            null,

                        duration:
                            track.info?.duration ||
                            0
                    })
                ) || [],

            volume:
                getPlayerVolume(
                    player
                ),

            autoplay:
                isAutoplayEnabled,

            repeat:
                repeatMode,

            savedVoiceChannelId
        });
    }
);

/* =========================================================
   DASHBOARD
========================================================= */

function renderDashboard() {

    return `
<!DOCTYPE html>

<html lang="id">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>Botave Music Controller</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    padding: 0;

    background:
        linear-gradient(
            135deg,
            #0f172a,
            #111827
        );

    color: #f8fafc;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

    min-height: 100vh;
}

.container {
    width: min(1000px, 94%);
    margin: 30px auto;
}

.card {
    background:
        rgba(15, 23, 42, .94);

    border: 1px solid
        rgba(255,255,255,.08);

    border-radius: 18px;

    padding: 20px;

    margin-bottom: 18px;

    box-shadow:
        0 10px 40px
        rgba(0,0,0,.25);
}

h1 {
    margin-top: 0;
}

input,
button {
    font: inherit;
}

input {
    width: 100%;

    padding: 12px;

    border-radius: 10px;

    border: 1px solid
        rgba(255,255,255,.12);

    background: #020617;

    color: white;

    outline: none;
}

button {
    border: none;

    border-radius: 10px;

    padding: 11px 15px;

    margin: 4px;

    cursor: pointer;

    background: #334155;

    color: white;

    transition: .15s;
}

button:hover {
    transform:
        translateY(-1px);

    filter:
        brightness(1.15);
}

.primary {
    background: #2563eb;
}

.success {
    background: #16a34a;
}

.danger {
    background: #dc2626;
}

.warning {
    background: #d97706;
}

.controls {
    display: flex;

    flex-wrap: wrap;

    gap: 5px;

    margin-top: 12px;
}

.status {
    padding: 12px;

    border-radius: 10px;

    background: #020617;

    margin-top: 10px;
}

.track {
    font-size: 20px;

    font-weight: bold;
}

.sub {
    color: #94a3b8;

    margin-top: 5px;
}

.queue-item {
    display: flex;

    justify-content:
        space-between;

    align-items: center;

    gap: 10px;

    padding: 10px;

    border-bottom:
        1px solid
        rgba(255,255,255,.06);
}

.row {
    display: flex;

    gap: 10px;

    align-items: center;
}

.row input {
    flex: 1;
}

.slider {
    width: 100%;
}

.small {
    font-size: 13px;

    color: #94a3b8;
}

.badge {
    display: inline-block;

    padding: 5px 9px;

    border-radius: 999px;

    background: #334155;

    font-size: 12px;
}

/*
 * Play row:
 * input + Play + Stop
 */

.play-row {
    display: flex;

    gap: 6px;

    align-items: center;
}

.play-row input {
    flex: 1;
}

.play-row form {
    margin: 0;
}

.play-row button {
    white-space: nowrap;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>
🎵 Botave Music Controller
</h1>

<div class="small">
Discord Music Controller
</div>

</div>

<div class="card">

<h3>
Voice Channel
</h3>

<form
    method="POST"
    action="/api/connect"
>

<div class="row">

<input
    type="text"
    name="channelId"
    placeholder="Masukkan Voice Channel ID"
    value="${escapeHtml(
        savedVoiceChannelId
    )}"
>

<button
    class="primary"
    type="submit"
>
Connect
</button>

</div>

</form>

<form
    method="POST"
    action="/api/leave"
>

<button
    class="danger"
    type="submit"
>
Leave
</button>

</form>

</div>

<div class="card">

<h3>
Now Playing
</h3>

<div
    id="nowPlaying"
    class="status"
>
Loading...
</div>

<div class="controls">

<form
    method="POST"
    action="/api/pause"
>

<button
    class="warning"
    type="submit"
>
⏸ Pause
</button>

</form>

<form
    method="POST"
    action="/api/resume"
>

<button
    class="success"
    type="submit"
>
▶ Resume
</button>

</form>

<form
    method="POST"
    action="/api/skip"
>

<button
    class="primary"
    type="submit"
>
⏭ Skip
</button>

</form>

</div>

</div>

<div class="card">

<h3>
Play
</h3>

<div class="play-row">

<form
    method="POST"
    action="/api/play"
    style="display:contents"
>

<input
    type="text"
    name="query"
    placeholder="YouTube URL / judul lagu"
>

<button
    class="primary"
    type="submit"
>
▶ Play
</button>

</form>

<form
    method="POST"
    action="/api/stop"
>

<button
    class="danger"
    type="submit"
>
⏹ Stop
</button>

</form>

</div>

<div class="small">
Stop menghentikan semua musik dan queue,
tetapi tetap berada di Voice Channel.
</div>

</div>

<div class="card">

<h3>
Volume
</h3>

<form
    method="POST"
    action="/api/volume"
>

<input
    class="slider"
    type="range"
    name="volume"
    min="0"
    max="100"
    value="${volume}"
    oninput="
        volumeValue.innerText=this.value
    "
>

<div>

Volume:

<span id="volumeValue">
${volume}
</span>

</div>

<button
    class="primary"
    type="submit"
>
Set Volume
</button>

</form>

</div>

<div class="card">

<h3>
Modes
</h3>

<div class="controls">

<form
    method="POST"
    action="/api/loop-track"
>

<button
    class="warning"
    type="submit"
>
🔂 Repeat Track
</button>

</form>

<form
    method="POST"
    action="/api/loop-queue"
>

<button
    class="warning"
    type="submit"
>
🔁 Repeat Queue
</button>

</form>

<form
    method="POST"
    action="/api/toggle-autoplay"
>

<button
    class="success"
    type="submit"
>
🤖 Toggle Autoplay
</button>

</form>

</div>

<div
    id="modeStatus"
    class="status"
>
Loading...
</div>

</div>

<div class="card">

<h3>
Queue
</h3>

<div id="queue">
Loading...
</div>

</div>

</div>

<script>

async function refreshState() {

    try {

        const response =
            await fetch(
                '/api/state'
            );

        const state =
            await response.json();

        const nowPlaying =
            document.getElementById(
                'nowPlaying'
            );

        const modeStatus =
            document.getElementById(
                'modeStatus'
            );

        const queue =
            document.getElementById(
                'queue'
            );

        if (state.current) {

            nowPlaying.innerHTML = \`
                <div class="track">
                    🎵 \${escapeClient(
                        state.current.title
                    )}
                </div>

                <div class="sub">
                    \${escapeClient(
                        state.current.author || ''
                    )}
                </div>

                <div class="sub">
                    Status:
                    \${state.playing
                        ? '▶ Playing'
                        : state.paused
                            ? '⏸ Paused'
                            : '⏹ Stopped'}
                </div>
            \`;

        } else {

            nowPlaying.innerHTML =
                'Tidak ada lagu yang sedang diputar.';
        }

        modeStatus.innerHTML = \`
            Autoplay:

            <span class="badge">
                \${state.autoplay
                    ? 'ON'
                    : 'OFF'}
            </span>

            &nbsp;

            Repeat:

            <span class="badge">
                \${escapeClient(
                    state.repeat
                )}
            </span>

            &nbsp;

            Volume:

            <span class="badge">
                \${state.volume}
            </span>
        \`;

        if (!state.queue.length) {

            queue.innerHTML =
                '<div class="small">Queue kosong.</div>';

        } else {

            queue.innerHTML =
                state.queue.map(
                    (
                        track,
                        index
                    ) => \`
                        <div class="queue-item">

                            <div>

                                <b>
                                    \${index + 1}.
                                    \${escapeClient(
                                        track.title
                                    )}
                                </b>

                                <div class="small">
                                    \${escapeClient(
                                        track.author || ''
                                    )}
                                </div>

                            </div>

                            <form
                                method="POST"
                                action="/api/delete-queue-item"
                            >

                                <input
                                    type="hidden"
                                    name="index"
                                    value="\${index}"
                                >

                                <button
                                    class="danger"
                                    type="submit"
                                >
                                    Delete
                                </button>

                            </form>

                        </div>
                    \`
                ).join('');
        }

    } catch (error) {

        console.error(error);
    }
}

function escapeClient(value) {

    return String(value ?? '')
        .replaceAll(
            '&',
            '&amp;'
        )
        .replaceAll(
            '<',
            '&lt;'
        )
        .replaceAll(
            '>',
            '&gt;'
        )
        .replaceAll(
            '"',
            '&quot;'
        )
        .replaceAll(
            "'",
            '&#039;'
        );
}

refreshState();

setInterval(
    refreshState,
    2000
);

</script>

</body>

</html>
`;
}

/* =========================================================
   FAVICON
========================================================= */

app.get(
    '/favicon.ico',
    (_, res) =>
        res.status(204).end()
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
    '/',
    (_, res) =>
        res.send(
            renderDashboard()
        )
);

/* =========================================================
   CONNECT
========================================================= */

app.post(
    '/api/connect',
    async (
        req,
        res
    ) => {

        const channelId =
            req.body.channelId?.trim();

        if (channelId) {

            await connectToChannel(
                channelId
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   LEAVE
========================================================= */

app.post(
    '/api/leave',
    async (
        _,
        res
    ) => {

        await leaveChannel();

        res.redirect('/');
    }
);

/* =========================================================
   PLAY
========================================================= */

app.post(
    '/api/play',
    async (
        req,
        res
    ) => {

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

                const result =
                    await connectToChannel(
                        currentVoiceChannel.id
                    );

                if (!result.success) {
                    return res.redirect('/');
                }

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

            if (
                result?.tracks?.length
            ) {

                const track =
                    result.tracks[0];

                player.queue.add(
                    track
                );

                console.log(
                    '[Play]',
                    getTrackTitle(track)
                );

                if (
                    !player.playing &&
                    !player.paused
                ) {

                    await player.play();
                }
            }

        } catch (error) {

            console.error(
                '[Play Error]:',
                error?.message || error
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   PAUSE
========================================================= */

app.post(
    '/api/pause',
    async (
        _,
        res
    ) => {

        const player =
            getCurrentPlayer();

        if (!player) {
            return res.redirect('/');
        }

        try {

            await player.pause();

        } catch (error) {

            console.error(
                '[Pause Error]:',
                error?.message || error
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   RESUME
========================================================= */

app.post(
    '/api/resume',
    async (
        _,
        res
    ) => {

        const player =
            getCurrentPlayer();

        if (!player) {
            return res.redirect('/');
        }

        try {

            await player.resume();

        } catch (error) {

            console.error(
                '[Resume Error]:',
                error?.message || error
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   SKIP
========================================================= */

app.post(
    '/api/skip',
    async (
        _,
        res
    ) => {

        const player =
            getCurrentPlayer();

        if (!player) {
            return res.redirect('/');
        }

        if (
            manualSkipInProgress
        ) {

            return res.redirect('/');
        }

        manualSkipInProgress = true;

        try {

            const current =
                player.queue.current;

            if (!current) {
                return res.redirect('/');
            }

            /*
             * Ada queue berikutnya.
             */

            if (
                player.queue.tracks.length >
                0
            ) {

                console.log(
                    '[Skip] Next queue track.'
                );

                await player.skip();

                return res.redirect('/');
            }

            /*
             * Queue kosong + autoplay OFF.
             */

            if (!isAutoplayEnabled) {

                console.log(
                    '[Skip] Queue kosong + autoplay OFF.'
                );

                await stopPlayer(
                    player
                );

                return res.redirect('/');
            }

            /*
             * Queue kosong + autoplay ON.
             */

            console.log(
                '[Skip] Searching autoplay next after:',
                getTrackTitle(current)
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

                await stopPlayer(
                    player
                );

                return res.redirect('/');
            }

            rememberTrack(next);

            player.queue.add(
                next
            );

            console.log(
                '[Skip] Autoplay Next:',
                getTrackTitle(next)
            );

            await player.skip();

        } catch (error) {

            console.error(
                '[Skip Error]:',
                error?.message || error
            );

        } finally {

            setTimeout(
                () => {
                    manualSkipInProgress =
                        false;
                },
                500
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   STOP
========================================================= */

app.post(
    '/api/stop',
    async (
        _,
        res
    ) => {

        const player =
            getCurrentPlayer();

        if (player) {

            await stopPlayer(
                player
            );
        }

        /*
         * Penting:
         * currentVoiceChannel TIDAK diubah.
         *
         * Jadi bot tetap di Voice Channel.
         */

        res.redirect('/');
    }
);

/* =========================================================
   VOLUME
========================================================= */

app.post(
    '/api/volume',
    async (
        req,
        res
    ) => {

        const player =
            getCurrentPlayer();

        await setPlayerVolume(
            player,
            req.body.volume
        );

        res.redirect('/');
    }
);

/* =========================================================
   REPEAT TRACK
========================================================= */

app.post(
    '/api/loop-track',
    async (
        _,
        res
    ) => {

        if (
            repeatMode === 'track'
        ) {

            repeatMode = 'off';

        } else {

            repeatMode = 'track';
        }

        console.log(
            '[Repeat] Mode:',
            repeatMode
        );

        res.redirect('/');
    }
);

/* =========================================================
   REPEAT QUEUE
========================================================= */

app.post(
    '/api/loop-queue',
    async (
        _,
        res
    ) => {

        if (
            repeatMode === 'queue'
        ) {

            repeatMode = 'off';

        } else {

            repeatMode = 'queue';
        }

        console.log(
            '[Repeat] Mode:',
            repeatMode
        );

        res.redirect('/');
    }
);

/* =========================================================
   AUTOPLAY TOGGLE
========================================================= */

app.post(
    '/api/toggle-autoplay',
    async (
        _,
        res
    ) => {

        isAutoplayEnabled =
            !isAutoplayEnabled;

        console.log(
            '[Autoplay]:',
            isAutoplayEnabled
                ? 'ON'
                : 'OFF'
        );

        res.redirect('/');
    }
);

/* =========================================================
   DELETE QUEUE ITEM
========================================================= */

app.post(
    '/api/delete-queue-item',
    async (
        req,
        res
    ) => {

        const player =
            getCurrentPlayer();

        if (!player) {
            return res.redirect('/');
        }

        const index =
            Number(
                req.body.index
            );

        if (
            !Number.isInteger(index)
        ) {

            return res.redirect('/');
        }

        try {

            const tracks =
                player.queue.tracks;

            if (
                index >= 0 &&
                index < tracks.length
            ) {

                tracks.splice(
                    index,
                    1
                );

                console.log(
                    '[Queue] Deleted index:',
                    index
                );
            }

        } catch (error) {

            console.error(
                '[Queue Delete Error]:',
                error?.message || error
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   UNKNOWN ROUTES
========================================================= */

app.get(
    '*',
    (
        _,
        res
    ) =>
        res.send(
            renderDashboard()
        )
);

/* =========================================================
   DISCORD READY
========================================================= */

client.on(
    'ready',
    async () => {

        console.log(
            'Logged in as',
            client.user.tag
        );

        /*
         * Update Discord client ID
         * sebelum Lavalink init.
         */

        lavalink.options.client.id =
            client.user.id;

        lavalink.options.client.username =
            client.user.username;

        try {

            await lavalink.init(
                client.user
            );

            console.log(
                '[Lavalink] Manager initialized.'
            );

        } catch (error) {

            console.error(
                '[Lavalink] Init error:',
                error?.message || error
            );
        }
    }
);

/* =========================================================
   ERROR HANDLERS
========================================================= */

process.on(
    'unhandledRejection',
    reason => {

        console.warn(
            '[Unhandled Rejection]',
            reason
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.warn(
            '[Uncaught Exception]',
            error?.message || error
        );
    }
);

/* =========================================================
   HTTP SERVER
========================================================= */

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '======================================'
        );

        console.log(
            'Web Controller berjalan di port',
            PORT
        );

        console.log(
            '======================================'
        );
    }
);

/* =========================================================
   LOGIN
========================================================= */

client.login(TOKEN);
