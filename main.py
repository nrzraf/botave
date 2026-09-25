import os
import asyncio
import random
import discord
from discord.ext import commands, tasks
import yt_dlp

# --- PATCH UNTUK DISCORD.PY-SELF SUPPLEMENTARPAYMENTS NULL ERROR ---
def patched_parse_ready_supplemental(self, data):
    if not data:
        return
    pending_payments = data.get('pending_payments') or []
    self.pending_payments = {int(p['id']): p for p in pending_payments if isinstance(p, dict)}

discord.state.ConnectionState.parse_ready_supplemental = patched_parse_ready_supplemental

# Mengambil variabel dari Environment Variables
TOKEN = os.getenv("DISCORD_TOKEN")
SUPER_OWNER_ID = int(os.getenv("SUPER_OWNER", "0"))

if not TOKEN:
    print("ERROR: DISCORD_TOKEN tidak ditemukan di Environment Variables!")
    exit(1)

# Inisialisasi Self-Bot
bot = commands.Bot(command_prefix="ave", self_bot=True, help_command=None)

owners = {SUPER_OWNER_ID}
active_voice_channel_id = None

# Struktur Penyimpan Antrean & Status Per Server
# {guild_id: {'songs': [], 'loop_track': False, 'loop_queue': False, 'autoplay': False, 'current': None}}
guild_data = {}

# Konfigurasi yt-dlp & FFmpeg
YTDL_OPTIONS = {
    'format': 'bestaudio/best',
    'extractaudio': True,
    'audioformat': 'mp3',
    'outtmpl': '%(extractor)s-%(id)s-%(title)s.%(ext)s',
    'restrictfilenames': True,
    'noplaylist': True,
    'nocheckcertificate': True,
    'ignoreerrors': False,
    'logtostderr': False,
    'quiet': True,
    'no_warnings': True,
    'default_search': 'ytsearch',
    'source_address': '0.0.0.0'
}

FFMPEG_OPTIONS = {
    'before_options': '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5',
    'options': '-vn'
}

ytdl = yt_dlp.YoutubeDL(YTDL_OPTIONS)

class YTDLSource(discord.PCMVolumeTransformer):
    def __init__(self, source, *, data, volume=0.5):
        super().__init__(source, volume)
        self.data = data
        self.title = data.get('title')
        self.url = data.get('webpage_url') or data.get('url')

    @classmethod
    async def from_url(cls, url, *, loop=None, stream=True):
        loop = loop or asyncio.get_event_loop()
        
        # Jika kueri berupa teks pencarian biasa, gunakan pencarian YouTube
        if not url.startswith('http://') and not url.startswith('https://'):
            search_query = f"ytsearch:{url}"
        else:
            search_query = url

        data = await loop.run_in_executor(None, lambda: ytdl.extract_info(search_query, download=not stream))
        
        if 'entries' in data:
            if not data['entries']:
                raise Exception("Lagu tidak ditemukan.")
            data = data['entries'][0]

        filename = data['url'] if stream else ytdl.prepare_filename(data)
        return cls(discord.FFmpegPCMAudio(filename, **FFMPEG_OPTIONS), data=data)

def get_guild_settings(guild_id):
    if guild_id not in guild_data:
        guild_data[guild_id] = {
            'songs': [],
            'loop_track': False,
            'loop_queue': False,
            'autoplay': False,
            'current': None
        }
    return guild_data[guild_id]

# ==========================================
# AUTO REJOIN TASK (15 Detik Loop)
# ==========================================
@tasks.loop(seconds=15)
async def auto_rejoin_loop():
    global active_voice_channel_id
    if not active_voice_channel_id:
        return

    channel = bot.get_channel(active_voice_channel_id)
    if not channel:
        return

    voice_client = channel.guild.voice_client
    if not voice_client or not voice_client.is_connected():
        print(f"Auto-Rejoin: Hubungkan kembali ke {channel.name}...")
        try:
            await channel.connect(reconnect=True, self_deaf=False)
        except Exception as e:
            print(f"Gagal auto-rejoin: {e}")

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (Python Selfbot)! Status 24/7 Active.")
    if not auto_rejoin_loop.is_running():
        auto_rejoin_loop.start()

def is_owner_check(user_id):
    return user_id in owners or user_id == SUPER_OWNER_ID

