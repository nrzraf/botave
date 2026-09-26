const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

// ============================================================
// DISCORD SETTINGS PATCH
// ============================================================

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

// ============================================================
// EXPRESS + DISCORD
// ============================================================

const app = express();

const client = new Client({
    checkUpdate: false
});

// ============================================================
// ENVIRONMENT
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;

// Railway memberikan PORT.
// Local/default = 3000.
const PORT = Number(process.env.PORT || 3000);

// ============================================================
// LAVALINK CONFIG
// ============================================================
//
// Kalau LAVALINK_HOST tidak dibuat di Railway,
// default diarahkan ke private Railway hostname.
//
// SERVICE LAVALINK HARUS bernama "Lavalink"
// jika ingin menggunakan default ini.
//

const LAVALINK_HOST =
    process.env.LAVALINK_HOST ||
    'lavalink.railway.internal';

const LAVALINK_PORT =
    Number(process.env.LAVALINK_PORT || 2333);

const LAVALINK_PASSWORD =
    process.env.LAVALINK_PASSWORD ||
    'youshallnotpass';

const LAVALINK_SECURE =
    String(
        process.env.LAVALINK_SECURE || 'false'
    ).toLowerCase() === 'true';

const LAVALINK_ID =
    process.env.LAVALINK_ID || 'main';

// ============================================================
// REQUIRED ENV
// ============================================================

if (!TOKEN) {
    console.error(
        'ERROR: DISCORD_TOKEN tidak ditemukan!'
    );

    process.exit(1);
}

// ============================================================
// CONFIG LOG
// ============================================================

console.log(
    '============================================================'
);

console.log(
    '[Config] Web Port      : ' + PORT
);

console.log(
    '[Config] Lavalink Host : ' + LAVALINK_HOST
);

console.log(
    '[Config] Lavalink Port : ' + LAVALINK_PORT
);

console.log(
    '[Config] Lavalink ID   : ' + LAVALINK_ID
);

console.log(
    '[Config] Lavalink SSL  : ' + LAVALINK_SECURE
);

console.log(
    '============================================================'
);

// ============================================================
// LAVALINK MANAGER
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

        const guild =
            client.guilds.cache.get(guildId);

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

lavalink.nodeManager.on(
    'error',
    (node, error) => {

        console.warn(
            '[Lavalink Error] Node ' +
            (
                node?.id ||
                node?.options?.host ||
                'unknown'
            ) +
            ':',
            error?.message || error
        );
    }
);

lavalink.nodeManager.on(
    'connect',
    node => {

        console.log(
            '[Lavalink] Connected: ' +
            (
                node?.id ||
                node?.options?.host ||
                'unknown'
            )
        );
    }
);

lavalink.nodeManager.on(
    'disconnect',
    (node, reason) => {

        console.warn(
            '[Lavalink] Disconnected: ' +
            (
                node?.id ||
                node?.options?.host ||
                'unknown'
            )
        );

        console.warn(
            '[Lavalink] Reason:',
            reason || ''
        );
    }
);

// ============================================================
// STATE
// ============================================================

let currentVoiceChannel = null;

let savedVoiceChannelId = '';

let isAutoplayEnabled = false;

let repeatMode = 'off';

let volume = 100;

let autoplayActionInProgress = false;

let manualSkipInProgress = false;

const autoplayHistory = new Set();

const MAX_HISTORY = 100;

// ============================================================
// PLAYER HELPERS
// ============================================================

function getCurrentPlayer() {

    if (!currentVoiceChannel) {
        return null;
    }

    return lavalink.getPlayer(
        currentVoiceChannel.guild.id
    );
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
        .replaceAll(
            "'",
            '&#039;'
        );
}

// ============================================================
// AUTOPLAY HISTORY
// ============================================================

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

