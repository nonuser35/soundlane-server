class SoundlanePlayer extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.worklet = null;
    this.gain = null;
    this.analyser = null;
    this.listenerSocket = null;
    this.metadataSocket = null;
    this.decoder = null;
    this.decoderTimestamp = 0;
    this.codec = 'pcm-f32';
    this.volume = .8;
    this.muted = false;
    this.server = '';
    this.reconnectTimer = 0;
    this.intentionalClose = false;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type,{detail})); }
  endpoint(server, path) { const url=new URL(server); url.protocol=url.protocol==='https:'?'wss:':'ws:'; url.pathname=path; url.search=''; return url.toString(); }
  async ensureAudio() {
    if (!this.context) {
      this.context = new AudioContext({sampleRate:48000,latencyHint:'interactive'});
      await this.context.audioWorklet.addModule('soundlane-worklet.js');
      this.worklet = new AudioWorkletNode(this.context,'soundlane-relay-player',{outputChannelCount:[2]});
      this.gain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = .82;
      this.worklet.connect(this.gain).connect(this.analyser).connect(this.context.destination);
    }
    this.gain.gain.value = this.muted ? 0 : this.volume;
    if (this.context.state === 'suspended') await this.context.resume();
  }
  async connect({server}) {
    this.disconnect();
    if (!server) throw new Error('Servidor Soundlane indisponível.');
    this.server=server; this.intentionalClose=false;
    await this.ensureAudio();
    this.emit('status',{state:'connecting',text:'conectando ao áudio'});
    this.connectListener(server);
    this.connectMetadata(server);
  }
  connectListener(server) {
    const socket = new WebSocket(this.endpoint(server,'/api/v1/window-host/listen'));
    socket.binaryType='arraybuffer'; this.listenerSocket=socket;
    socket.onmessage=event=>this.handleListenerMessage(event).catch(error=>this.emit('status',{state:'error',text:error.message}));
    socket.onerror=()=>this.emit('status',{state:'error',text:'falha na conexão'});
    socket.onclose=()=>{ if(this.listenerSocket!==socket)return; this.listenerSocket=null; this.clearAudio(); this.emit('status',{state:'idle',text:'reconectando'}); this.scheduleReconnect(); };
  }
  connectMetadata(server) {
    const socket = new WebSocket(this.endpoint(server,'/api/v1/window-host/metadata/subscribe'));
    this.metadataSocket=socket;
    socket.onmessage=event=>{ try { const data=JSON.parse(event.data); if(data.type==='browser_metadata'){ const tab=data.tabs?.find(item=>item.audible&&!item.muted)||data.tabs?.[0]; this.emit('metadata',tab?{title:tab.title,source:tab.origin||data.browser,icon:tab.favIconUrl,browser:data.browser}:{title:'Soundlane conectado',source:'aguardando algo tocar no PC',icon:'',browser:data.browser}); } } catch {} };
    socket.onclose=()=>{ if(this.metadataSocket===socket){this.metadataSocket=null;this.scheduleReconnect();} };
  }
  scheduleReconnect(){if(this.intentionalClose||this.reconnectTimer)return;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=0;if(!this.server)return;if(!this.listenerSocket)this.connectListener(this.server);if(!this.metadataSocket)this.connectMetadata(this.server)},2500)}
  getFrequencyData(){if(!this.analyser)return null;const data=new Uint8Array(this.analyser.frequencyBinCount);this.analyser.getByteFrequencyData(data);return data}
  async handleListenerMessage(event) {
    if (typeof event.data === 'string') {
      try { const message=JSON.parse(event.data); if(message.type==='format')await this.configureCodec(message.codec); if(message.type==='ready'){if(message.codec)await this.configureCodec(message.codec);this.emit('status',{state:'live',text:message.live?(message.activeClientName?`recebendo de ${message.activeClientName}`:'recebendo áudio'):'conectado · aguardando áudio'});} if(message.type==='jam')this.emit('status',{state:'live',text:message.active?`recebendo de ${message.activeClientName||'outro participante'}`:'conectado · aguardando áudio'}); } catch {}
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    const bytes=new Uint8Array(event.data);
    if(this.codec==='opus'||bytes[2]===0x02){await this.ensureDecoder();this.decodeOpus(event.data);}else{this.worklet.port.postMessage(event.data,[event.data]);}
    this.emit('playing',{});
  }
  async configureCodec(codec) { this.codec=codec||'pcm-f32'; this.worklet?.port.postMessage({type:'clear'}); if(this.codec==='opus')await this.ensureDecoder(); }
  async ensureDecoder() {
    if(this.decoder&&this.decoder.state!=='closed')return;
    if(!('AudioDecoder' in window))throw new Error('Este navegador não oferece o decoder de áudio necessário.');
    const config={codec:'opus',sampleRate:48000,numberOfChannels:2};
    const support=await AudioDecoder.isConfigSupported(config); if(!support.supported)throw new Error('Opus não é suportado neste navegador.');
    this.decoderTimestamp=0;
    this.decoder=new AudioDecoder({output:data=>this.deliverAudio(data),error:error=>this.emit('status',{state:'error',text:error.message})});
    this.decoder.configure(config);
  }
  decodeOpus(buffer) { const bytes=new Uint8Array(buffer); if(bytes.length<=12||bytes[0]!==0x53||bytes[1]!==0x4c||bytes[2]!==0x02)return; const packet=bytes.slice(12); this.decoder.decode(new EncodedAudioChunk({type:'key',timestamp:this.decoderTimestamp,duration:20000,data:packet})); this.decoderTimestamp+=20000; }
  async deliverAudio(data) { try { const frames=data.numberOfFrames,left=new Float32Array(frames),right=new Float32Array(frames); await data.copyTo(left,{planeIndex:0,format:'f32-planar'}); if(data.numberOfChannels>1)await data.copyTo(right,{planeIndex:1,format:'f32-planar'});else right.set(left); const interleaved=new Float32Array(frames*2); for(let i=0;i<frames;i++){interleaved[i*2]=left[i];interleaved[i*2+1]=right[i];} this.worklet.port.postMessage(interleaved.buffer,[interleaved.buffer]); this.emit('playing',{}); } finally {data.close();} }
  setVolume(value){this.volume=Math.max(0,Math.min(1,value));if(this.gain)this.gain.gain.value=this.muted?0:this.volume;}
  setMuted(value){this.muted=!!value;if(this.gain)this.gain.gain.value=this.muted?0:this.volume;}
  clearAudio(){this.worklet?.port.postMessage({type:'clear'});if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();this.decoder=null;this.codec='pcm-f32';}
  disconnect(){this.intentionalClose=true;clearTimeout(this.reconnectTimer);this.reconnectTimer=0;this.listenerSocket?.close();this.metadataSocket?.close();this.listenerSocket=null;this.metadataSocket=null;this.clearAudio();}
}
window.SoundlanePlayer = SoundlanePlayer;
