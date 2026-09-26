const express=require('express');
const {Client}=require('discord.js-selfbot-v13');
const {LavalinkManager}=require('lavalink-client');
const Settings=require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');

const originalPatch=Settings.prototype._patch;
Settings.prototype._patch=function(data){
    if(data?.friend_source_flags===null)data.friend_source_flags={all:false,mutual_friends:false,mutual_guilds:false};
    return originalPatch.call(this,data);
};

const app=express();
app.use(express.json());
app.use(express.urlencoded({extended:true}));

const TOKEN=process.env.DISCORD_TOKEN;
const PORT=Number(process.env.PORT||3000);
const LAVALINK_HOST=process.env.LAVALINK_HOST;
const LAVALINK_PORT=Number(process.env.LAVALINK_PORT||2333);
const LAVALINK_PASSWORD=process.env.LAVALINK_PASSWORD;
const LAVALINK_SECURE=String(process.env.LAVALINK_SECURE||'false').toLowerCase()==='true';
const LAVALINK_ID=process.env.LAVALINK_ID||'main';
const RETRY=Number(process.env.LAVALINK_RETRY_AMOUNT||10);
const RETRY_DELAY=Number(process.env.LAVALINK_RETRY_DELAY||5000);

if(!TOKEN)throw new Error('DISCORD_TOKEN tidak ditemukan!');
if(!LAVALINK_HOST)throw new Error('LAVALINK_HOST tidak ditemukan!');
if(!LAVALINK_PASSWORD)throw new Error('LAVALINK_PASSWORD tidak ditemukan!');

const client=new Client({checkUpdate:false});

console.log('[Lavalink]',{
    host:LAVALINK_HOST,
    port:LAVALINK_PORT,
    secure:LAVALINK_SECURE,
    id:LAVALINK_ID
});

const lavalink=new LavalinkManager({
    nodes:[{
        id:LAVALINK_ID,
        host:LAVALINK_HOST,
        port:LAVALINK_PORT,
        authorization:LAVALINK_PASSWORD,
        secure:LAVALINK_SECURE,
        retryAmount:RETRY,
        retryDelay:RETRY_DELAY,
        requestSignalTimeoutMS:10000,
        closeOnError:false,
        heartBeatInterval:30000,
        enablePingOnStatsCheck:true
    }],
    sendToShard:(guildId,payload)=>{
        try{
            const guild=client.guilds.cache.get(guildId);
            guild?.shard?.send(payload);
        }catch(e){
            console.warn('[Lavalink] sendToShard:',e?.message||e);
        }
    },
    client:{id:'100000000000000000',username:'Botave'},
    autoSkip:true,
    autoMove:false
});

lavalink.nodeManager.on('connect',node=>{
    console.log('[Lavalink] Connected:',node?.id||node?.options?.host||'unknown');
});

lavalink.nodeManager.on('disconnect',(node,reason)=>{
    console.warn('[Lavalink] Disconnected:',node?.id||'unknown',reason||'unknown');
});

lavalink.nodeManager.on('error',(node,error)=>{
    console.warn('[Lavalink Error]:',node?.id||'unknown',error?.message||error);
});

let currentVoiceChannel=null;
let savedVoiceChannelId='';
let isAutoplayEnabled=false;
let repeatMode='off';
let volume=100;
let autoplayActionInProgress=false;
let manualSkipInProgress=false;
let manualStopInProgress=false;

const autoplayHistory=new Set();
const MAX_HISTORY=100;

function getCurrentPlayer(){
    if(!currentVoiceChannel)return null;
    try{return lavalink.getPlayer(currentVoiceChannel.guild.id);}
    catch{return null;}
}

function getPlayerVolume(player){
    const v=Number(player?.volume);
    return Number.isFinite(v)&&v>=0?Math.min(100,v):volume;
}

function getTrackTitle(track){
    return track?.info?.title||'Tidak ada';
}

function getTrackId(track){
    return track?.info?.identifier||null;
}

function escapeHtml(v){
    return String(v??'')
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&#039;');
}

function rememberTrack(track){
    const id=getTrackId(track);
    if(!id)return;
    autoplayHistory.add(id);
    if(autoplayHistory.size>MAX_HISTORY){
        const old=autoplayHistory.values().next().value;
        if(old)autoplayHistory.delete(old);
    }
}

