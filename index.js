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
const client=new Client({checkUpdate:false});
const TOKEN=process.env.DISCORD_TOKEN;
const PORT=process.env.PORT||3000;
if(!TOKEN){
    console.error('ERROR: DISCORD_TOKEN tidak ditemukan!');
    process.exit(1);
}
const lavalink=new LavalinkManager({
    nodes:[{
        id:'node-freelavalink',
        host:'lavalink.v4.lavalink.is-a.dev',
        port:443,
        authorization:'youshallnotpass',
        secure:true,
        retryAmount:10,
        retryDelay:5000
    }],
    sendToShard:(guildId,payload)=>{
        const guild=client.guilds.cache.get(guildId);
        if(guild)guild.shard.send(payload);
    },
    client:{id:'100000000000000000'},
    autoSkip:true
});
lavalink.nodeManager.on('error',(node,error)=>{
    console.warn('[Lavalink Error] Node '+(node?.id||node?.options?.host||'unknown')+':',error?.message||error);
});
lavalink.nodeManager.on('connect',node=>{
    console.log('[Lavalink] Connected: '+(node?.id||node?.options?.host||'unknown'));
});
lavalink.nodeManager.on('disconnect',(node,reason)=>{
    console.warn('[Lavalink] Disconnected: '+(node?.id||node?.options?.host||'unknown'),reason||'');
});
let currentVoiceChannel=null;
let savedVoiceChannelId='';
let isAutoplayEnabled=false;
let repeatMode='off';
let volume=100;
let autoplayActionInProgress=false;
let manualSkipInProgress=false;
const autoplayHistory=new Set();
const MAX_HISTORY=100;
function getCurrentPlayer(){
    if(!currentVoiceChannel)return null;
    return lavalink.getPlayer(currentVoiceChannel.guild.id);
}
function getPlayerVolume(player){
    if(!player)return volume;
    const currentVolume=Number(player.volume);
    if(Number.isFinite(currentVolume)&&currentVolume>=0)return Math.min(100,currentVolume);
    return volume;
}
function getTrackTitle(track){
    return track?.info?.title||'Tidak ada';
}
function getTrackId(track){
    return track?.info?.identifier||null;
}
function escapeHtml(value){
    return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");
}
function rememberTrack(track){
    const id=getTrackId(track);
    if(!id)return;
    autoplayHistory.add(id);
    if(autoplayHistory.size>MAX_HISTORY){
        const oldest=autoplayHistory.values().next().value;
        if(oldest)autoplayHistory.delete(oldest);
    }
}
async function getAutoplayTrack(player,previousTrack){
    if(!player||!previousTrack)return null;
    const artist=previousTrack.info?.author?.trim();
    const previousId=previousTrack.info?.identifier;
    if(!artist)return null;
    const queries=[
        'ytsearch:'+artist+' top tracks',
        'ytsearch:'+artist+' popular songs',
        'ytsearch:'+artist+' best songs',
        'ytsearch:'+artist
    ];
    for(const query of queries){
        try{
            console.log('[Autoplay] Search: '+query);
            const result=await player.search({query},client.user);
            if(!result?.tracks?.length)continue;
            let candidates=result.tracks.filter(track=>{
                const id=track?.info?.identifier;
                return id&&id!==previousId&&!autoplayHistory.has(id);
            });
            if(!candidates.length){
                candidates=result.tracks.filter(track=>{
                    const id=track?.info?.identifier;
                    return id&&id!==previousId;
                });
            }
            if(!candidates.length)continue;
            const pool=candidates.slice(0,5);
            const selected=pool[Math.floor(Math.random()*pool.length)];
            console.log('[Autoplay] Selected: '+getTrackTitle(selected));
            return selected;
        }catch(err){
            console.warn('[Autoplay] Search failed:',err?.message||err);
        }
    }
    return null;
}
async function playAutoplay(player,previousTrack){
    if(!isAutoplayEnabled||repeatMode!=='off'||!player||autoplayActionInProgress)return false;
    autoplayActionInProgress=true;
    try{
        if(player.queue.tracks.length>0)return false;
        const next=await getAutoplayTrack(player,previousTrack);
        if(!next){
            console.log('[Autoplay] Tidak menemukan rekomendasi.');
            return false;
        }
        rememberTrack(next);
        player.queue.add(next);
        await player.play();
        console.log('[Autoplay] Playing: '+getTrackTitle(next));
        return true;
    }catch(err){
        console.error('[Autoplay Error]:',err?.message||err);
        return false;
    }finally{
        autoplayActionInProgress=false;
    }
}
lavalink.on('trackEnd',async(player,track)=>{
    if(!track)return;
    console.log('[Track End] '+getTrackTitle(track));
    if(repeatMode==='track'){
        try{
            await player.play({track:track});
        }catch(err){
            console.error('[Repeat Track Error]:',err?.message||err);
        }
        return;
    }
    if(repeatMode==='queue'){
        try{
            player.queue.add(track);
            if(!player.playing&&!player.paused)await player.play();
        }catch(err){
            console.error('[Repeat Queue Error]:',err?.message||err);
        }
        return;
    }
    if(player.queue.tracks.length>0)return;
    if(isAutoplayEnabled)await playAutoplay(player,track);
    else console.log('[Track End] Queue kosong, autoplay OFF.');
});
client.on('raw',data=>lavalink.sendRawData(data));
async function connectToChannel(channelId){
    try{
        const channel=await client.channels.fetch(channelId);
        if(!channel?.isVoice())return{success:false,message:'Bukan Voice Channel!'};
        let player=lavalink.getPlayer(channel.guild.id);
        if(player){
            try{await player.disconnect();}catch(_){}
            try{await player.destroy();}catch(_){}
        }
        player=await lavalink.createPlayer({
            guildId:channel.guild.id,
            voiceChannelId:channel.id,
            textChannelId:channel.id,
            selfDeaf:false,
            selfMute:false,
            volume:volume
        });
        await player.connect();
        try{await player.setVolume(volume);}catch(err){
            console.warn('[Volume] Initial set failed:',err?.message||err);
        }
        currentVoiceChannel=channel;
        savedVoiceChannelId=channel.id;
        console.log('[Voice] Connected: '+channel.name);
        return{success:true};
    }catch(err){
        console.error('[Voice] Connect error:',err?.message||err);
        return{success:false,message:err?.message||'Unknown error'};
    }
}
async function leaveChannel(){
    if(!currentVoiceChannel)return;
    try{
        const player=lavalink.getPlayer(currentVoiceChannel.guild.id);
        if(player){
            try{await player.stop();}catch(_){}
            try{await player.disconnect();}catch(_){}
            try{await player.destroy();}catch(_){}
        }
    }catch(err){
        console.error('[Voice] Leave error:',err?.message||err);
    }
    currentVoiceChannel=null;
    savedVoiceChannelId='';
    autoplayHistory.clear();
    autoplayActionInProgress=false;
    manualSkipInProgress=false;
}
async function stopPlayer(player){
    if(!player)return;
    try{await player.stop();}catch(err){
        console.warn('[Stop] stop() failed:',err?.message||err);
    }
    try{
        if(player.queue?.tracks)player.queue.tracks.splice(0,player.queue.tracks.length);
    }catch(err){
        console.warn('[Stop] Queue cleanup failed:',err?.message||err);
    }
    autoplayActionInProgress=false;
    manualSkipInProgress=false;
    console.log('[Stop] Playback stopped.');
}
async function setPlayerVolume(player,requestedVolume){
    if(!player)return false;
    let newVolume=Number(requestedVolume);
    if(!Number.isFinite(newVolume))return false;
    newVolume=Math.round(newVolume);
    newVolume=Math.max(0,Math.min(100,newVolume));
    try{
        await player.setVolume(newVolume);
        volume=newVolume;
        return true;
    }catch(err){
        console.error('[Volume Error]:',err?.message||err);
        return false;
    }
}
app.get('/api/state',(req,res)=>{
    try{
        const player=getCurrentPlayer();
        const current=player?.queue?.current||null;
        const tracks=player?.queue?.tracks||[];
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
                identifier:current.info?.identifier||''
            }:null,
            queue:tracks.map((track,index)=>({
                index,
                title:getTrackTitle(track),
                author:track.info?.author||''
            })),
            queueLength:tracks.length,
            volume:getPlayerVolume(player),
            autoplay:isAutoplayEnabled,
            repeat:repeatMode
        });
    }catch(err){
        console.error('[State Error]:',err?.message||err);
        res.status(500).json({error:true});
    }
});
function renderDashboard(){
    const player=getCurrentPlayer();
    const current=player?.queue?.current?.info?.title||'Tidak ada';
    const currentVolume=getPlayerVolume(player);
    let queue='<li class="empty-queue">Antrean kosong</li>';
    if(player?.queue?.tracks?.length){
        queue=player.queue.tracks.map((song,i)=>{
            return '<li class="queue-item">'+
                '<div class="queue-title">'+
                '<span class="queue-number">'+(i+1)+'.</span>'+
                '<span class="queue-song">'+escapeHtml(getTrackTitle(song))+'</span>'+
                '</div>'+
                '<form action="/api/delete-queue-item" method="POST">'+
                '<input type="hidden" name="index" value="'+i+'">'+
                '<button class="danger small" type="submit">X</button>'+
                '</form>'+
                '</li>';
        }).join('');
    }
    const voiceStatus=currentVoiceChannel?
        '<span style="color:#57f287">'+escapeHtml(currentVoiceChannel.name)+' ('+escapeHtml(currentVoiceChannel.guild.name)+')</span>':
        '<span style="color:#ed4245">Belum Terhubung</span>';
    const leaveButton=currentVoiceChannel?
        '<form action="/api/leave" method="POST"><button class="danger">Leave Voice Channel</button></form>':'';
    const loopTrackClass=repeatMode==='track'?'active':'alt';
    const loopQueueClass=repeatMode==='queue'?'active':'alt';
    const autoplayClass=isAutoplayEnabled?'active':'alt';
    const loopTrackText=repeatMode==='track'?'ON':'OFF';
    const loopQueueText=repeatMode==='queue'?'ON':'OFF';
    const autoplayText=isAutoplayEnabled?'ON':'OFF';
    return '<!DOCTYPE html>'+
'<html lang="id">'+
'<head>'+
'<meta charset="UTF-8">'+
'<meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>Voicecord Controller</title>'+
'<style>'+
'*{box-sizing:border-box}'+
'body{font-family:Arial,sans-serif;background:#0f1015;color:#e1e1e6;padding:20px;max-width:520px;margin:auto}'+
'.card{background:#181920;padding:18px;border-radius:12px;margin-bottom:16px;border:1px solid #282a36}'+
'h2,h3{margin-top:0;color:#fff}'+
'input,button{padding:11px;margin:5px 0;width:100%;border:0;border-radius:8px;font-size:14px}'+
'input{background:#222431;color:#fff;border:1px solid #323546}'+
'button{background:#5865f2;color:#fff;font-weight:bold;cursor:pointer;transition:opacity .15s,transform .05s}'+
'button:hover{opacity:.9}'+
'button:active{transform:scale(.98)}'+
'button.alt{background:#2b2d3c}'+
'button.danger{background:#ed4245}'+
'button.active{background:#57f287;color:#000}'+
'button.small{width:auto;padding:5px 9px;margin:0}'+
'.controls{display:flex;gap:8px;margin-top:6px}'+
'.controls form{flex:1;min-width:0}'+
'.status{font-size:13px;color:#aaa}'+
'.current{color:#5865f2;font-weight:bold;font-size:16px;word-break:break-word}'+
'.play-search{margin-bottom:6px}'+
'.play-buttons{display:flex;gap:8px}'+
'.play-buttons form{margin:0}'+
'.play-buttons .play-submit{flex:1}'+
'.play-buttons .stop-submit{flex:0 0 85px}'+
'.play-buttons button{height:100%}'+
'.volume-box{margin-top:14px;background:#222431;padding:12px;border-radius:10px}'+
'.volume-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}'+
'.volume-value{color:#57f287;font-weight:bold}'+
'input[type="range"]{width:100%;margin:0;padding:0;accent-color:#5865f2;cursor:pointer}'+
'.queue{padding:0;list-style:none;margin:0}'+
'.queue-item{display:flex;justify-content:space-between;align-items:center;margin:7px 0;gap:8px;background:#222431;padding:8px;border-radius:7px}'+
'.queue-title{display:flex;gap:6px;min-width:0;flex:1}'+
'.queue-number{color:#888;flex-shrink:0}'+
'.queue-song{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'+
'.empty-queue{color:#777;padding:8px 0}'+
'@media(max-width:400px){body{padding:12px}.play-buttons .stop-submit{flex:0 0 72px}}'+
'</style>'+
'</head>'+
'<body>'+
'<h2>Voicecord Controller</h2>'+
'<div class="card">'+
'<h3>Voice Channel</h3>'+
'<p class="status">Status: <strong id="voice-status">'+voiceStatus+'</strong></p>'+
'<form action="/api/connect" method="POST">'+
'<input name="channelId" placeholder="Voice Channel ID" value="'+escapeHtml(savedVoiceChannelId)+'" required>'+
'<button class="alt">Set / Pindah Voice Channel</button>'+
'</form>'+
leaveButton+
'</div>'+
'<div class="card">'+
'<h3>Music Player</h3>'+
'<p class="status">Sedang Diputar:</p>'+
'<p class="current" id="current-track">'+escapeHtml(current)+'</p>'+
'<div class="volume-box">'+
'<div class="volume-header"><span>🔊 Volume</span><span class="volume-value" id="volume-value">'+currentVolume+'%</span></div>'+
'<input id="volume-slider" type="range" min="0" max="100" value="'+currentVolume+'" step="1">'+
'</div>'+
'<form action="/api/play" method="POST" class="play-search">'+
'<input name="query" placeholder="Judul / YouTube / Spotify / SoundCloud" required>'+
'</form>'+
'<div class="play-buttons">'+
'<form action="/api/play" method="POST" class="play-submit">'+
'<input type="hidden" id="play-query" name="query" value="">'+
'<button>▶ Play / Add Queue</button>'+
'</form>'+
'<form action="/api/stop" method="POST" class="stop-submit">'+
'<button class="danger">⏹ Stop</button>'+
'</form>'+
'</div>'+
'<div class="controls">'+
'<form action="/api/pause" method="POST"><button class="alt">⏸ Pause</button></form>'+
'<form action="/api/resume" method="POST"><button class="alt">▶ Resume</button></form>'+
'<form action="/api/skip" method="POST"><button class="alt">⏭ Skip</button></form>'+
'</div>'+
'<div class="controls">'+
'<form action="/api/loop-track" method="POST"><button id="loop-track-button" class="'+loopTrackClass+'">Loop Track: '+loopTrackText+'</button></form>'+
'<form action="/api/loop-queue" method="POST"><button id="loop-queue-button" class="'+loopQueueClass+'">Loop Queue: '+loopQueueText+'</button></form>'+
'</div>'+
'<form action="/api/toggle-autoplay" method="POST"><button id="autoplay-button" class="'+autoplayClass+'">Autoplay: '+autoplayText+'</button></form>'+
'</div>'+
'<div class="card">'+
'<h3>Antrean Lagu</h3>'+
'<ol class="queue" id="queue-list">'+queue+'</ol>'+
'</div>'+
'<script>'+
'const searchForm=document.querySelector(".play-search");'+
'const playForm=document.querySelector(".play-submit");'+
'const searchInput=searchForm?.querySelector("input[name=query]");'+
'const playQuery=document.getElementById("play-query");'+
'if(searchInput&&playQuery)searchInput.addEventListener("input",()=>playQuery.value=searchInput.value);'+
'if(searchForm)searchForm.addEventListener("submit",event=>{event.preventDefault();if(searchInput?.value?.trim()){playQuery.value=searchInput.value.trim();playForm.submit()}});'+
'let volumeTimer=null;let volumeRequest=null;'+
'const volumeSlider=document.getElementById("volume-slider");'+
'const volumeValue=document.getElementById("volume-value");'+
'if(volumeSlider)volumeSlider.addEventListener("input",()=>{const value=Number(volumeSlider.value);if(volumeValue)volumeValue.textContent=value+"%";clearTimeout(volumeTimer);volumeTimer=setTimeout(async()=>{try{if(volumeRequest)volumeRequest.abort();volumeRequest=new AbortController();await fetch("/api/volume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({volume:value}),signal:volumeRequest.signal})}catch(err){if(err.name!=="AbortError")console.warn("Volume update failed:",err)}},80)});'+
'function escapeHtml(value){const div=document.createElement("div");div.textContent=value??"";return div.innerHTML}'+
'function renderQueue(queue){const list=document.getElementById("queue-list");if(!list)return;if(!queue||queue.length===0){list.innerHTML="<li class=\\"empty-queue\\">Antrean kosong</li>";return}list.innerHTML=queue.map(song=>"<li class=\\"queue-item\\"><div class=\\"queue-title\\"><span class=\\"queue-number\\">"+(song.index+1)+".</span><span class=\\"queue-song\\">"+escapeHtml(song.title)+"</span></div><form action=\\"/api/delete-queue-item\\" method=\\"POST\\"><input type=\\"hidden\\" name=\\"index\\" value=\\""+song.index+"\\"><button class=\\"danger small\\" type=\\"submit\\">X</button></form></li>").join("")}'+
'function updateButton(id,label,active){const button=document.getElementById(id);if(!button)return;button.textContent=label+": "+(active?"ON":"OFF");button.className=active?"active":"alt"}'+
'async function updateState(){try{const response=await fetch("/api/state",{cache:"no-store"});if(!response.ok)return;const state=await response.json();const current=document.getElementById("current-track");if(current)current.textContent=state.current?.title||"Tidak ada";const slider=document.getElementById("volume-slider");const volumeLabel=document.getElementById("volume-value");if(slider&&document.activeElement!==slider)slider.value=state.volume;if(volumeLabel)volumeLabel.textContent=state.volume+"%";renderQueue(state.queue);updateButton("loop-track-button","Loop Track",state.repeat==="track");updateButton("loop-queue-button","Loop Queue",state.repeat==="queue");updateButton("autoplay-button","Autoplay",state.autoplay);const voiceStatus=document.getElementById("voice-status");if(voiceStatus){if(state.connected)voiceStatus.innerHTML="<span style=\\"color:#57f287\\">"+escapeHtml(state.voiceChannel?.name||"")+" ("+escapeHtml(state.voiceChannel?.guildName||"")+")</span>";else voiceStatus.innerHTML="<span style=\\"color:#ed4245\\">Belum Terhubung</span>"}}catch(err){console.warn("State update failed:",err)}}'+
'updateState();setInterval(updateState,1000);'+
'</script>'+
'</body>'+
'</html>';
}
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.get('/favicon.ico',(_,res)=>res.status(204).end());
app.get('/',(_,res)=>res.send(renderDashboard()));
app.post('/api/connect',async(req,res)=>{
    if(req.body.channelId)await connectToChannel(req.body.channelId.trim());
    res.redirect('/');
});
app.post('/api/leave',async(_,res)=>{
    await leaveChannel();
    res.redirect('/');
});
app.post('/api/play',async(req,res)=>{
    const query=req.body.query?.trim();
    if(!query)return res.redirect('/');
    if(!currentVoiceChannel)return res.send('<script>alert("Atur Voice Channel ID terlebih dahulu!");location.href="/";</script>');
    try{
        let player=lavalink.getPlayer(currentVoiceChannel.guild.id);
        if(!player){
            await connectToChannel(currentVoiceChannel.id);
            player=lavalink.getPlayer(currentVoiceChannel.guild.id);
        }
        if(!player)return res.redirect('/');
        const result=await player.search({query},client.user);
        if(result?.tracks?.length){
            const track=result.tracks[0];
            player.queue.add(track);
            console.log('[Play] '+getTrackTitle(track));
            if(!player.playing&&!player.paused)await player.play();
        }
    }catch(err){
        console.error('[Play Error]:',err?.message||err);
    }
    res.redirect('/');
});
app.post('/api/pause',async(_,res)=>{
    const player=getCurrentPlayer();
    if(player){
        try{await player.pause();}catch(err){console.error('[Pause Error]:',err?.message||err)}
    }
    res.redirect('/');
});
app.post('/api/resume',async(_,res)=>{
    const player=getCurrentPlayer();
    if(player){
        try{await player.resume();}catch(err){console.error('[Resume Error]:',err?.message||err)}
    }
    res.redirect('/');
});
app.post('/api/skip',async(_,res)=>{
    const player=getCurrentPlayer();
    if(!player)return res.redirect('/');
    if(manualSkipInProgress)return res.redirect('/');
    manualSkipInProgress=true;
    try{
        const current=player.queue.current;
        if(!current)return res.redirect('/');
        if(player.queue.tracks.length>0){
            console.log('[Skip] Next queue track.');
            await player.skip();
            return res.redirect('/');
        }
        if(!isAutoplayEnabled){
            console.log('[Skip] Queue kosong + autoplay OFF.');
            await stopPlayer(player);
            return res.redirect('/');
        }
        console.log('[Skip] Searching autoplay next after: '+getTrackTitle(current));
        const next=await getAutoplayTrack(player,current);
        if(!next){
            console.log('[Skip] Recommendation tidak ditemukan.');
            await stopPlayer(player);
            return res.redirect('/');
        }
        rememberTrack(next);
        player.queue.add(next);
        console.log('[Skip] Autoplay Next: '+getTrackTitle(next));
        await player.skip();
    }catch(err){
        console.error('[Skip Error]:',err?.message||err);
    }finally{
        setTimeout(()=>{manualSkipInProgress=false},300);
    }
    res.redirect('/');
});
app.post('/api/stop',async(_,res)=>{
    const player=getCurrentPlayer();
    if(player)await stopPlayer(player);
    res.redirect('/');
});
app.post('/api/volume',async(req,res)=>{
    const player=getCurrentPlayer();
    if(!player)return res.status(400).json({success:false,message:'Player belum terhubung.'});
    const requestedVolume=req.body?.volume;
    const success=await setPlayerVolume(player,requestedVolume);
    if(!success)return res.status(400).json({success:false,volume:getPlayerVolume(player)});
    return res.json({success:true,volume:volume});
});
app.post('/api/loop-track',(req,res)=>{
    repeatMode=repeatMode==='track'?'off':'track';
    console.log('[Repeat] '+repeatMode);
    res.redirect('/');
});
app.post('/api/loop-queue',(req,res)=>{
    repeatMode=repeatMode==='queue'?'off':'queue';
    console.log('[Repeat] '+repeatMode);
    res.redirect('/');
});
app.post('/api/toggle-autoplay',(_,res)=>{
    isAutoplayEnabled=!isAutoplayEnabled;
    console.log('[Autoplay] '+(isAutoplayEnabled?'ON':'OFF'));
    res.redirect('/');
});
app.post('/api/delete-queue-item',(req,res)=>{
    const player=getCurrentPlayer();
    const index=Number.parseInt(req.body.index,10);
    if(player&&Number.isInteger(index)&&player.queue.tracks[index]){
        const removed=player.queue.tracks.splice(index,1)[0];
        console.log('[Queue] Removed: '+getTrackTitle(removed));
    }
    res.redirect('/');
});
app.get('*',(_,res)=>res.send(renderDashboard()));
client.on('ready',async()=>{
    console.log('Logged in as '+client.user.tag);
    lavalink.options.client.id=client.user.id;
    try{
        await lavalink.init(client.user);
        console.log('[Lavalink] Manager initialized.');
    }catch(err){
        console.error('[Lavalink] Init error:',err?.message||err);
    }
});
process.on('unhandledRejection',reason=>console.warn('[Unhandled Rejection]',reason));
process.on('uncaughtException',err=>console.warn('[Uncaught Exception]',err?.message||err));
app.listen(PORT,'0.0.0.0',()=>console.log('Web Controller berjalan di port '+PORT));
client.login(TOKEN);