// ============================================================
// AUTOPLAY SEARCH
// ============================================================

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
        return null;
    }

    const queries = [

        'ytsearch:' +
            artist +
            ' top tracks',

        'ytsearch:' +
            artist +
            ' popular songs',

        'ytsearch:' +
            artist +
            ' best songs',

        'ytsearch:' +
            artist
    ];

    for (const query of queries) {

        try {

            console.log(
                '[Autoplay] Search: ' +
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
                '[Autoplay] Selected: ' +
                getTrackTitle(selected)
            );

            return selected;

        } catch (err) {

            console.warn(
                '[Autoplay] Search failed:',
                err?.message || err
            );
        }
    }

    return null;
}

// ============================================================
// AUTOPLAY PLAY
// ============================================================

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
            player.queue.tracks.length > 0
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
            '[Autoplay] Playing: ' +
            getTrackTitle(next)
        );

        return true;

    } catch (err) {

        console.error(
            '[Autoplay Error]:',
            err?.message || err
        );

        return false;

    } finally {

        autoplayActionInProgress = false;
    }
}

// ============================================================
// TRACK END
// ============================================================

lavalink.on(
    'trackEnd',
    async (player, track) => {

        if (!track) {
            return;
        }

        console.log(
            '[Track End] ' +
            getTrackTitle(track)
        );

        // ----------------------------------------------------
        // LOOP TRACK
        // ----------------------------------------------------

        if (repeatMode === 'track') {

            try {

                await player.play({
                    track: track
                });

            } catch (err) {

                console.error(
                    '[Repeat Track Error]:',
                    err?.message || err
                );
            }

            return;
        }

        // ----------------------------------------------------
        // LOOP QUEUE
        // ----------------------------------------------------

        if (repeatMode === 'queue') {

            try {

                player.queue.add(track);

                if (
                    !player.playing &&
                    !player.paused
                ) {
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

        // ----------------------------------------------------
        // QUEUE STILL HAS SONGS
        // ----------------------------------------------------

        if (
            player.queue.tracks.length > 0
        ) {
            return;
        }

        // ----------------------------------------------------
        // AUTOPLAY
        // ----------------------------------------------------

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

// ============================================================
// DISCORD RAW → LAVALINK
// ============================================================

client.on(
    'raw',
    data => {

        lavalink.sendRawData(
            data
        );
    }
);

// ============================================================
// CONNECT VOICE
// ============================================================

async function connectToChannel(
    channelId
) {

    try {

        const channel =
            await client.channels.fetch(
                channelId
            );

        if (!channel?.isVoice()) {

            return {
                success: false,
                message:
                    'Bukan Voice Channel!'
            };
        }

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

                volume: volume
            });

        await player.connect();

        try {

            await player.setVolume(
                volume
            );

        } catch (err) {

            console.warn(
                '[Volume] Initial set failed:',
                err?.message || err
            );
        }

        currentVoiceChannel =
            channel;

        savedVoiceChannelId =
            channel.id;

        console.log(
            '[Voice] Connected: ' +
            channel.name
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
            message:
                err?.message ||
                'Unknown error'
        };
    }
}

// ============================================================
// LEAVE
// ============================================================

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
// STOP PLAYER
// ============================================================

async function stopPlayer(player) {

    if (!player) {
        return;
    }

    try {

        await player.stop();

    } catch (err) {

        try {

            if (
                player.queue
            ) {
                player.queue.clear();
            }

            await player.stop();

        } catch (_) {

            console.warn(
                '[Stop] Failed:',
                err?.message || err
            );
        }
    }
}

// ============================================================
// VOLUME
// ============================================================

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
        !Number.isFinite(newVolume)
    ) {
        return;
    }

    newVolume =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(newVolume)
            )
        );

    volume = newVolume;

    try {

        await player.setVolume(
            newVolume
        );

    } catch (err) {

        console.error(
            '[Volume Error]:',
            err?.message || err
        );
    }
}

// ============================================================
// API STATE
// ============================================================