async function getAutoplayTrack(player,previousTrack){
    if(!player||!previousTrack||manualStopInProgress)return null;

    const artist=previousTrack.info?.author?.trim();
    const previousId=previousTrack.info?.identifier;
    if(!artist)return null;

    const queries=[
        `ytsearch:${artist} top tracks`,
        `ytsearch:${artist} popular songs`,
        `ytsearch:${artist} best songs`,
        `ytsearch:${artist}`
    ];

    for(const query of queries){
        try{
            const result=await player.search({query},client.user);
            if(!result?.tracks?.length)continue;

            let candidates=result.tracks.filter(t=>{
                const id=t?.info?.identifier;
                return id&&id!==previousId&&!autoplayHistory.has(id);
            });

            if(!candidates.length){
                candidates=result.tracks.filter(t=>{
                    const id=t?.info?.identifier;
                    return id&&id!==previousId;
                });
            }

            if(!candidates.length)continue;

            const pool=candidates.slice(0,5);
            return pool[Math.floor(Math.random()*pool.length)];
        }catch(e){
            console.warn('[Autoplay Search]:',e?.message||e);
        }
    }

    return null;
}

async function playAutoplay(player,previousTrack){
    if(
        !isAutoplayEnabled||
        repeatMode!=='off'||
        !player||
        autoplayActionInProgress||
        manualStopInProgress
    )return false;

    autoplayActionInProgress=true;

    try{
        if(player.queue?.tracks?.length)return false;

        const next=await getAutoplayTrack(player,previousTrack);
        if(!next||manualStopInProgress)return false;

        rememberTrack(next);
        player.queue.add(next);
        await player.play();

        console.log('[Autoplay] Playing:',getTrackTitle(next));
        return true;
    }catch(e){
        console.error('[Autoplay Error]:',e?.message||e);
        return false;
    }finally{
        autoplayActionInProgress=false;
    }
}

lavalink.on('trackEnd',async(player,track)=>{
    if(!track)return;

    console.log('[Track End]',getTrackTitle(track));

    if(manualStopInProgress){
        console.log('[Track End] Ignored: manual stop');
        return;
    }

    if(repeatMode==='track'){
        try{await player.play({track});}
        catch(e){console.error('[Repeat Track]:',e?.message||e);}
        return;
    }

    if(repeatMode==='queue'){
        try{
            player.queue.add(track);
            if(!player.playing&&!player.paused)await player.play();
        }catch(e){
            console.error('[Repeat Queue]:',e?.message||e);
        }
        return;
    }

    if(player.queue?.tracks?.length)return;

    if(isAutoplayEnabled)await playAutoplay(player,track);
});

client.on('raw',data=>{
    try{lavalink.sendRawData(data);}
    catch(e){console.warn('[Lavalink Raw]:',e?.message||e);}
});

async function connectToChannel(channelId){
    try{
        const channel=await client.channels.fetch(channelId);

        if(!channel)return{success:false,message:'Channel tidak ditemukan!'};
        if(!channel.isVoice())return{success:false,message:'Bukan Voice Channel!'};

        const node=lavalink.nodeManager.nodes.get(LAVALINK_ID);
        if(!node||!node.connected){
            return{success:false,message:'Lavalink belum terhubung!'};
        }

        manualStopInProgress=false;
        autoplayActionInProgress=false;
        manualSkipInProgress=false;

        let player=lavalink.getPlayer(channel.guild.id);

        if(player){
            try{await player.disconnect();}catch{}
            try{await player.destroy();}catch{}
        }

        player=await lavalink.createPlayer({
            guildId:channel.guild.id,
            voiceChannelId:channel.id,
            textChannelId:channel.id,
            selfDeaf:false,
            selfMute:false,
            volume
        });

        await player.connect();

        try{await player.setVolume(volume);}catch{}

        currentVoiceChannel=channel;
        savedVoiceChannelId=channel.id;

        console.log('[Voice] Connected:',channel.name);
        return{success:true};
    }catch(e){
        console.error('[Voice Connect]:',e?.message||e);
        return{success:false,message:e?.message||'Unknown error'};
    }
}

