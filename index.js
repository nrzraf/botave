```js
const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { LavalinkManager } = require('lavalink-client');

// ============================================================
// PATCH FRIEND SOURCE FLAGS NULL ERROR
// ============================================================

const ClientUserSettingManager =
    require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');

const originalPatch =
    ClientUserSettingManager.prototype._patch;

ClientUserSettingManager.prototype._patch = function (data) {
    if (data && data.friend_source_flags === null) {
        data.friend_source_flags = {
            all: false,
            mutual_friends: false,
            mutual_guilds: false
        };
    }

    return originalPatch.call(this, data);
};

// ============================================================
// EXPRESS + DISCORD CLIENT
// ============================================================

const app = express();

const client = new Client({
    checkUpdate: false
});

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error(
        'ERROR: DISCORD_TOKEN tidak ditemukan di Environment Variables!'
    );

    process.exit(1);
}

// ============================================================
// LAVALINK MANAGER
// ============================================================

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
        `[Lavalink Error] Node ${node.id || node.options.host}:`,
        error.message || error
    );
});

lavalink.nodeManager.on('connect', (node) => {
    console.log(
        `[Lavalink Connected] Berhasil terhubung ke Node: ${
            node.id || node.options.host
        }`
    );
});

lavalink.nodeManager.on('disconnect', (node, reason) => {
    console.warn(
        `[Lavalink Disconnected] Terputus dari Node ${
            node.id || node.options.host
        }. Alasan:`,
        reason
    );
});

// ============================================================
// GLOBAL STATE
// ============================================================

let savedVoiceChannelId = '';
let currentVoiceChannel = null;

let isAutoplayEnabled = false;

// Repeat:
// 'off'
// 'track'
// 'queue'
let repeatMode = 'off';

// ============================================================
// AUTOPLAY HISTORY
// ============================================================

// Menyimpan identifier lagu yang sudah dimainkan
// melalui autoplay agar tidak cepat mengulang.
const autoplayHistory = new Set();

// Maksimum history agar Set tidak terus membesar.
const MAX_AUTOPLAY_HISTORY = 100;

// ============================================================
// AUTOPLAY HISTORY HELPER
// ============================================================

function addToAutoplayHistory(track) {
    if (!track?.info?.identifier) {
        return;
    }

    autoplayHistory.add(track.info.identifier);

    // Batasi jumlah history
    if (autoplayHistory.size > MAX_AUTOPLAY_HISTORY) {
        const firstItem = autoplayHistory.values().next().value;

        if (firstItem) {
            autoplayHistory.delete(firstItem);
        }
    }
}

// ============================================================
// AUTOPLAY SEARCH
// ============================================================

async function getAutoplayTrack(player, previousTrack) {
    if (!player || !previousTrack) {
        return null;
    }

    try {
        const artistName =
            previousTrack.info?.author?.trim();

        const previousIdentifier =
            previousTrack.info?.identifier;

        if (!artistName) {
            console.log(
                '[Autoplay] Artist tidak ditemukan.'
            );

            return null;
        }

        console.log(
            `[Autoplay] Mencari rekomendasi dari artis: ${artistName}`
        );

        // Beberapa query supaya search tidak hanya bergantung
        // pada satu jenis hasil.
        const searchQueries = [
            `ytsearch:${artistName} top tracks`,
            `ytsearch:${artistName} popular songs`,
            `ytsearch:${artistName} best songs`,
            `ytsearch:${artistName}`
        ];

        for (const query of searchQueries) {
            console.log(
                `[Autoplay] Search: ${query}`
            );

            let result;

            try {
                result = await player.search(
                    { query },
                    client.user
                );
            } catch (searchError) {
                console.warn(
                    `[Autoplay] Search gagal: ${searchError.message}`
                );

                continue;
            }

            if (
                !result ||
                !result.tracks ||
                result.tracks.length === 0
            ) {
                continue;
            }

            // ====================================================
            // FILTER
            // ====================================================

            const candidates = result.tracks.filter(track => {
                const identifier =
                    track.info?.identifier;

                if (!identifier) {
                    return false;
                }

                // Jangan pilih lagu yang sedang/baru selesai
                if (
                    previousIdentifier &&
                    identifier === previousIdentifier
                ) {
                    return false;
                }

                // Jangan pilih lagu yang sudah ada di history
                if (
                    autoplayHistory.has(identifier)
                ) {
                    return false;
                }

                return true;
            });

            if (candidates.length === 0) {
                continue;
            }

            // ====================================================
            // RANDOM TOP 5
            // ====================================================

            const pool =
                candidates.slice(0, 5);

            const randomIndex =
                Math.floor(
                    Math.random() * pool.length
                );

            const selected =
                pool[randomIndex];

            console.log(
                `[Autoplay] Dipilih: ${selected.info.title}`
            );

            return selected;
        }

        // ========================================================
        // FALLBACK
        // ========================================================

        // Kalau semua hasil sudah ada di history,
        // kita cari lagi tanpa filter history.
        console.log(
            '[Autoplay] Semua kandidat sudah pernah dimainkan. Menggunakan fallback.'
        );

        for (const query of searchQueries) {
            try {
                const result =
                    await player.search(
                        { query },
                        client.user
                    );

                if (
                    !result ||
                    !result.tracks ||
                    result.tracks.length === 0
                ) {
                    continue;
                }

                const candidates =
                    result.tracks.filter(track => {
                        const identifier =
                            track.info?.identifier;

                        return (
                            identifier &&
                            identifier !== previousIdentifier
                        );
                    });

                if (candidates.length === 0) {
                    continue;
                }

                const pool =
                    candidates.slice(0, 5);

                const randomIndex =
                    Math.floor(
                        Math.random() * pool.length
                    );

                const selected =
                    pool[randomIndex];

                console.log(
                    `[Autoplay] Fallback memilih: ${selected.info.title}`
                );

                return selected;
            } catch (err) {
                console.warn(
                    `[Autoplay] Fallback search gagal: ${err.message}`
                );
            }
        }

        console.log(
            '[Autoplay] Tidak menemukan lagu rekomendasi.'
        );

        return null;

    } catch (err) {
        console.error(
            '[Autoplay Error]:',
            err.message
        );

        return null;
    }
}

// ============================================================
// PLAY AUTOPLAY NEXT
// ============================================================

async function playAutoplayNext(player, previousTrack) {
    if (!player || !previousTrack) {
        return false;
    }

    if (!isAutoplayEnabled) {
        return false;
    }

    if (repeatMode !== 'off') {
        return false;
    }

    // Jangan autoplay kalau ternyata queue sudah diisi
    if (player.queue.tracks.length > 0) {
        console.log(
            '[Autoplay] Queue tidak kosong, autoplay dilewati.'
        );

        return false;
    }

    const recommendedTrack =
        await getAutoplayTrack(
            player,
            previousTrack
        );

    if (!recommendedTrack) {
        console.log(
            '[Autoplay] Tidak ada rekomendasi.'
        );

        return false;
    }

    // Tambahkan ke history
    addToAutoplayHistory(
        recommendedTrack
    );

    // Masukkan ke queue
    player.queue.add(
        recommendedTrack
    );

    console.log(
        `[Autoplay] Queue +1: ${recommendedTrack.info.title}`
    );

    try {
        await player.play();

        console.log(
            `[Autoplay] ▶ Sekarang memainkan: ${recommendedTrack.info.title}`
        );

        return true;

    } catch (err) {
        console.error(
            '[Autoplay] Gagal play:',
            err.message
        );

        return false;
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
            `[Track End] Selesai: ${track.info?.title || 'Unknown'}`
        );

        // ====================================================
        // LOOP TRACK
        // ====================================================

        if (repeatMode === 'track') {
            console.log(
                `[Loop Track] Memutar ulang: ${track.info.title}`
            );

            player.queue.add(track);

            await player.play();

            return;
        }

        // ====================================================
        // LOOP QUEUE
        // ====================================================

        if (repeatMode === 'queue') {
            console.log(
                `[Loop Queue] Menambahkan kembali: ${track.info.title}`
            );

            player.queue.add(track);

            // Kalau queue sebelumnya kosong,
            // langsung play lagi.
            if (
                !player.playing &&
                !player.paused
            ) {
                await player.play();
            }

            return;
        }

        // ====================================================
        // NORMAL + QUEUE MASIH ADA
        // ====================================================

        if (player.queue.tracks.length > 0) {
            console.log(
                `[Track End] Queue masih memiliki ${
                    player.queue.tracks.length
                } lagu.`
            );

            return;
        }

        // ====================================================
        // AUTOPLAY
        // ====================================================

        if (isAutoplayEnabled) {
            console.log(
                '[Track End] Queue kosong. Menjalankan autoplay.'
            );

            await playAutoplayNext(
                player,
                track
            );

            return;
        }

        console.log(
            '[Track End] Queue kosong dan autoplay OFF.'
        );
    }
);

// ============================================================
// DISCORD RAW DATA
// ============================================================

client.on('raw', (d) => {
    lavalink.sendRawData(d);
});

// ============================================================
// CONNECT VOICE CHANNEL
// ============================================================

async function connectToChannel(channelId) {
    try {
        const channel =
            await client.channels.fetch(channelId);

        if (
            !channel ||
            !channel.isVoice()
        ) {
            return {
                success: false,
                message:
                    'Channel tidak ditemukan atau bukan Voice Channel!'
            };
        }

        let player =
            lavalink.getPlayer(
                channel.guild.id
            );

        // Hapus player lama
        if (player) {
            try {
                await player.disconnect();
                await player.destroy();
            } catch (e) {
                console.log(
                    'Error membersihkan player lama:',
                    e.message
                );
            }
        }

        // Buat player baru
        player =
            await lavalink.createPlayer({
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
            `Lavalink terhubung ke VC: ${channel.name} (${channel.guild.name})`
        );

        return {
            success: true
        };

    } catch (err) {
        console.error(
            'Gagal koneksi Voice:',
            err.message
        );

        return {
            success: false,
            message: err.message
        };
    }
}

// ============================================================
// LEAVE CHANNEL
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
            await player.disconnect();
            await player.destroy();
        }

        console.log(
            `Bot keluar dari Voice Channel: ${currentVoiceChannel.name}`
        );

    } catch (err) {
        console.error(
            'Gagal keluar dari Voice Channel:',
            err.message
        );

    } finally {
        currentVoiceChannel = null;
        savedVoiceChannelId = '';

        autoplayHistory.clear();
    }
}

// ============================================================
// EXPRESS MIDDLEWARE
// ============================================================

app.use(express.json());
app.use(
    express.urlencoded({
        extended: true
    })
);

app.get(
    '/favicon.ico',
    (req, res) =>
        res.status(204).end()
);

// ============================================================
// DASHBOARD
// ============================================================

function renderDashboard() {

    const player =
        currentVoiceChannel
            ? lavalink.getPlayer(
                currentVoiceChannel.guild.id
            )
            : null;

    const currentTrack =
        player &&
        player.queue.current
            ? player.queue.current.info.title
            : 'Tidak ada';

    // ========================================================
    // QUEUE LIST
    // ========================================================

    let queueList = '';

    if (
        player &&
        player.queue.tracks.length > 0
    ) {
        queueList =
            player.queue.tracks
                .map((song, i) => `
                    <li style="
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 8px;
                    ">
                        <span style="
                            overflow: hidden;
                            text-overflow: ellipsis;
                            white-space: nowrap;
                            max-width: 320px;
                        ">
                            ${i + 1}. ${song.info.title}
                        </span>

                        <form
                            action="/api/delete-queue-item"
                            method="POST"
                            style="margin:0;"
                        >
                            <input
                                type="hidden"
                                name="index"
                                value="${i}"
                            />

                            <button
                                type="submit"
                                class="danger"
                                style="
                                    padding: 4px 10px;
                                    margin: 0;
                                    font-size: 12px;
                                    width: auto;
                                "
                            >
                                X
                            </button>
                        </form>
                    </li>
                `)
                .join('');
    }

    // ========================================================
    // HTML
    // ========================================================

    return `
        <!DOCTYPE html>

        <html>

        <head>

            <title>
                Voicecord Controller
            </title>

            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            >

            <style>

                body {
                    font-family:
                        -apple-system,
                        BlinkMacSystemFont,
                        "Segoe UI",
                        Roboto,
                        sans-serif;

                    background: #0f1015;
                    color: #e1e1e6;

                    padding: 20px;

                    max-width: 480px;

                    margin: auto;
                }

                .card {
                    background: #181920;

                    padding: 18px;

                    border-radius: 12px;

                    margin-bottom: 16px;

                    border: 1px solid #282a36;
                }

                h2,
                h3 {
                    margin-top: 0;
                    color: #fff;
                }

                input,
                button {
                    padding: 12px;

                    margin: 6px 0;

                    width: 100%;

                    box-sizing: border-box;

                    border-radius: 8px;

                    border: none;

                    font-size: 14px;
                }

                input {
                    background: #222431;
                    color: #fff;

                    border: 1px solid #323546;
                }

                input:focus {
                    border-color: #5865F2;
                    outline: none;
                }

                button {
                    background: #5865F2;

                    color: #fff;

                    font-weight: bold;

                    cursor: pointer;

                    transition: 0.2s;
                }

                button:hover {
                    opacity: 0.9;
                }

                button.alt {
                    background: #2b2d3c;
                }

                button.danger {
                    background: #ed4245;
                }

                button.active {
                    background: #57F287;
                    color: #000;
                }

                ol {
                    padding-left: 0;

                    list-style: none;

                    margin: 0;
                }

            </style>

        </head>

        <body>

            <h2>
                Voicecord Controller
            </h2>

            <!-- ================================================= -->
            <!-- VOICE CHANNEL -->
            <!-- ================================================= -->

            <div class="card">

                <h3>
                    Voice Channel Target
                </h3>

                <p
                    style="
                        font-size: 13px;
                        margin: 4px 0 12px 0;
                        color: #a0a0b0;
                    "
                >

                    Status VC:

                    <strong>

                        ${
                            currentVoiceChannel
                                ? `${currentVoiceChannel.name} (${currentVoiceChannel.guild.name})`
                                : '<span style="color:#ed4245;">Belum Terhubung</span>'
                        }

                    </strong>

                </p>

                <form
                    action="/api/connect"
                    method="POST"
                >

                    <input
                        type="text"
                        name="channelId"
                        placeholder="Masukkan Voice Channel ID"
                        value="${savedVoiceChannelId}"
                        required
                    />

                    <button
                        type="submit"
                        class="alt"
                    >
                        Set / Pindah Voice Channel
                    </button>

                </form>

                ${
                    currentVoiceChannel
                        ? `
                            <form
                                action="/api/leave"
                                method="POST"
                                style="margin-top: 4px;"
                            >

                                <button
                                    type="submit"
                                    class="danger"
                                >
                                    Leave Voice Channel
                                </button>

                            </form>
                        `
                        : ''
                }

            </div>

            <!-- ================================================= -->
            <!-- MUSIC PLAYER -->
            <!-- ================================================= -->

            <div class="card">

                <h3>
                    Music Player (Lavalink Engine)
                </h3>

                <p
                    style="
                        font-size: 13px;
                        margin-bottom: 12px;
                    "
                >

                    <strong>
                        Sedang Diputar:
                    </strong>

                    <br>

                    <span
                        style="
                            color: #5865F2;
                            font-weight: bold;
                        "
                    >
                        ${currentTrack}
                    </span>

                </p>

                <form
                    action="/api/play"
                    method="POST"
                >

                    <input
                        type="text"
                        name="query"
                        placeholder="Judul Lagu / Link YouTube / Spotify / SoundCloud"
                        required
                    />

                    <button
                        type="submit"
                    >
                        Play / Add Queue
                    </button>

                </form>

                <!-- PLAYBACK CONTROLS -->

                <div
                    style="
                        display: flex;
                        gap: 8px;
                        margin-top: 6px;
                    "
                >

                    <form
                        action="/api/pause"
                        method="POST"
                        style="flex:1;"
                    >

                        <button
                            type="submit"
                            class="alt"
                        >
                            Pause
                        </button>

                    </form>

                    <form
                        action="/api/resume"
                        method="POST"
                        style="flex:1;"
                    >

                        <button
                            type="submit"
                            class="alt"
                        >
                            Resume
                        </button>

                    </form>

                    <form
                        action="/api/skip"
                        method="POST"
                        style="flex:1;"
                    >

                        <button
                            type="submit"
                            class="alt"
                        >
                            Skip
                        </button>

                    </form>

                </div>

                <!-- LOOP CONTROLS -->

                <div
                    style="
                        display: flex;
                        gap: 8px;
                        margin-top: 6px;
                    "
                >

                    <form
                        action="/api/loop-track"
                        method="POST"
                        style="flex:1;"
                    >

                        <button
                            type="submit"
                            class="${
                                repeatMode === 'track'
                                    ? 'active'
                                    : 'alt'
                            }"
                        >

                            Loop Track:
                            ${
                                repeatMode === 'track'
                                    ? 'ON'
                                    : 'OFF'
                            }

                        </button>

                    </form>

                    <form
                        action="/api/loop-queue"
                        method="POST"
                        style="flex:1;"
                    >

                        <button
                            type="submit"
                            class="${
                                repeatMode === 'queue'
                                    ? 'active'
                                    : 'alt'
                            }"
                        >

                            Loop Queue:
                            ${
                                repeatMode === 'queue'
                                    ? 'ON'
                                    : 'OFF'
                            }

                        </button>

                    </form>

                </div>

                <!-- AUTOPLAY -->

                <form
                    action="/api/toggle-autoplay"
                    method="POST"
                    style="margin-top: 6px;"
                >

                    <button
                        type="submit"
                        class="${
                            isAutoplayEnabled
                                ? 'active'
                                : 'alt'
                        }"
                    >

                        Autoplay:
                        ${
                            isAutoplayEnabled
                                ? 'ON'
                                : 'OFF'
                        }

                    </button>

                </form>

            </div>

            <!-- ================================================= -->
            <!-- QUEUE -->
            <!-- ================================================= -->

            <div class="card">

                <h3>
                    Antrean Lagu
                </h3>

                <ol>

                    ${
                        queueList ||
                        '<li style="font-size:14px;">Antrean kosong</li>'
                    }

                </ol>

            </div>

        </body>

        </html>
    `;
}

// ============================================================
// DASHBOARD ROUTE
// ============================================================

app.get('/', (req, res) => {
    res.send(
        renderDashboard()
    );
});

// ============================================================
// CONNECT API
// ============================================================

app.post(
    '/api/connect',
    async (req, res) => {

        const { channelId } =
            req.body;

        if (channelId) {
            await connectToChannel(
                channelId.trim()
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// LEAVE API
// ============================================================

app.post(
    '/api/leave',
    async (req, res) => {

        await leaveChannel();

        res.redirect('/');
    }
);

// ============================================================
// PLAY API
// ============================================================

app.post(
    '/api/play',
    async (req, res) => {

        const { query } =
            req.body;

        if (!query) {
            return res.redirect('/');
        }

        if (!currentVoiceChannel) {
            return res.send(
                `
                    <script>
                        alert(
                            "Atur Voice Channel ID terlebih dahulu!"
                        );

                        window.location.href="/";
                    </script>
                `
            );
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

            const result =
                await player.search(
                    {
                        query: query.trim()
                    },
                    client.user
                );

            if (
                result &&
                result.tracks &&
                result.tracks.length > 0
            ) {

                const selectedTrack =
                    result.tracks[0];

                player.queue.add(
                    selectedTrack
                );

                console.log(
                    `Lavalink menambahkan lagu: ${selectedTrack.info.title}`
                );

                if (
                    !player.playing &&
                    !player.paused
                ) {
                    await player.play();
                }

            } else {

                console.log(
                    'Lagu tidak ditemukan via Lavalink.'
                );
            }

        } catch (e) {

            console.error(
                'Error Lavalink Play:',
                e.message
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
            `Mode Repeat diubah ke: ${repeatMode}`
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
            `Mode Repeat diubah ke: ${repeatMode}`
        );

        res.redirect('/');
    }
);

// ============================================================
// TOGGLE AUTOPLAY
// ============================================================

app.post(
    '/api/toggle-autoplay',
    (req, res) => {

        isAutoplayEnabled =
            !isAutoplayEnabled;

        console.log(
            `Autoplay status diubah menjadi: ${
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

        const { index } =
            req.body;

        if (
            currentVoiceChannel &&
            index !== undefined
        ) {

            const player =
                lavalink.getPlayer(
                    currentVoiceChannel.guild.id
                );

            const queueIndex =
                parseInt(index);

            if (
                player &&
                !Number.isNaN(queueIndex) &&
                player.queue.tracks.length >
                    queueIndex
            ) {

                const removedTrack =
                    player.queue.tracks.splice(
                        queueIndex,
                        1
                    );

                if (
                    removedTrack.length > 0
                ) {

                    console.log(
                        `Menghapus dari antrean: ${
                            removedTrack[0].info.title
                        }`
                    );
                }
            }
        }

        res.redirect('/');
    }
);

