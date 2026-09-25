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

TOKEN = os.getenv("DISCORD_TOKEN")
SUPER_OWNER_ID = int(os.getenv("SUPER_OWNER", "0"))

if not TOKEN:
    print("ERROR: DISCORD_TOKEN tidak ditemukan di Environment Variables!")
    exit(1)

# Inisialisasi Bot
bot = commands.Bot(command_prefix="ave", self_bot=True, help_command=None)

owners = {SUPER_OWNER_ID}
active_voice_channel = None

guild_data = {}

YTDL_OPTIONS = {
    'format': 'bestaudio/best',
    'extractaudio': True,
    'audioformat': 'mp3',
    'restrictfilenames': True,
    'noplaylist': True,
    'nocheckcertificate': True,
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
        search_query = url if url.startswith('http') else f"ytsearch:{url}"
        data = await loop.run_in_executor(None, lambda: ytdl.extract_info(search_query, download=not stream))
        if 'entries' in data:
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

async def raw_join_voice(guild, channel):
    """Memaksa gabung voice menggunakan paket Gateway WS langsung"""
    global active_voice_channel
    active_voice_channel = channel
    
    # Kirim paket Opcode 4 (Voice State Update)
    await bot.ws.voice_state(guild.id, channel.id if channel else None, self_mute=False, self_deaf=False)

# ==========================================
# AUTO REJOIN LOOP (15 Detik)
# ==========================================
@tasks.loop(seconds=15)
async def auto_rejoin_loop():
    global active_voice_channel
    if not active_voice_channel:
        return

    guild = active_voice_channel.guild
    voice_client = guild.voice_client
    if not voice_client or not voice_client.is_connected():
        print(f"[AUTO-REJOIN] Menghubungkan kembali ke {active_voice_channel.name}...")
        try:
            await raw_join_voice(guild, active_voice_channel)
        except Exception as e:
            print(f"[AUTO-REJOIN ERROR] {e}")

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (Python Selfbot)! Ready & listening for commands.")
    if not auto_rejoin_loop.is_running():
        auto_rejoin_loop.start()

@bot.event
async def on_message(message):
    # Memproses perintah teks dan cetak log di Railway
    if message.content.startswith("ave"):
        print(f"[LOG] {message.author}: {message.content}")
    await bot.process_commands(message)

def is_owner_check(user_id):
    return user_id in owners or user_id == SUPER_OWNER_ID

# ==========================================
# COMMANDS
# ==========================================
@bot.command(name="help")
async def help_cmd(ctx):
    help_text = (
        "**Daftar Perintah Selfbot Music (Prefix: `ave`)**\n\n"
        "**Voice Channel**\n"
        "• `avejoin` - Meminta bot masuk ke VC kamu (Owner bisa memaksa bot pindah VC).\n"
        "• `aveleave` - Mengeluarkan bot dari VC (Owner Only).\n"
        "• `avegrantowner <id>` - Menambahkan ID owner baru (Super Owner Only).\n"
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

@bot.command(name="join")
async def join_cmd(ctx):
    if not ctx.author.voice or not ctx.author.voice.channel:
        return await ctx.send("Kamu harus masuk ke Voice Channel terlebih dahulu!")

    user_vc = ctx.author.voice.channel
    voice_client = ctx.guild.voice_client

    if voice_client and voice_client.is_connected():
        if voice_client.channel.id == user_vc.id:
            return await ctx.send("Bot sudah berada di Voice Channel ini.")
        
        if not is_owner_check(ctx.author.id):
            return await ctx.send("Bot sedang berada di Voice Channel lain. Hanya Owner yang bisa memaksa bot pindah!")

    await raw_join_voice(ctx.guild, user_vc)
    await ctx.send(f"Berhasil bergabung ke Voice Channel: **{user_vc.name}**")

@bot.command(name="leave")
async def leave_cmd(ctx):
    global active_voice_channel
    if not is_owner_check(ctx.author.id):
        return await ctx.send("Hanya Owner yang bisa mengeluarkan bot dari Voice Channel!")

    active_voice_channel = None
    guild_data.pop(ctx.guild.id, None)
    
    await raw_join_voice(ctx.guild, None)
    await ctx.send("Bot telah keluar dari Voice Channel.")

@bot.command(name="play")
async def play_cmd(ctx, *, query: str = None):
    if not ctx.author.voice or not ctx.author.voice.channel:
        return await ctx.send("Kamu harus masuk ke Voice Channel terlebih dahulu!")

    if not query:
        return await ctx.send("Masukkan judul lagu atau link YouTube! Contoh: `aveplay silver lining laufey`")

    user_vc = ctx.author.voice.channel
    voice_client = ctx.guild.voice_client

    if not voice_client or not voice_client.is_connected():
        await raw_join_voice(ctx.guild, user_vc)

    await ctx.send(f"Mencari lagu: **{query}**...")

    try:
        player = await YTDLSource.from_url(query, loop=bot.loop, stream=True)
        song_info = {'title': player.title, 'query': query, 'url': player.url}

        settings = get_guild_settings(ctx.guild.id)

        if voice_client and (voice_client.is_playing() or voice_client.is_paused()):
            settings['songs'].append(song_info)
            await ctx.send(f"Added to queue: **{player.title}**")
        else:
            settings['current'] = song_info
            if voice_client:
                voice_client.play(player)
            await ctx.send(f"Playing: **{player.title}**")

    except Exception as e:
        print(f"[PLAY ERROR] {e}")
        await ctx.send("Terjadi kesalahan saat mengambil lagu.")

@bot.command(name="stop")
async def stop_cmd(ctx):
    settings = get_guild_settings(ctx.guild.id)
    settings['songs'] = []
    settings['current'] = None

    voice_client = ctx.guild.voice_client
    if voice_client and (voice_client.is_playing() or voice_client.is_paused()):
        voice_client.stop()
        await ctx.send("Stopped playback and cleared queue.")
    else:
        await ctx.send("Tidak ada musik yang sedang diputar.")

bot.run(TOKEN)