async function leaveChannel(){
    manualStopInProgress=true;
    autoplayActionInProgress=false;
    manualSkipInProgress=false;

    try{
        const player=getCurrentPlayer();

        if(player){
            try{
                if(typeof player.queue?.clear==='function')player.queue.clear();
                else if(player.queue?.tracks)player.queue.tracks.length=0;
            }catch{}

            try{await player.disconnect();}catch{}
            try{await player.destroy();}catch{}
        }
    }catch(e){
        console.warn('[Leave]:',e?.message||e);
    }

    currentVoiceChannel=null;
    savedVoiceChannelId='';
    autoplayHistory.clear();

    setTimeout(()=>manualStopInProgress=false,1000);
    console.log('[Voice] Disconnected.');
}

async function stopPlayer(player){
    if(!player)return;

    manualStopInProgress=true;
    autoplayActionInProgress=false;
    manualSkipInProgress=false;

    try{
        if(typeof player.queue?.clear==='function')player.queue.clear();
        else if(player.queue?.tracks)player.queue.tracks.length=0;
    }catch(e){
        console.warn('[Stop Queue]:',e?.message||e);
    }

    try{
        if(typeof player.stopPlaying==='function')await player.stopPlaying();
        else if(typeof player.stop==='function')await player.stop();
    }catch(e){
        console.warn('[Stop Playback]:',e?.message||e);
        try{
            if(typeof player.stop==='function')await player.stop();
        }catch{}
    }

    console.log('[Stop] Musik berhenti, tetap di Voice Channel.');

    setTimeout(()=>manualStopInProgress=false,1500);
}

async function setPlayerVolume(player,value){
    if(!player)return false;

    let v=Number(value);
    if(!Number.isFinite(v))return false;

    v=Math.max(0,Math.min(100,Math.round(v)));

    try{
        await player.setVolume(v);
        volume=v;
        return true;
    }catch(e){
        console.error('[Volume]:',e?.message||e);
        return false;
    }
}

app.get('/api/state',(req,res)=>{
    try{
        const player=getCurrentPlayer();
        const current=player?.queue?.current||null;

        res.json({
            connected:Boolean(currentVoiceChannel),
            voiceChannel:currentVoiceChannel?{
                id:currentVoiceChannel.id,
                name:currentVoiceChannel.name,
                guildName:currentVoiceChannel.guild?.name||''
            }:null,
            playing:Boolean(player?.playing),
            paused:Boolean(player?.paused),
            current:current?{
                title:getTrackTitle(current),
                author:current.info?.author||'',
                identifier:current.info?.identifier||null,
                uri:current.info?.uri||null,
                duration:current.info?.duration||0,
                position:player?.position||0
            }:null,
            queue:(player?.queue?.tracks||[]).map((track,index)=>({
                index,
                title:getTrackTitle(track),
                author:track.info?.author||'',
                identifier:track.info?.identifier||null,
                duration:track.info?.duration||0
            })),
            queueLength:player?.queue?.tracks?.length||0,
            volume:getPlayerVolume(player),
            autoplay:isAutoplayEnabled,
            repeat:repeatMode,
            savedVoiceChannelId
        });
    }catch(e){
        console.error('[State]:',e?.message||e);
        res.status(500).json({error:true});
    }
});

