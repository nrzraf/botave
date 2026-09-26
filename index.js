const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

const Settings = require(
    'discord.js-selfbot-v13/src/managers/ClientUserSettingManager'
);

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
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   ENVIRONMENT
========================================================= */

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = Number(process.env.PORT || 3000);

/*
 * Railway:
 * LAVALINK_HOST=${{lavalink.RAILWAY_PRIVATE_DOMAIN}}
 *
 * Jangan fallback ke localhost karena di Railway
 * Lavalink adalah service terpisah.
 */

const LAVALINK_HOST = process.env.LAVALINK_HOST;

const LAVALINK_PORT =
    Number(process.env.LAVALINK_PORT || 2333);

const LAVALINK_PASSWORD =
    process.env.LAVALINK_PASSWORD || 'youshallnotpass';

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
        'ERROR: DISCORD_TOKEN tidak ditemukan!'
    );

    process.exit(1);
}

if (!LAVALINK_HOST) {
    console.error(
        'ERROR: LAVALINK_HOST tidak ditemukan!'
    );

    console.error(
        'Set LAVALINK_HOST=${{lavalink.RAILWAY_PRIVATE_DOMAIN}}'
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
   LAVALINK
========================================================= */

console.log('======================================');
console.log('[Lavalink] Configuration');
console.log('======================================');
console.log('Host       :', LAVALINK_HOST);
console.log('Port       :', LAVALINK_PORT);
console.log('Secure     :', LAVALINK_SECURE);
console.log('Node ID    :', LAVALINK_ID);
console.log('Retry      :', LAVALINK_RETRY_AMOUNT);
console.log('Retry Delay:', LAVALINK_RETRY_DELAY);
console.log('======================================');

const lavalink = new LavalinkManager({
    nodes: [
        {
            id: LAVALINK_ID,
            host: LAVALINK_HOST,
            port: LAVALINK_PORT,
            authorization: LAVALINK_PASSWORD,

            // false = ws://
            // true  = wss://
            secure: LAVALINK_SECURE,

            retryAmount: LAVALINK_RETRY_AMOUNT,
            retryDelay: LAVALINK_RETRY_DELAY,

            requestSignalTimeoutMS: 10000,
            closeOnError: false,
            heartBeatInterval: 30000,
            enablePingOnStatsCheck: true
        }
    ],

    sendToShard: (guildId, payload) => {
        try {
            const guild =
                client.guilds.cache.get(guildId);

            if (guild?.shard) {
                guild.shard.send(payload);
            }
        } catch (error) {
            console.warn(
                '[Lavalink] sendToShard error:',
                error?.message || error
            );
        }
    },

    client: {
        id: '100000000000000000',
        username: 'Botave'
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

/*
 * Penting:
 *
 * Saat Stop dipanggil, Lavalink dapat mengirim event
 * trackEnd/trackStuck tergantung kondisi player.
 *
 * Flag ini mencegah event tersebut menyalakan
 * autoplay kembali setelah user menekan Stop.
 */

let manualStopInProgress = false;

const autoplayHistory = new Set();

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
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function rememberTrack(track) {
    const id = getTrackId(track);

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
                            track?.info
                                ?.identifier;

                        return (
                            id &&
                            id !== previousId &&
                            !autoplayHistory.has(
                                id
                            )
                        );
                    }
                );

            if (
                !candidates.length
            ) {
                candidates =
                    result.tracks.filter(
                        track => {
                            const id =
                                track?.info
                                    ?.identifier;

                            return (
                                id &&
                                id !== previousId
                            );
                        }
                    );
            }

            if (
                !candidates.length
            ) {
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
        autoplayActionInProgress ||
        manualStopInProgress
    ) {
        return false;
    }

    autoplayActionInProgress = true;

    try {
        /*
         * Jangan autoplay kalau queue masih berisi
         * lagu dari user.
         */

        if (
            player.queue?.tracks?.length > 0
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

        /*
         * User mungkin menekan Stop ketika
         * search sedang berjalan.
         */

        if (manualStopInProgress) {
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
    async (player, track) => {
        if (!track) {
            return;
        }

        console.log(
            '[Track End]',
            getTrackTitle(track)
        );

        /*
         * Stop manual:
         *
         * Jangan biarkan trackEnd hasil dari Stop
         * memicu repeat/autoplay.
         */

        if (manualStopInProgress) {
            console.log(
                '[Track End] Diabaikan karena Stop manual.'
            );

            return;
        }

        /*
         * REPEAT TRACK
         */

        if (repeatMode === 'track') {
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

        if (repeatMode === 'queue') {
            try {
                player.queue.add(track);

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
         * Kalau queue masih ada,
         * jangan jalankan autoplay.
         */

        if (
            player.queue?.tracks?.length > 0
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
            lavalink.sendRawData(data);
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
         * Pastikan Lavalink node tersedia.
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
         * Reset Stop state karena user
         * sedang membuat koneksi baru.
         */

        manualStopInProgress = false;
        autoplayActionInProgress = false;
        manualSkipInProgress = false;

        /*
         * Destroy player lama jika ada.
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

                selfDeaf: false,
                selfMute: false,

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
    /*
     * Stop autoplay/repeat action sebelum disconnect.
     */

    manualStopInProgress = true;
    autoplayActionInProgress = false;
    manualSkipInProgress = false;

    try {
        if (currentVoiceChannel) {
            const player =
                lavalink.getPlayer(
                    currentVoiceChannel.guild.id
                );

            if (player) {
                /*
                 * Hapus queue terlebih dahulu.
                 */

                try {
                    if (
                        typeof player.queue?.clear ===
                        'function'
                    ) {
                        player.queue.clear();
                    } else if (
                        player.queue?.tracks
                    ) {
                        player.queue.tracks.length = 0;
                    }
                } catch (_) {}

                /*
                 * Disconnect.
                 */

                try {
                    await player.disconnect();
                } catch (_) {}

                /*
                 * Destroy player.
                 */

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

    currentVoiceChannel = null;
    savedVoiceChannelId = '';

    autoplayHistory.clear();

    console.log(
        '[Voice] Disconnected.'
    );

    /*
     * Biarkan event yang sedang pending
     * selesai tanpa memicu autoplay.
     */

    setTimeout(() => {
        manualStopInProgress = false;
    }, 500);
}

/* =========================================================
   STOP PLAYER
========================================================= */

async function stopPlayer(player) {
    if (!player) {
        return;
    }

    /*
     * Aktifkan flag SEBELUM stopPlaying().
     *
     * Ini penting supaya event trackEnd yang
     * muncul karena Stop tidak menjalankan autoplay.
     */

    manualStopInProgress = true;
    autoplayActionInProgress = false;
    manualSkipInProgress = false;

    /*
     * Hapus seluruh queue.
     */

    try {
        if (
            typeof player.queue?.clear ===
            'function'
        ) {
            player.queue.clear();
        } else if (
            player.queue?.tracks
        ) {
            player.queue.tracks.length = 0;
        }
    } catch (error) {
        console.warn(
            '[Stop] Queue clear failed:',
            error?.message || error
        );
    }

    /*
     * Hentikan lagu sekarang.
     *
     * stopPlaying() digunakan terlebih dahulu
     * karena versi Lavalink client yang digunakan
     * menyediakan method tersebut.
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

        /*
         * Fallback kedua.
         */

        try {
            if (
                typeof player.stop ===
                'function'
            ) {
                await player.stop();
            }
        } catch (_) {}
    }

    /*
     * Jangan disconnect.
     *
     * Player tetap berada di voice channel.
     */

    console.log(
        '[Stop] Semua musik dihentikan, tetap di Voice Channel.'
    );

    /*
     * Jangan reset manualStopInProgress terlalu cepat.
     * Beri waktu Lavalink mengirim event trackEnd.
     */

    setTimeout(() => {
        manualStopInProgress = false;
    }, 1000);
}

/* =========================================================
   VOLUME
========================================================= */

async function setPlayerVolume(
    player,
    requestedVolume
) {
    if (!player) {
        return false;
    }

    let newVolume =
        Number(requestedVolume);

    if (
        !Number.isFinite(newVolume)
    ) {
        return false;
    }

    newVolume =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(newVolume)
            )
        );

    try {
        await player.setVolume(
            newVolume
        );

        volume = newVolume;

        return true;

    } catch (error) {
        console.error(
            '[Volume Error]:',
            error?.message || error
        );

        return false;
    }
}

/* =========================================================
   API STATE
========================================================= */

app.get(
    '/api/state',
    (req, res) => {
        try {
            const player =
                getCurrentPlayer();

            const current =
                player?.queue?.current ||
                null;

            const tracks =
                player?.queue?.tracks ||
                [];

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
                                currentVoiceChannel.name,

                            guildName:
                                currentVoiceChannel
                                    .guild
                                    ?.name || ''
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
                                getTrackTitle(
                                    current
                                ),

                            author:
                                current.info
                                    ?.author ||
                                '',

                            identifier:
                                current.info
                                    ?.identifier ||
                                null,

                            uri:
                                current.info
                                    ?.uri ||
                                null,

                            duration:
                                current.info
                                    ?.duration ||
                                0,

                            position:
                                player?.position ||
                                0
                        }
                        : null,

                queue:
                    tracks.map(
                        (
                            track,
                            index
                        ) => ({
                            index,

                            title:
                                getTrackTitle(
                                    track
                                ),

                            author:
                                track.info
                                    ?.author ||
                                '',

                            identifier:
                                track.info
                                    ?.identifier ||
                                null,

                            duration:
                                track.info
                                    ?.duration ||
                                0
                        })
                    ),

                queueLength:
                    tracks.length,

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

        } catch (error) {
            console.error(
                '[State Error]:',
                error?.message || error
            );

            res.status(500).json({
                error: true
            });
        }
    }
);

/* =========================================================
   DASHBOARD
   UI SEBELUMNYA
========================================================= */

function renderDashboard() {
    const player =
        getCurrentPlayer();

    const current =
        player?.queue?.current
            ?.info?.title ||
        'Tidak ada';

    const currentVolume =
        getPlayerVolume(player);

    let queue =
        '<div class="small">Queue kosong.</div>';

    if (
        player?.queue?.tracks?.length
    ) {
        queue =
            player.queue.tracks
                .map(
                    (song, index) => `
<div class="queue-item">

    <div>
        <strong>
            ${index + 1}.
            ${escapeHtml(
                getTrackTitle(song)
            )}
        </strong>

        <div class="small">
            ${escapeHtml(
                song.info?.author || ''
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
            value="${index}"
        >

        <button
            class="danger"
            type="submit"
        >
            X
        </button>
    </form>

</div>
`
                )
                .join('');
    }

    const voiceStatus =
        currentVoiceChannel
            ? `
<span style="color:#22c55e">
    ${escapeHtml(
        currentVoiceChannel.name
    )}
    -
    ${escapeHtml(
        currentVoiceChannel.guild?.name ||
        ''
    )}
</span>
`
            : `
<span style="color:#ef4444">
    Belum Terhubung
</span>
`;

    return `
<!DOCTYPE html>

<html lang="id">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>
    Botave Music Controller
</title>

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

@media(max-width:700px) {

    .row {
        flex-direction: column;
        align-items: stretch;
    }

    .play-row {
        flex-direction: column;
        align-items: stretch;
    }

    .play-row form {
        width: 100%;
    }

    .play-row button {
        width: 100%;
    }

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
    required
>

<button
    class="primary"
    type="submit"
>
    Connect
</button>

</div>

</form>

<div class="status">

Status:
<strong id="voiceStatus">
    ${voiceStatus}
</strong>

</div>

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
    required
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
    id="volumeSlider"
    class="slider"
    type="range"
    name="volume"
    min="0"
    max="100"
    value="${currentVolume}"
    oninput="
        document.getElementById(
            'volumeValue'
        ).innerText=this.value
    "
>

<div>

Volume:
<span id="volumeValue">
    ${currentVolume}
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

${queue}

</div>

</div>

</div>

<script>

function escapeClient(value) {

    const div =
        document.createElement('div');

    div.textContent =
        value ?? '';

    return div.innerHTML;
}

function formatDuration(ms) {

    if (
        !Number.isFinite(ms) ||
        ms <= 0
    ) {
        return '00:00';
    }

    const totalSeconds =
        Math.floor(ms / 1000);

    const hours =
        Math.floor(
            totalSeconds / 3600
        );

    const minutes =
        Math.floor(
            (totalSeconds % 3600) / 60
        );

    const seconds =
        totalSeconds % 60;

    if (hours > 0) {

        return (
            String(hours)
                .padStart(2, '0') +
            ':' +
            String(minutes)
                .padStart(2, '0') +
            ':' +
            String(seconds)
                .padStart(2, '0')
        );

    }

    return (
        String(minutes)
            .padStart(2, '0') +
        ':' +
        String(seconds)
            .padStart(2, '0')
    );
}

async function refreshState() {

    try {

        const response =
            await fetch(
                '/api/state',
                {
                    cache: 'no-store'
                }
            );

        if (!response.ok) {
            return;
        }

        const state =
            await response.json();

        /*
         * NOW PLAYING
         */

        const nowPlaying =
            document.getElementById(
                'nowPlaying'
            );

        if (state.current) {

            nowPlaying.innerHTML = `
                <div class="track">
                    🎵
                    ${escapeClient(
                        state.current.title
                    )}
                </div>

                <div class="sub">
                    ${escapeClient(
                        state.current.author || ''
                    )}
                </div>

                <div class="small">
                    ${formatDuration(
                        state.current.position || 0
                    )}
                    /
                    ${formatDuration(
                        state.current.duration || 0
                    )}
                </div>
            `;

        } else {

            nowPlaying.innerHTML = `
                <div class="track">
                    🎵 Tidak ada
                </div>

                <div class="sub">
                    Tidak ada lagu yang sedang diputar.
                </div>
            `;
        }

        /*
         * VOICE STATUS
         */

        const voiceStatus =
            document.getElementById(
                'voiceStatus'
            );

        if (voiceStatus) {

            if (state.connected) {

                voiceStatus.innerHTML = `
                    <span
                        style="color:#22c55e"
                    >
                        ${escapeClient(
                            state.voiceChannel?.name ||
                            ''
                        )}

                        -

                        ${escapeClient(
                            state.voiceChannel?.guildName ||
                            ''
                        )}
                    </span>
                `;

            } else {

                voiceStatus.innerHTML = `
                    <span
                        style="color:#ef4444"
                    >
                        Belum Terhubung
                    </span>
                `;
            }
        }

        /*
         * VOLUME
         */

        const volumeSlider =
            document.getElementById(
                'volumeSlider'
            );

        const volumeValue =
            document.getElementById(
                'volumeValue'
            );

        if (
            volumeSlider &&
            document.activeElement !==
                volumeSlider
        ) {
            volumeSlider.value =
                state.volume;
        }

        if (volumeValue) {
            volumeValue.innerText =
                state.volume;
        }

        /*
         * MODE STATUS
         */

        const modeStatus =
            document.getElementById(
                'modeStatus'
            );

        if (modeStatus) {

            modeStatus.innerHTML = `
                <div>
                    🔂 Repeat Track:
                    <strong>
                        ${
                            state.repeat === 'track'
                                ? 'ON'
                                : 'OFF'
                        }
                    </strong>
                </div>

                <div>
                    🔁 Repeat Queue:
                    <strong>
                        ${
                            state.repeat === 'queue'
                                ? 'ON'
                                : 'OFF'
                        }
                    </strong>
                </div>

                <div>
                    🤖 Autoplay:
                    <strong>
                        ${
                            state.autoplay
                                ? 'ON'
                                : 'OFF'
                        }
                    </strong>
                </div>
            `;
        }

        /*
         * QUEUE
         */

        const queue =
            document.getElementById(
                'queue'
            );

        if (
            !state.queue ||
            state.queue.length === 0
        ) {

            queue.innerHTML = `
                <div class="small">
                    Queue kosong.
                </div>
            `;

        } else {

            queue.innerHTML =
                state.queue
                    .map(song => `
<div class="queue-item">

    <div>

        <strong>
            ${song.index + 1}.
            ${escapeClient(
                song.title
            )}
        </strong>

        <div class="small">
            ${escapeClient(
                song.author || ''
            )}

            ${
                song.duration
                    ? ' - ' +
                      formatDuration(
                          song.duration
                      )
                    : ''
            }
        </div>

    </div>

    <form
        method="POST"
        action="/api/delete-queue-item"
    >

        <input
            type="hidden"
            name="index"
            value="${song.index}"
        >

        <button
            class="danger"
            type="submit"
        >
            X
        </button>

    </form>

</div>
`)
                    .join('');
        }

    } catch (error) {

        console.warn(
            'State update failed:',
            error
        );
    }
}

refreshState();

setInterval(
    refreshState,
    1000
);

</script>

</body>

</html>
`;
}

/* =========================================================
   ROUTES
========================================================= */

app.get(
    '/favicon.ico',
    (req, res) => {
        res.status(204).end();
    }
);

app.get(
    '/',
    (req, res) => {
        res.send(
            renderDashboard()
        );
    }
);

/* =========================================================
   CONNECT
========================================================= */

app.post(
    '/api/connect',
    async (req, res) => {

        const channelId =
            req.body?.channelId?.trim();

        if (!channelId) {
            return res.redirect('/');
        }

        const result =
            await connectToChannel(
                channelId
            );

        if (!result.success) {

            console.warn(
                '[Connect]',
                result.message
            );

            return res.send(`
<script>
alert(
    ${JSON.stringify(
        result.message ||
        'Gagal connect.'
    )}
);
location.href='/';
</script>
`);
        }

        res.redirect('/');
    }
);

/* =========================================================
   LEAVE
========================================================= */

app.post(
    '/api/leave',
    async (req, res) => {

        await leaveChannel();

        res.redirect('/');
    }
);

/* =========================================================
   PLAY
========================================================= */

app.post(
    '/api/play',
    async (req, res) => {

        const query =
            req.body?.query?.trim();

        if (!query) {
            return res.redirect('/');
        }

        if (!currentVoiceChannel) {

            return res.send(`
<script>
alert(
    'Atur Voice Channel ID terlebih dahulu!'
);
location.href='/';
</script>
`);
        }

        try {

            /*
             * User sedang Play,
             * jadi reset manual stop.
             */

            manualStopInProgress = false;

            let player =
                lavalink.getPlayer(
                    currentVoiceChannel.guild.id
                );

            /*
             * Kalau player hilang,
             * connect ulang.
             */

            if (!player) {

                const result =
                    await connectToChannel(
                        currentVoiceChannel.id
                    );

                if (!result.success) {
                    console.warn(
                        '[Play] Reconnect failed:',
                        result.message
                    );

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

            /*
             * Search.
             */

            const result =
                await player.search(
                    { query },
                    client.user
                );

            if (
                !result?.tracks?.length
            ) {

                console.warn(
                    '[Play] Tidak ada hasil:',
                    query
                );

                return res.redirect('/');
            }

            /*
             * Untuk playlist/search,
             * tambahkan track pertama.
             */

            const track =
                result.tracks[0];

            player.queue.add(track);

            rememberTrack(track);

            console.log(
                '[Play]',
                getTrackTitle(track)
            );

            /*
             * Kalau tidak sedang playing,
             * langsung mulai.
             */

            if (
                !player.playing &&
                !player.paused
            ) {
                await player.play();
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
    async (req, res) => {

        const player =
            getCurrentPlayer();

        if (player) {

            try {

                if (
                    typeof player.pause ===
                    'function'
                ) {
                    await player.pause();
                }

            } catch (error) {

                console.error(
                    '[Pause Error]:',
                    error?.message || error
                );
            }
        }

        res.redirect('/');
    }
);

/* =========================================================
   RESUME
========================================================= */

app.post(
    '/api/resume',
    async (req, res) => {

        const player =
            getCurrentPlayer();

        if (player) {

            try {

                if (
                    typeof player.resume ===
                    'function'
                ) {
                    await player.resume();
                }

            } catch (error) {

                console.error(
                    '[Resume Error]:',
                    error?.message || error
                );
            }
        }

        res.redirect('/');
    }
);

/* =========================================================
   SKIP
========================================================= */

app.post(
    '/api/skip',
    async (req, res) => {

        const player =
            getCurrentPlayer();

        if (!player) {
            return res.redirect('/');
        }

        if (manualSkipInProgress) {
            return res.redirect('/');
        }

        /*
         * Kalau Stop sedang berlangsung,
         * Skip tidak boleh mengganggu.
         */

        if (manualStopInProgress) {
            return res.redirect('/');
        }

        manualSkipInProgress = true;

        try {

            const current =
                player.queue?.current;

            if (!current) {
                return res.redirect('/');
            }

            /*
             * Ada queue:
             * Lavalink akan memainkan next.
             */

            if (
                player.queue?.tracks?.length > 0
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
             * Autoplay ON:
             * cari rekomendasi berikutnya.
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

            /*
             * Pastikan Stop tidak terjadi
             * ketika search sedang berjalan.
             */

            if (manualStopInProgress) {
                return res.redirect('/');
            }

            rememberTrack(next);

            player.queue.add(next);

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
    async (req, res) => {

        const player =
            getCurrentPlayer();

        if (player) {

            await stopPlayer(
                player
            );

        } else {

            /*
             * Tidak ada player,
             * tetap bersihkan state autoplay.
             */

            manualStopInProgress = true;

            autoplayActionInProgress = false;
            manualSkipInProgress = false;

            setTimeout(
                () => {
                    manualStopInProgress =
                        false;
                },
                1000
            );
        }

        /*
         * TIDAK memanggil leaveChannel().
         *
         * User tetap berada di Voice Channel.
         */

        res.redirect('/');
    }
);

/* =========================================================
   VOLUME
========================================================= */

app.post(
    '/api/volume',
    async (req, res) => {

        const player =
            getCurrentPlayer();

        if (!player) {

            return res.status(400)
                .json({
                    success: false,
                    message:
                        'Player belum terhubung.'
                });
        }

        const requestedVolume =
            req.body?.volume;

        const success =
            await setPlayerVolume(
                player,
                requestedVolume
            );

        if (!success) {

            return res.status(400)
                .json({
                    success: false,
                    volume:
                        getPlayerVolume(
                            player
                        )
                });
        }

        /*
         * Untuk form POST,
         * redirect kembali ke dashboard.
         *
         * Untuk AJAX/JSON,
         * kirim JSON.
         */

        if (
            req.is('application/json')
        ) {
            return res.json({
                success: true,
                volume
            });
        }

        return res.redirect('/');
    }
);

/* =========================================================
   LOOP TRACK
========================================================= */

app.post(
    '/api/loop-track',
    (req, res) => {

        /*
         * Track -> Off
         * Off -> Track
         *
         * Kalau Queue sedang aktif,
         * matikan Queue terlebih dahulu.
         */

        repeatMode =
            repeatMode === 'track'
                ? 'off'
                : 'track';

        console.log(
            '[Repeat]',
            repeatMode
        );

        res.redirect('/');
    }
);

/* =========================================================
   LOOP QUEUE
========================================================= */

app.post(
    '/api/loop-queue',
    (req, res) => {

        repeatMode =
            repeatMode === 'queue'
                ? 'off'
                : 'queue';

        console.log(
            '[Repeat]',
            repeatMode
        );

        res.redirect('/');
    }
);

/* =========================================================
   TOGGLE AUTOPLAY
========================================================= */

app.post(
    '/api/toggle-autoplay',
    (req, res) => {

        isAutoplayEnabled =
            !isAutoplayEnabled;

        console.log(
            '[Autoplay]',
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
    (req, res) => {

        const player =
            getCurrentPlayer();

        const index =
            Number.parseInt(
                req.body?.index,
                10
            );

        if (
            player &&
            Number.isInteger(index) &&
            player.queue?.tracks?.[index]
        ) {

            const removed =
                player.queue.tracks.splice(
                    index,
                    1
                )[0];

            console.log(
                '[Queue] Removed:',
                getTrackTitle(
                    removed
                )
            );
        }

        res.redirect('/');
    }
);

/* =========================================================
   FALLBACK
========================================================= */

app.get(
    '*',
    (req, res) => {
        res.send(
            renderDashboard()
        );
    }
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
         * Lavalink membutuhkan Discord user ID
         * sebagai client ID.
         */

        lavalink.options.client.id =
            client.user.id;

        lavalink.options.client.username =
            client.user.username ||
            'Botave';

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
            'Web Controller berjalan di port',
            PORT
        );
    }
);

/* =========================================================
   LOGIN
========================================================= */

client.login(TOKEN);