# ==========================================
# SYSTEM PEMUTARAN MUSIK
# ==========================================
def play_next(ctx):
    guild_id = ctx.guild.id
    settings = get_guild_settings(guild_id)
    voice_client = ctx.guild.voice_client

    if not voice_client or not voice_client.is_connected():
        return

    # Logika Loop Track
    if settings['loop_track'] and settings['current']:
        song_to_play = settings['current']
    # Logika Loop Queue
    elif settings['loop_queue'] and settings['current']:
        settings['songs'].append(settings['current'])
        if len(settings['songs']) > 0:
            song_to_play = settings['songs'].pop(0)
        else:
            song_to_play = None
    # Logika Normal
    elif len(settings['songs']) > 0:
        song_to_play = settings['songs'].pop(0)
    else:
        song_to_play = None

    if song_to_play:
        settings['current'] = song_to_play
        asyncio.run_coroutine_threadsafe(ctx.send(f"Playing: **{song_to_play['title']}**"), bot.loop)
        
        coro = YTDLSource.from_url(song_to_play['query'], loop=bot.loop, stream=True)
        fut = asyncio.run_coroutine_threadsafe(coro, bot.loop)
        try:
            player = fut.result()
            voice_client.play(player, after=lambda e: play_next(ctx))
        except Exception as e:
            print(f"Error pada play_next: {e}")
            play_next(ctx)
    else:
        settings['current'] = None
        asyncio.run_coroutine_threadsafe(ctx.send("Antrean lagu telah habis."), bot.loop)

# ==========================================
# COMMAND: avehelp
# ==========================================
@bot.command(name="help")
async def help_cmd(ctx):
    help_text = (
        "**Daftar Perintah Selfbot Music (Prefix: `ave`)**\n\n"
        "**Voice Channel**\n"
        "• `avejoin` - Meminta bot masuk ke VC kamu.\n"
        "• `aveleave` - Mengeluarkan bot dari VC.\n"
        "• `avegrantowner <id>` - Menambahkan ID owner baru.\n"
        "• `averevokeowner <id>` - Menghapus ID owner (Super Owner Only).\n\n"
        "**Kontrol Pemutaran Musik**\n"
        "• `aveplay <judul/URL>` - Memutar lagu atau menambahkannya ke queue.\n"
        "• `aveskip` - Melompati lagu yang sedang diputar.\n"
        "• `avepause` / `averesume` - Menjeda / melanjutkan lagu.\n"
        "• `avestop` - Menghentikan lagu & membersihkan antrean.\n"
        "• `averemove <nomor>` - Menghapus lagu tertentu dari antrean.\n"
        "• `aveloop` / `aveloop queue` - Toggle loop lagu aktif / loop queue.\n"
        "• `aveautoplay` - Toggle rekomendasi lagu otomatis.\n"
        "• `aveshuffle` - Mengacak urutan lagu di queue.\n"
        "• `avehelp` - Menampilkan daftar perintah ini."
    )
    await ctx.send(help_text)

# ==========================================
# VOICE MANAGEMENT
# ==========================================
@bot.command(name="join")
async def join_cmd(ctx):
    global active_voice_channel_id
    if not ctx.author.voice or not ctx.author.voice.channel:
        return await ctx.send("Kamu harus masuk ke Voice Channel terlebih dahulu!")

    user_vc = ctx.author.voice.channel
    voice_client = ctx.guild.voice_client

    if voice_client and voice_client.is_connected():
        if voice_client.channel.id == user_vc.id:
            return await ctx.send("Bot sudah berada di Voice Channel ini.")
        
        if not is_owner_check(ctx.author.id):
            return await ctx.send("Bot sedang berada di Voice Channel lain. Hanya Owner yang bisa memaksa bot pindah!")
        
        await voice_client.move_to(user_vc)
    else:
        await user_vc.connect(reconnect=True, self_deaf=False)

    active_voice_channel_id = user_vc.id
    await ctx.send(f"Berhasil bergabung ke Voice Channel: **{user_vc.name}**")

@bot.command(name="leave")
async def leave_cmd(ctx):
    global active_voice_channel_id
    if not is_owner_check(ctx.author.id):
        return await ctx.send("Hanya Owner yang bisa mengeluarkan bot dari Voice Channel!")

    active_voice_channel_id = None
    guild_data.pop(ctx.guild.id, None)
    
    voice_client = ctx.guild.voice_client
    if voice_client:
        await voice_client.disconnect()
        await ctx.send("Bot telah keluar dari Voice Channel.")
    else:
        await ctx.send("Bot sedang tidak berada di Voice Channel mana pun.")

# ==========================================
# MUSIC CONTROLS
# ==========================================
@bot.command(name="play")
async def play_cmd(ctx, *, query: str = None):
    global active_voice_channel_id
    if not ctx.author.voice or not ctx.author.voice.channel:
        return await ctx.send("Kamu harus masuk ke Voice Channel terlebih dahulu!")

    if not query:
        return await ctx.send("Masukkan judul lagu atau link YouTube! Contoh: `aveplay silver lining laufey`")

    user_vc = ctx.author.voice.channel
    voice_client = ctx.guild.voice_client

    if not voice_client or not voice_client.is_connected():
        voice_client = await user_vc.connect(reconnect=True, self_deaf=False)
        active_voice_channel_id = user_vc.id

    await ctx.send(f"Mencari lagu: **{query}**...")

    try:
        player = await YTDLSource.from_url(query, loop=bot.loop, stream=True)
        song_info = {'title': player.title, 'query': query, 'url': player.url}

        settings = get_guild_settings(ctx.guild.id)

        if voice_client.is_playing() or voice_client.is_paused():
            settings['songs'].append(song_info)
            await ctx.send(f"Added to queue: **{player.title}**")
        else:
            settings['current'] = song_info
            voice_client.play(player, after=lambda e: play_next(ctx))
            await ctx.send(f"Playing: **{player.title}**")

    except Exception as e:
        print(f"Error play command: {e}")
        await ctx.send("Terjadi kesalahan saat mengambil lagu.")