function renderDashboard(){
    const player=getCurrentPlayer();
    const currentVolume=getPlayerVolume(player);

    let queue='<div class="small">Queue kosong.</div>';

    if(player?.queue?.tracks?.length){
        queue=player.queue.tracks.map((song,index)=>`
<div class="queue-item">
<div>
<strong>${index+1}. ${escapeHtml(getTrackTitle(song))}</strong>
<div class="small">${escapeHtml(song.info?.author||'')}</div>
</div>
<form method="POST" action="/api/delete-queue-item">
<input type="hidden" name="index" value="${index}">
<button class="danger" type="submit">X</button>
</form>
</div>`).join('');
    }

    const voiceStatus=currentVoiceChannel
        ?`<span style="color:#22c55e">${escapeHtml(currentVoiceChannel.name)} - ${escapeHtml(currentVoiceChannel.guild?.name||'')}</span>`
        :`<span style="color:#ef4444">Belum Terhubung</span>`;

    return `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Botave Music Controller</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:0;background:linear-gradient(135deg,#0f172a,#111827);color:#f8fafc;font-family:Arial,Helvetica,sans-serif;min-height:100vh}
.container{width:min(1000px,94%);margin:30px auto}
.card{background:rgba(15,23,42,.94);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:20px;margin-bottom:18px;box-shadow:0 10px 40px rgba(0,0,0,.25)}
h1{margin-top:0}
input,button{font:inherit}
input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#020617;color:white;outline:none}
button{border:0;border-radius:10px;padding:11px 15px;margin:4px;cursor:pointer;background:#334155;color:white;transition:.15s}
button:hover{transform:translateY(-1px);filter:brightness(1.15)}
.primary{background:#2563eb}.success{background:#16a34a}.danger{background:#dc2626}.warning{background:#d97706}
.controls{display:flex;flex-wrap:wrap;gap:5px;margin-top:12px}
.status{padding:12px;border-radius:10px;background:#020617;margin-top:10px}
.track{font-size:20px;font-weight:bold}.sub{color:#94a3b8;margin-top:5px}
.queue-item{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px;border-bottom:1px solid rgba(255,255,255,.06)}
.row{display:flex;gap:10px;align-items:center}.row input{flex:1}
.slider{width:100%}.small{font-size:13px;color:#94a3b8}
.play-row{display:flex;gap:6px;align-items:center}.play-row input{flex:1}.play-row form{margin:0}.play-row button{white-space:nowrap}
@media(max-width:700px){.row,.play-row{flex-direction:column;align-items:stretch}.play-row form{width:100%}.play-row button{width:100%}}
</style>
</head>
<body>
<div class="container">

<div class="card">
<h1>🎵 Botave Music Controller</h1>
<div class="small">Discord Music Controller</div>
</div>

<div class="card">
<h3>Voice Channel</h3>
<form method="POST" action="/api/connect">
<div class="row">
<input type="text" name="channelId" placeholder="Masukkan Voice Channel ID" value="${escapeHtml(savedVoiceChannelId)}" required>
<button class="primary" type="submit">Connect</button>
</div>
</form>
<div class="status">Status: <strong id="voiceStatus">${voiceStatus}</strong></div>
<form method="POST" action="/api/leave">
<button class="danger" type="submit">Leave</button>
</form>
</div>

<div class="card">
<h3>Now Playing</h3>
<div id="nowPlaying" class="status">Loading...</div>
<div class="controls">
<form method="POST" action="/api/pause"><button class="warning" type="submit">⏸ Pause</button></form>
<form method="POST" action="/api/resume"><button class="success" type="submit">▶ Resume</button></form>
<form method="POST" action="/api/skip"><button class="primary" type="submit">⏭ Skip</button></form>
</div>
</div>

<div class="card">
<h3>Play</h3>
<div class="play-row">
<form method="POST" action="/api/play" style="display:contents">
<input type="text" name="query" placeholder="YouTube URL / judul lagu" required>
<button class="primary" type="submit">▶ Play</button>
</form>
<form method="POST" action="/api/stop">
<button class="danger" type="submit">⏹ Stop</button>
</form>
</div>
<div class="small">Stop menghentikan musik dan queue tanpa keluar dari Voice Channel.</div>
</div>

<div class="card">
<h3>Volume</h3>
<form method="POST" action="/api/volume">
<input id="volumeSlider" class="slider" type="range" name="volume" min="0" max="100" value="${currentVolume}" oninput="document.getElementById('volumeValue').innerText=this.value">
<div>Volume: <span id="volumeValue">${currentVolume}</span></div>
<button class="primary" type="submit">Set Volume</button>
</form>
</div>

<div class="card">
<h3>Modes</h3>
<div class="controls">
<form method="POST" action="/api/loop-track"><button class="warning" type="submit">🔂 Repeat Track</button></form>
<form method="POST" action="/api/loop-queue"><button class="warning" type="submit">🔁 Repeat Queue</button></form>
<form method="POST" action="/api/toggle-autoplay"><button class="success" type="submit">🤖 Toggle Autoplay</button></form>
</div>
<div id="modeStatus" class="status">Loading...</div>
</div>

<div class="card">
<h3>Queue</h3>
<div id="queue">${queue}</div>
</div>

</div>

<script>
function esc(v){
    const d=document.createElement('div');
    d.textContent=v??'';
    return d.innerHTML;
}

function duration(ms){
    if(!Number.isFinite(ms)||ms<=0)return'00:00';
    const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;
    return h?String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):String(m).padStart(2,'0')+':'+String(x).padStart(2,'0');
}

async function refresh(){
    try{
        const r=await fetch('/api/state',{cache:'no-store'});
        if(!r.ok)return;
        const s=await r.json();

        const now=document.getElementById('nowPlaying');

        if(s.current){
            now.innerHTML=
                '<div class="track">🎵 '+esc(s.current.title)+'</div>'+
                '<div class="sub">'+esc(s.current.author||'')+'</div>'+
                '<div class="small">'+duration(s.current.position||0)+' / '+duration(s.current.duration||0)+'</div>';
        }else{
            now.innerHTML=
                '<div class="track">🎵 Tidak ada</div>'+
                '<div class="sub">Tidak ada lagu yang sedang diputar.</div>';
        }

        const voice=document.getElementById('voiceStatus');

        if(voice){
            voice.innerHTML=s.connected
                ?'<span style="color:#22c55e">'+esc(s.voiceChannel?.name||'')+' - '+esc(s.voiceChannel?.guildName||'')+'</span>'
                :'<span style="color:#ef4444">Belum Terhubung</span>';
        }

        const slider=document.getElementById('volumeSlider');
        const value=document.getElementById('volumeValue');

        if(slider&&document.activeElement!==slider)slider.value=s.volume;
        if(value)value.innerText=s.volume;

        document.getElementById('modeStatus').innerHTML=
            '<div>🔂 Repeat Track: <strong>'+(s.repeat==='track'?'ON':'OFF')+'</strong></div>'+
            '<div>🔁 Repeat Queue: <strong>'+(s.repeat==='queue'?'ON':'OFF')+'</strong></div>'+
            '<div>🤖 Autoplay: <strong>'+(s.autoplay?'ON':'OFF')+'</strong></div>';

        const q=document.getElementById('queue');

        if(!s.queue?.length){
            q.innerHTML='<div class="small">Queue kosong.</div>';
        }else{
            q.innerHTML=s.queue.map(song=>
                '<div class="queue-item">'+
                    '<div>'+
                        '<strong>'+Number(song.index+1)+'. '+esc(song.title)+'</strong>'+
                        '<div class="small">'+esc(song.author||'')+(song.duration?' - '+duration(song.duration):'')+'</div>'+
                    '</div>'+
                    '<form method="POST" action="/api/delete-queue-item">'+
                        '<input type="hidden" name="index" value="'+song.index+'">'+
                        '<button class="danger" type="submit">X</button>'+
                    '</form>'+
                '</div>'
            ).join('');
        }
    }catch(e){
        console.warn('State update failed:',e);
    }
}

refresh();
setInterval(refresh,1000);
</script>
</body>
</html>`;
}