app.get(
    '/api/state',
    (_, res) => {

        const player =
            getCurrentPlayer();

        const current =
            player?.queue?.current;

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

                        guild:
                            currentVoiceChannel
                                .guild
                                .name
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
                            current.info?.author ||
                            '',

                        identifier:
                            current.info?.identifier ||
                            ''
                    }
                    : null,

            queue:
                player?.queue?.tracks?.map(
                    (track, index) => ({
                        index,

                        title:
                            getTrackTitle(
                                track
                            ),

                        author:
                            track.info?.author ||
                            '',

                        identifier:
                            track.info?.identifier ||
                            ''
                    })
                ) || [],

            autoplay:
                isAutoplayEnabled,

            repeat:
                repeatMode,

            volume:
                getPlayerVolume(player)
        });
    }
);

// ============================================================
// DASHBOARD
// ============================================================

function renderDashboard() {

    const player =
        getCurrentPlayer();

    const currentTrack =
        player?.queue?.current;

    const queueTracks =
        player?.queue?.tracks || [];

    const currentTitle =
        currentTrack
            ? getTrackTitle(
                currentTrack
            )
            : 'Tidak ada lagu';

    const currentAuthor =
        currentTrack?.info?.author ||
        '';

    const currentVolume =
        getPlayerVolume(player);

    const voiceName =
        currentVoiceChannel
            ? escapeHtml(
                currentVoiceChannel.name
            )
            : 'Belum terhubung';

    const guildName =
        currentVoiceChannel
            ? escapeHtml(
                currentVoiceChannel.guild.name
            )
            : '';

    const queueHtml =
        queueTracks.length
            ? queueTracks.map(
                (track, index) => `

                    <div class="queue-item">

                        <div class="queue-number">
                            ${index + 1}
                        </div>

                        <div class="queue-info">

                            <div class="queue-title">
                                ${escapeHtml(
                                    getTrackTitle(track)
                                )}
                            </div>

                            <div class="queue-author">
                                ${escapeHtml(
                                    track.info?.author || ''
                                )}
                            </div>

                        </div>

                        <form
                            action="/api/delete-queue-item"
                            method="POST"
                        >

                            <input
                                type="hidden"
                                name="index"
                                value="${index}"
                            >

                            <button
                                class="delete-btn"
                                type="submit"
                            >
                                ×
                            </button>

                        </form>

                    </div>

                `
            ).join('')
            : `

                <div class="empty-queue">
                    Antrean kosong
                </div>

            `;

    return `<!DOCTYPE html>

<html lang="id">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>Botave Music Controller</title>

<style>

* {
    box-sizing: border-box;
}

body {

    margin: 0;

    padding: 24px;

    min-height: 100vh;

    font-family:
        Inter,
        Arial,
        sans-serif;

    background:
        #0b0d12;

    color:
        #f5f5f5;
}

.container {

    width: 100%;

    max-width: 720px;

    margin: auto;
}

.card {

    background:
        #151821;

    border:
        1px solid #272b38;

    border-radius:
        16px;

    padding:
        20px;

    margin-bottom:
        16px;

    box-shadow:
        0 8px 30px
        rgba(0,0,0,.2);
}

.header {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        12px;

    margin-bottom:
        18px;
}

.header h1 {

    margin: 0;

    font-size:
        24px;
}

.badge {

    background:
        ${
            currentVoiceChannel
                ? '#23c55e'
                : '#ef4444'
        };

    color:
        #fff;

    border-radius:
        999px;

    padding:
        6px 10px;

    font-size:
        12px;

    font-weight:
        700;
}

h2 {

    margin:
        0 0 14px;

    font-size:
        18px;
}

label {

    display:
        block;

    margin-bottom:
        7px;

    color:
        #aeb4c2;

    font-size:
        13px;
}

input[type="text"],
input[type="number"] {

    width:
        100%;

    padding:
        12px 14px;

    background:
        #0f1219;

    color:
        #fff;

    border:
        1px solid #303646;

    border-radius:
        10px;

    outline:
        none;

    font-size:
        14px;
}

input:focus {

    border-color:
        #5865f2;
}

button {

    border:
        0;

    border-radius:
        10px;

    padding:
        11px 14px;

    background:
        #5865f2;

    color:
        #fff;

    font-weight:
        700;

    cursor:
        pointer;

    transition:
        .15s;
}

button:hover {

    filter:
        brightness(1.1);
}

button.secondary {

    background:
        #272c39;
}

button.danger {

    background:
        #ef4444;
}

button.success {

    background:
        #22c55e;

    color:
        #07110a;
}

button.active {

    background:
        #22c55e;

    color:
        #07110a;
}

.form-row {

    display:
        flex;

    gap:
        8px;
}

.form-row input {

    flex:
        1;
}

.form-row button {

    width:
        auto;
}

.controls {

    display:
        grid;

    grid-template-columns:
        repeat(3, 1fr);

    gap:
        8px;

    margin-top:
        12px;
}

.controls form,
.two-controls form {

    margin:
        0;
}

.two-controls {

    display:
        grid;

    grid-template-columns:
        repeat(2, 1fr);

    gap:
        8px;

    margin-top:
        8px;
}

.now-playing {

    background:
        #0f1219;

    border:
        1px solid #282d3b;

    border-radius:
        12px;

    padding:
        15px;

    margin-bottom:
        14px;
}

.now-label {

    color:
        #8f96a6;

    font-size:
        12px;

    margin-bottom:
        5px;
}

.now-title {

    font-size:
        17px;

    font-weight:
        700;

    word-break:
        break-word;
}

.now-author {

    color:
        #9da4b3;

    font-size:
        13px;

    margin-top:
        5px;
}

.range-wrap {

    margin-top:
        16px;
}

.range-wrap input {

    width:
        100%;
}

.range-label {

    display:
        flex;

    justify-content:
        space-between;

    color:
        #aeb4c2;

    font-size:
        13px;
}

.queue {

    display:
        flex;

    flex-direction:
        column;

    gap:
        7px;
}

.queue-item {

    display:
        flex;

    align-items:
        center;

    gap:
        10px;

    padding:
        10px;

    border-radius:
        10px;

    background:
        #0f1219;
}

.queue-number {

    width:
        25px;

    text-align:
        center;

    color:
        #7e8595;

    font-size:
        12px;
}

.queue-info {

    flex:
        1;

    min-width:
        0;
}

.queue-title {

    overflow:
        hidden;

    text-overflow:
        ellipsis;

    white-space:
        nowrap;

    font-size:
        14px;

    font-weight:
        600;
}

.queue-author {

    overflow:
        hidden;

    text-overflow:
        ellipsis;

    white-space:
        nowrap;

    color:
        #858c9b;

    font-size:
        12px;

    margin-top:
        3px;
}

.delete-btn {

    background:
        transparent;

    color:
        #ef4444;

    font-size:
        22px;

    padding:
        2px 8px;
}

.status-line {

    color:
        #9ba2b1;

    font-size:
        13px;

    margin-bottom:
        12px;
}

.empty-queue {

    color:
        #777f8e;

    text-align:
        center;

    padding:
        20px;
}

@media(max-width:520px) {

    body {
        padding: 12px;
    }

    .card {
        padding: 15px;
    }

    .controls {
        grid-template-columns:
            1fr 1fr 1fr;
    }

    .form-row {
        flex-direction:
            column;
    }

    .form-row button {
        width:
            100%;
    }
}

</style>

</head>

<body>

<div class="container">

    <div class="header">

        <h1>
            🎵 Botave
        </h1>

        <div class="badge">

            ${
                currentVoiceChannel
                    ? 'CONNECTED'
                    : 'OFFLINE'
            }

        </div>

    </div>

    <!-- ================================================= -->
    <!-- VOICE -->
    <!-- ================================================= -->

    <div class="card">

        <h2>
            Voice Channel
        </h2>

        <div class="status-line">

            ${
                currentVoiceChannel
                    ? `${voiceName} · ${guildName}`
                    : 'Belum terhubung ke voice channel'
            }

        </div>

        <form
            action="/api/connect"
            method="POST"
        >

            <label>
                Voice Channel ID
            </label>

            <div class="form-row">

                <input
                    type="text"
                    name="channelId"
                    value="${escapeHtml(
                        savedVoiceChannelId
                    )}"
                    placeholder="Masukkan Voice Channel ID"
                    required
                >

                <button
                    type="submit"
                >
                    Connect
                </button>

            </div>

        </form>

        ${
            currentVoiceChannel
                ? `

                    <form
                        action="/api/leave"
                        method="POST"
                        style="margin-top:8px"
                    >

                        <button
                            type="submit"
                            class="danger"
                        >
                            Leave Voice
                        </button>

                    </form>

                `
                : ''
        }

    </div>

    <!-- ================================================= -->
    <!-- MUSIC -->
    <!-- ================================================= -->

    <div class="card">

        <h2>
            Music Player
        </h2>

        <div class="now-playing">

            <div class="now-label">
                NOW PLAYING
            </div>

            <div class="now-title">
                ${escapeHtml(
                    currentTitle
                )}
            </div>

            ${
                currentAuthor
                    ? `
                        <div class="now-author">
                            ${escapeHtml(
                                currentAuthor
                            )}
                        </div>
                    `
                    : ''
            }

        </div>

        <form
            action="/api/play"
            method="POST"
        >

            <label>
                Search / URL
            </label>

            <div class="form-row">

                <input
                    type="text"
                    name="query"
                    placeholder="YouTube URL atau judul lagu..."
                    required
                >

                <button
                    type="submit"
                >
                    Play
                </button>

            </div>

        </form>

        <div class="controls">

            <form
                action="/api/pause"
                method="POST"
            >

                <button
                    type="submit"
                    class="secondary"
                >
                    ⏸ Pause
                </button>

            </form>

            <form
                action="/api/resume"
                method="POST"
            >

                <button
                    type="submit"
                    class="secondary"
                >
                    ▶ Resume
                </button>

            </form>

            <form
                action="/api/skip"
                method="POST"
            >

                <button
                    type="submit"
                    class="secondary"
                >
                    ⏭ Skip
                </button>

            </form>

        </div>

        <div class="two-controls">

            <form
                action="/api/stop"
                method="POST"
            >

                <button
                    type="submit"
                    class="danger"
                >
                    ⏹ Stop
                </button>

            </form>

            <form
                action="/api/toggle-autoplay"
                method="POST"
            >

                <button
                    type="submit"
                    class="${
                        isAutoplayEnabled
                            ? 'active'
                            : 'secondary'
                    }"
                >
                    🤖 Autoplay:
                    ${
                        isAutoplayEnabled
                            ? 'ON'
                            : 'OFF'
                    }
                </button>

            </form>

        </div>

        <div class="two-controls">

            <form
                action="/api/loop-track"
                method="POST"
            >

                <button
                    type="submit"
                    class="${
                        repeatMode === 'track'
                            ? 'active'
                            : 'secondary'
                    }"
                >
                    🔂 Track
                </button>

            </form>

            <form
                action="/api/loop-queue"
                method="POST"
            >

                <button
                    type="submit"
                    class="${
                        repeatMode === 'queue'
                            ? 'active'
                            : 'secondary'
                    }"
                >
                    🔁 Queue
                </button>

            </form>

        </div>

        <div class="range-wrap">

            <div class="range-label">

                <span>
                    Volume
                </span>

                <span>
                    ${currentVolume}%
                </span>

            </div>

            <form
                action="/api/volume"
                method="POST"
            >

                <input
                    type="range"
                    name="volume"
                    min="0"
                    max="100"
                    value="${currentVolume}"
                    onchange="this.form.submit()"
                >

            </form>

        </div>

    </div>

    <!-- ================================================= -->
    <!-- QUEUE -->
    <!-- ================================================= -->

    <div class="card">

        <h2>
            Antrean
        </h2>

        <div class="queue">

            ${queueHtml}

        </div>

    </div>

</div>

</body>

</html>`;
}