// ============================================================
// PAUSE
// ============================================================

app.post(
    '/api/pause',
    async (req, res) => {

        if (currentVoiceChannel) {

            const player =
                lavalink.getPlayer(
                    currentVoiceChannel.guild.id
                );

            if (player) {
                await player.pause();
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
    async (req, res) => {

        if (currentVoiceChannel) {

            const player =
                lavalink.getPlayer(
                    currentVoiceChannel.guild.id
                );

            if (player) {
                await player.resume();
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
    async (req, res) => {

        if (!currentVoiceChannel) {
            return res.redirect('/');
        }

        const player =
            lavalink.getPlayer(
                currentVoiceChannel.guild.id
            );

        if (!player) {
            return res.redirect('/');
        }

        try {

            const currentTrack =
                player.queue.current;

            if (!currentTrack) {

                console.log(
                    '[Skip] Tidak ada lagu yang sedang diputar.'
                );

                return res.redirect('/');
            }

            const queueHasNext =
                player.queue.tracks.length > 0;

            // ==================================================
            // QUEUE MASIH ADA
            // ==================================================

            if (queueHasNext) {

                console.log(
                    `[Skip] Queue memiliki ${
                        player.queue.tracks.length
                    } lagu.`
                );

                await player.skip();

                return res.redirect('/');
            }

            // ==================================================
            // QUEUE KOSONG + AUTOPLAY OFF
            // ==================================================

            if (!isAutoplayEnabled) {

                console.log(
                    '[Skip] Queue kosong + Autoplay OFF. Stop.'
                );

                await player.stop();

                return res.redirect('/');
            }

            // ==================================================
            // QUEUE KOSONG + AUTOPLAY ON
            // ==================================================

            console.log(
                `[Skip] Queue kosong. Mencari autoplay setelah: ${
                    currentTrack.info.title
                }`
            );

            const recommendedTrack =
                await getAutoplayTrack(
                    player,
                    currentTrack
                );

            if (!recommendedTrack) {

                console.log(
                    '[Skip] Tidak menemukan rekomendasi. Stop.'
                );

                await player.stop();

                return res.redirect('/');
            }

            // Tambahkan history
            addToAutoplayHistory(
                recommendedTrack
            );

            // Tambahkan rekomendasi ke queue
            player.queue.add(
                recommendedTrack
            );

            console.log(
                `[Skip] Autoplay berikutnya: ${
                    recommendedTrack.info.title
                }`
            );

            // Skip current menuju track baru
            await player.skip();

        } catch (err) {

            console.error(
                '[Skip Error]:',
                err.message
            );
        }

        res.redirect('/');
    }
);

// ============================================================
// FALLBACK ROUTE
// ============================================================

app.get(
    '*',
    (req, res) => {
        res.send(
            renderDashboard()
        );
    }
);

// ============================================================
// DISCORD READY
// ============================================================

client.on(
    'ready',
    async () => {

        console.log(
            `Logged in as ${client.user.tag}`
        );

        lavalink.options.client.id =
            client.user.id;

        await lavalink.init(
            client.user
        );
    }
);

// ============================================================
// GLOBAL ERROR GUARD
// ============================================================

process.on(
    'unhandledRejection',
    (reason) => {

        console.warn(
            'Unhandled Rejection Ignored:',
            reason
        );
    }
);

process.on(
    'uncaughtException',
    (err) => {

        console.warn(
            'Uncaught Exception Ignored:',
            err.message || err
        );
    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `Web Controller berjalan di port ${PORT}`
        );
    }
);

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
```