app.get('/favicon.ico',(req,res)=>res.status(204).end());

app.get('/',(req,res)=>res.send(renderDashboard()));

app.post('/api/connect',async(req,res)=>{
    const id=req.body?.channelId?.trim();
    if(!id)return res.redirect('/');

    const result=await connectToChannel(id);

    if(!result.success){
        return res.send(`
<script>
alert(${JSON.stringify(result.message||'Gagal connect.')});
location.href='/';
</script>`);
    }

    res.redirect('/');
});

app.post('/api/leave',async(req,res)=>{
    await leaveChannel();
    res.redirect('/');
});

app.post('/api/play',async(req,res)=>{
    const query=req.body?.query?.trim();

    if(!query)return res.redirect('/');

    if(!currentVoiceChannel){
        return res.send(`
<script>
alert('Atur Voice Channel ID terlebih dahulu!');
location.href='/';
</script>`);
    }

    try{
        manualStopInProgress=false;

        let player=getCurrentPlayer();

        if(!player){
            const result=await connectToChannel(currentVoiceChannel.id);
            if(!result.success)return res.redirect('/');
            player=getCurrentPlayer();
        }

        if(!player)return res.redirect('/');

        const result=await player.search({query},client.user);

        if(!result?.tracks?.length){
            console.warn('[Play] Tidak ada hasil:',query);
            return res.redirect('/');
        }

        const track=result.tracks[0];

        player.queue.add(track);
        rememberTrack(track);

        if(!player.playing&&!player.paused)await player.play();

        console.log('[Play]',getTrackTitle(track));
    }catch(e){
        console.error('[Play Error]:',e?.message||e);
    }

    res.redirect('/');
});