// ============================================================
// EXPRESS MIDDLEWARE
// ============================================================

app.use(
    express.json()
);

app.use(
    express.urlencoded({
        extended: true
    })
);

// ============================================================
// FAVICON
// ============================================================

app.get(
    '/favicon.ico',
    (_, res) =>
        res.status(204).end()
);

// ============================================================
// HOME
// ============================================================

app.get(
    '/',
    (_, res) =>
        res.send(
            renderDashboard()
        )
);

// ============================================================
// CONNECT
// ============================================================

app.post(
    '/api/connect',
    async (req, res) => {

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
                    {
                        query
                    },
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
                    '[Play] ' +
                    getTrackTitle(track)
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
            getCurrentPlayer();

        if (player) {

            try {
                await player.pause();
            } catch (err) {

                console.error(
                    '[Pause Error]:',
                    err?.message || err
                );
            }
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
            getCurrentPlayer();

        if (player) {

            try {
                await player.resume();
            } catch (err) {

                console.error(
                    '[Resume Error]:',
                    err?.message || err
                );
            }
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
            getCurrentPlayer();

        if (!player) {
            return res.redirect('/');
        }

        if (manualSkipInProgress) {
            return res.redirect('/');
        }

        manualSkipInProgress = true;

        try {

            const current =
                player.queue.current;

            if (!current) {
                return res.redirect('/');
            }

            if (
                player.queue.tracks.length > 0
            ) {

                console.log(
                    '[Skip] Next queue track.'
                );

                await player.skip();

                return res.redirect('/');
            }

            if (!isAutoplayEnabled) {

                console.log(
                    '[Skip] Queue kosong + autoplay OFF.'
                );

                await stopPlayer(
                    player
                );

                return res.redirect('/');
            }

            console.log(
                '[Skip] Searching autoplay next after: ' +
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
                '[Skip] Autoplay Next: ' +
                getTrackTitle(next)
            );

            await player.skip();

        } catch (err) {

            console.error(
                '[Skip Error]:',
                err?.message || err
            );

        } finally {

            setTimeout(
                () => {
                    manualSkipInProgress = false;
                },
                300
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// STOP
// ============================================================

app.post(
    '/api/stop',
    async (_, res) => {

        const player =
            getCurrentPlayer();

        if (player) {

            try {

                await stopPlayer(
                    player
                );

            } catch (err) {

                console.error(
                    '[Stop Error]:',
                    err?.message || err
                );
            }
        }

        res.redirect('/');
    }
);

// ============================================================
// VOLUME
// ============================================================

app.post(
    '/api/volume',
    async (req, res) => {

        const player =
            getCurrentPlayer();

        if (player) {

            await setPlayerVolume(
                player,
                req.body.volume
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
    (_, res) => {

        if (
            repeatMode === 'track'
        ) {

            repeatMode = 'off';

        } else {

            repeatMode = 'track';
        }

        console.log(
            '[Repeat] ' +
            repeatMode
        );

        res.redirect('/');
    }
);

// ============================================================
// LOOP QUEUE
// ============================================================

app.post(
    '/api/loop-queue',
    (_, res) => {

        if (
            repeatMode === 'queue'
        ) {

            repeatMode = 'off';

        } else {

            repeatMode = 'queue';
        }

        console.log(
            '[Repeat] ' +
            repeatMode
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
            '[Autoplay] ' +
            (
                isAutoplayEnabled
                    ? 'ON'
                    : 'OFF'
            )
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
            getCurrentPlayer();

        const index =
            Number.parseInt(
                req.body.index,
                10
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
                '[Queue] Removed: ' +
                getTrackTitle(removed)
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
        res.send(
            renderDashboard()
        )
);

// ============================================================
// DISCORD READY
// ============================================================

client.on(
    'ready',
    async () => {

        console.log(
            'Logged in as ' +
            client.user.tag
        );

        // Update Lavalink client ID
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
// PROCESS ERROR HANDLERS
// ============================================================

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
    err => {

        console.warn(
            '[Uncaught Exception]',
            err?.message || err
        );
    }
);

// ============================================================
// RAILWAY WEB SERVER
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            'Web Controller berjalan di port ' +
            PORT
        );
    }
);

// ============================================================
// DISCORD LOGIN
// ============================================================

client.login(
    TOKEN
);