@bot.command(name="pause")
async def pause_cmd(ctx):
    voice_client = ctx.guild.voice_client
    if voice_client and voice_client.is_playing():
        voice_client.pause()
        await ctx.send("Track paused.")
    else:
        await ctx.send("Tidak ada lagu yang sedang diputar.")

@bot.command(name="resume")
async def resume_cmd(ctx):
    voice_client = ctx.guild.voice_client
    if voice_client and voice_client.is_paused():
        voice_client.resume()
        await ctx.send("Track resumed.")
    else:
        await ctx.send("Tidak ada lagu yang sedang di-pause.")

@bot.command(name="skip")
async def skip_cmd(ctx):
    voice_client = ctx.guild.voice_client
    if voice_client and (voice_client.is_playing() or voice_client.is_paused()):
        voice_client.stop()
        await ctx.send("Skipped track.")
    else:
        await ctx.send("Tidak ada lagu untuk di-skip.")

@bot.command(name="stop")
async def stop_cmd(ctx):
    settings = get_guild_settings(ctx.guild.id)
    settings['songs'] = []
    settings['current'] = None
    settings['loop_track'] = False
    settings['loop_queue'] = False

    voice_client = ctx.guild.voice_client
    if voice_client and (voice_client.is_playing() or voice_client.is_paused()):
        voice_client.stop()
        await ctx.send("Stopped playback and cleared queue.")
    else:
        await ctx.send("Tidak ada musik yang sedang diputar.")

@bot.command(name="loop")
async def loop_cmd(ctx, mode: str = None):
    settings = get_guild_settings(ctx.guild.id)
    if mode and mode.lower() == "queue":
        settings['loop_queue'] = not settings['loop_queue']
        settings['loop_track'] = False
        status = "ENABLED" if settings['loop_queue'] else "DISABLED"
        await ctx.send(f"Looping queue: **{status}**")
    else:
        settings['loop_track'] = not settings['loop_track']
        settings['loop_queue'] = False
        status = "ENABLED" if settings['loop_track'] else "DISABLED"
        await ctx.send(f"Looping track: **{status}**")

@bot.command(name="remove")
async def remove_cmd(ctx, index: int = None):
    settings = get_guild_settings(ctx.guild.id)
    if not index or index < 1 or index > len(settings['songs']):
        return await ctx.send("Masukkan nomor antrean yang valid.")

    removed = settings['songs'].pop(index - 1)
    await ctx.send(f"Removed from queue: **{removed['title']}**")

@bot.command(name="shuffle")
async def shuffle_cmd(ctx):
    settings = get_guild_settings(ctx.guild.id)
    if len(settings['songs']) < 2:
        return await ctx.send("Jumlah antrean lagu kurang untuk diacak!")

    random.shuffle(settings['songs'])
    await ctx.send("Queue shuffled.")

@bot.command(name="autoplay")
async def autoplay_cmd(ctx):
    settings = get_guild_settings(ctx.guild.id)
    settings['autoplay'] = not settings['autoplay']
    status = "ENABLED" if settings['autoplay'] else "DISABLED"
    await ctx.send(f"Autoplay: **{status}**")

# ==========================================
# OWNER MANAGEMENT
# ==========================================
@bot.command(name="grantowner")
async def grantowner_cmd(ctx, target_id: int = None):
    if ctx.author.id != SUPER_OWNER_ID:
        return await ctx.send("Hanya Super Owner yang bisa menambah Owner baru!")
    if not target_id:
        return await ctx.send("Sebutkan ID Discord target!")

    owners.add(target_id)
    await ctx.send(f"Berhasil menambahkan <@{target_id}> sebagai Owner.")

@bot.command(name="revokeowner")
async def revokeowner_cmd(ctx, target_id: int = None):
    if ctx.author.id != SUPER_OWNER_ID:
        return await ctx.send("Hanya Super Owner yang bisa mencabut akses Owner!")
    if not target_id or target_id == SUPER_OWNER_ID:
        return await ctx.send("ID target tidak valid!")

    owners.discard(target_id)
    await ctx.send(f"Akses Owner dari <@{target_id}> berhasil dicabut.")

bot.run(TOKEN)