app.post('/api/pause',async(req,res)=>{
    const player=getCurrentPlayer();

    if(player){
        try{
            if(typeof player.pause==='function')await player.pause();
        }catch(e){
            console.error('[Pause]:',e?.message||e);
        }
    }

    res.redirect('/');
});

app.post('/api/resume',async(req,res)=>{
    const player=getCurrentPlayer();

    if(player){
        try{
            if(typeof player.resume==='function')await player.resume();
        }catch(e){
            console.error('[Resume]:',e?.message||e);
        }
    }

    res.redirect('/');
});

app.post('/api/skip',async(req,res)=>{
    const player=getCurrentPlayer();

    if(!player||manualSkipInProgress||manualStopInProgress)return res.redirect('/');

    manualSkipInProgress=true;

    try{
        const current=player.queue?.current;

        if(!current)return res.redirect('/');

        if(player.queue?.tracks?.length){
            await player.skip();
            return res.redirect('/');
        }

        if(!isAutoplayEnabled){
            await stopPlayer(player);
            return res.redirect('/');
        }

        const next=await getAutoplayTrack(player,current);

        if(!next){
            await stopPlayer(player);
            return res.redirect('/');
        }

        if(manualStopInProgress)return res.redirect('/');

        rememberTrack(next);
        player.queue.add(next);
        await player.skip();

    }catch(e){
        console.error('[Skip Error]:',e?.message||e);
    }finally{
        setTimeout(()=>manualSkipInProgress=false,500);
    }

    res.redirect('/');
});

app.post('/api/stop',async(req,res)=>{
    const player=getCurrentPlayer();

    if(player){
        await stopPlayer(player);
    }else{
        manualStopInProgress=true;
        autoplayActionInProgress=false;
        manualSkipInProgress=false;
        setTimeout(()=>manualStopInProgress=false,1500);
    }

    res.redirect('/');
});

app.post('/api/volume',async(req,res)=>{
    const player=getCurrentPlayer();

    if(!player){
        return res.status(400).json({
            success:false,
            message:'Player belum terhubung.'
        });
    }

    const success=await setPlayerVolume(player,req.body?.volume);

    if(req.is('application/json')){
        return res.json({
            success,
            volume:getPlayerVolume(player)
        });
    }

    res.redirect('/');
});

app.post('/api/loop-track',(req,res)=>{
    repeatMode=repeatMode==='track'?'off':'track';
    console.log('[Repeat]',repeatMode);
    res.redirect('/');
});

app.post('/api/loop-queue',(req,res)=>{
    repeatMode=repeatMode==='queue'?'off':'queue';
    console.log('[Repeat]',repeatMode);
    res.redirect('/');
});

app.post('/api/toggle-autoplay',(req,res)=>{
    isAutoplayEnabled=!isAutoplayEnabled;
    console.log('[Autoplay]',isAutoplayEnabled?'ON':'OFF');
    res.redirect('/');
});

app.post('/api/delete-queue-item',(req,res)=>{
    const player=getCurrentPlayer();
    const index=Number.parseInt(req.body?.index,10);

    if(
        player&&
        Number.isInteger(index)&&
        player.queue?.tracks?.[index]
    ){
        const removed=player.queue.tracks.splice(index,1)[0];
        console.log('[Queue] Removed:',getTrackTitle(removed));
    }

    res.redirect('/');
});

app.get('*',(req,res)=>res.send(renderDashboard()));

client.on('ready',async()=>{
    console.log('Logged in as',client.user.tag);

    lavalink.options.client.id=client.user.id;
    lavalink.options.client.username=client.user.username||'Botave';

    try{
        await lavalink.init(client.user);
        console.log('[Lavalink] Manager initialized.');
    }catch(e){
        console.error('[Lavalink Init]:',e?.message||e);
    }
});

process.on('unhandledRejection',e=>console.warn('[Unhandled Rejection]',e));
process.on('uncaughtException',e=>console.warn('[Uncaught Exception]',e?.message||e));

app.listen(PORT,'0.0.0.0',()=>{
    console.log('Web Controller berjalan di port',PORT);
});

client.login(TOKEN);
