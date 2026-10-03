const STORAGE = { favorites:'janela:favorites', settings:'janela:settings', custom:'janela:custom-cameras', newsPool:'janela:news-pool-v2', newsHistory:'janela:news-history-v2' };
const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeStore = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const customCameras = readStore(STORAGE.custom, []);
const cameras = [...(window.JANELA_CAMERAS || []), ...customCameras];
const cameraByKey = Object.fromEntries(cameras.map(camera => [camera.key, camera]));
const favorites = new Set(readStore(STORAGE.favorites, []));
const settings = { preferHd:true, showAnime:true, showChat:true, autoRotate:true, rotationSeconds:45, newsSeconds:9, animeSeconds:11, language:'pt-BR', ...readStore(STORAGE.settings, {}) };
const soundlaneSettings = { server:location.protocol==='https:'?location.origin:'https://p01--soundlane-bot--xz6744xjl6hb.code.run' };
const sharedSession = new URLSearchParams(location.hash.replace(/^#/,''));
if (sharedSession.get('lang')) settings.language = sharedSession.get('lang');

const I18N = {
  en:{'Agora':'Now','Mosaico':'Mosaic','Horizonte':'Horizon','Favoritas':'Favorites','Ajustes':'Settings','Som':'Sound','o mundo acontecendo agora':'the world happening now','lugares vivos':'live places','Manchetes':'Headlines','Chat ao vivo':'Live chat','Daqui, agora':'Here, now','vida local antes do ruído':'local life before the noise','ATUALIZANDO':'UPDATING','tendências da temporada':'season trends','Preferências':'Preferences','Rotação automática':'Automatic rotation','Tempo em cada câmera':'Time per camera','Tempo por notícia':'Time per story','Tempo por anime':'Time per anime','Idioma':'Language','Preferir alta definição':'Prefer high definition','Mostrar anime':'Show anime','Página compartilhável':'Shareable page','Conectar':'Connect'},
  fr:{'Agora':'Maintenant','Mosaico':'Mosaïque','Horizonte':'Horizon','Favoritas':'Favoris','Ajustes':'Réglages','Som':'Son','o mundo acontecendo agora':'le monde en direct','lugares vivos':'lieux en direct','Manchetes':'Actualités','Chat ao vivo':'Chat en direct','Daqui, agora':'Ici, maintenant','vida local antes do ruído':'la vie locale avant le bruit','ATUALIZANDO':'ACTUALISATION','tendências da temporada':'tendances de la saison','Preferências':'Préférences','Rotação automática':'Rotation automatique','Tempo em cada câmera':'Temps par caméra','Tempo por notícia':'Temps par actualité','Tempo por anime':'Temps par anime','Idioma':'Langue','Preferir alta definição':'Préférer la haute définition','Mostrar anime':'Afficher les anime','Conectar':'Connecter'},
  es:{'Agora':'Ahora','Mosaico':'Mosaico','Horizonte':'Horizonte','Favoritas':'Favoritas','Ajustes':'Ajustes','Som':'Sonido','o mundo acontecendo agora':'el mundo sucediendo ahora','lugares vivos':'lugares en vivo','Manchetes':'Titulares','Chat ao vivo':'Chat en vivo','Daqui, agora':'Aquí, ahora','vida local antes do ruído':'vida local antes del ruido','ATUALIZANDO':'ACTUALIZANDO','tendências da temporada':'tendencias de temporada','Preferências':'Preferencias','Rotação automática':'Rotación automática','Tempo em cada câmera':'Tiempo por cámara','Tempo por notícia':'Tiempo por noticia','Tempo por anime':'Tiempo por anime','Idioma':'Idioma','Preferir alta definição':'Preferir alta definición','Mostrar anime':'Mostrar anime','Conectar':'Conectar'},
  it:{'Agora':'Ora','Mosaico':'Mosaico','Horizonte':'Orizzonte','Favoritas':'Preferite','Ajustes':'Impostazioni','Som':'Audio','o mundo acontecendo agora':'il mondo in diretta','lugares vivos':'luoghi in diretta','Manchetes':'Notizie','Chat ao vivo':'Chat dal vivo','Daqui, agora':'Qui, ora','vida local antes del ruido':'vita locale prima del rumore','ATUALIZANDO':'AGGIORNAMENTO','tendências da temporada':'tendenze stagionali','Preferências':'Preferenze','Rotação automática':'Rotazione automatica','Tempo em cada câmera':'Tempo per telecamera','Tempo por notícia':'Tempo per notizia','Tempo por anime':'Tempo per anime','Idioma':'Lingua','Preferir alta definição':'Preferisci alta definizione','Mostrar anime':'Mostra anime','Conectar':'Connetti'},
  de:{'Agora':'Jetzt','Mosaico':'Mosaik','Horizonte':'Horizont','Favoritas':'Favoriten','Ajustes':'Einstellungen','Som':'Ton','o mundo acontecendo agora':'die Welt passiert jetzt','lugares vivos':'Live-Orte','Manchetes':'Schlagzeilen','Chat ao vivo':'Live-Chat','Daqui, agora':'Hier, jetzt','vida local antes do ruído':'lokales Leben vor dem Lärm','ATUALIZANDO':'AKTUALISIERUNG','tendências da temporada':'Saisontrends','Preferências':'Einstellungen','Rotação automática':'Automatische Rotation','Tempo em cada câmera':'Zeit pro Kamera','Tempo por notícia':'Zeit pro Meldung','Tempo por anime':'Zeit pro Anime','Idioma':'Sprache','Preferir alta definição':'Hohe Auflösung bevorzugen','Mostrar anime':'Anime anzeigen','Conectar':'Verbinden'}
};
const originalText = new WeakMap();
const t = value => I18N[settings.language]?.[value] || value;
function applyLanguage(){document.documentElement.lang=settings.language;document.querySelectorAll('body *').forEach(node=>{if(node.children.length||!node.textContent.trim())return;const original=originalText.get(node)||node.textContent.trim();originalText.set(node,original);node.textContent=t(original)});$('#languageSelect').value=settings.language;$('#settingsLanguage').value=settings.language;}

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const toast = $('#toast');
const tickerTrack = $('#tickerTrack');
const liveShell = document.createElement('div');
liveShell.className = 'live-player-shell';
let currentKey = [...favorites].find(key=>cameraByKey[key]) || (cameraByKey.shibuya ? 'shibuya' : cameras[0]?.key);
let currentView = 'agora';
let soundEnabled = false;
let playerSignature = '';
let toastTimer;
let newsTimer;
let newsCarouselTimer;
let newsItems = [];
let newsIndex = 0;
let animeItems = [];
let animeIndex = 0;
let animeTimer;
let rotationTimer;
let rotationTicker;
let rotationRemaining = Number(settings.rotationSeconds) || 45;
let activeRegion = 'Todos';
const soundlane = new window.SoundlanePlayer();

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function safeTime(camera) {
  try { return new Intl.DateTimeFormat('pt-BR', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:camera.timezone }).format(new Date()); }
  catch { return new Intl.DateTimeFormat('pt-BR', { hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date()); }
}

function playerUrl(camera, muted = true, controls = true) {
  const quality = settings.preferHd ? '&vq=hd1080' : '';
  return `https://www.youtube-nocookie.com/embed/${camera.video}?autoplay=1&mute=${muted ? 1 : 0}&controls=${controls ? 1 : 0}&rel=0&playsinline=1${quality}`;
}

function sourceUrl(camera) { return `https://www.youtube.com/watch?v=${camera.video}`; }

function createPlayer(camera, { muted=true, controls=true, title=`${camera.city} ao vivo` } = {}) {
  const iframe = document.createElement('iframe');
  iframe.src = playerUrl(camera, muted, controls);
  iframe.title = title;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allowFullscreen = true;
  return iframe;
}

function mountMainPlayer(host, force = false) {
  const camera = cameraByKey[currentKey];
  if (!camera || !host) return;
  host.appendChild(liveShell);
  const controls = currentView !== 'horizonte';
  const signature = `${currentKey}:${soundEnabled}:${controls}:${settings.preferHd}`;
  if (force || signature !== playerSignature || !liveShell.firstChild) {
    liveShell.replaceChildren(createPlayer(camera, { muted:!soundEnabled, controls, title:`${camera.city} ao vivo — ${camera.source}` }));
    playerSignature = signature;
  }
}

function updateClocks() {
  $$('.city-time[data-place]').forEach(button => {
    const camera = cameraByKey[button.dataset.place];
    if (camera) button.querySelector('strong').textContent = safeTime(camera);
  });
  const camera = cameraByKey[currentKey];
  if (!camera) return;
  $('#focusTime').textContent = safeTime(camera);
  $('#horizonTime').textContent = safeTime(camera);
}

function orderedCameras() {
  const favs = cameras.filter(camera => favorites.has(camera.key));
  const rest = cameras.filter(camera => !favorites.has(camera.key));
  return [...favs, ...rest];
}

function updateRotationUi() {
  $('#rotationCountdown').textContent = Math.max(0,rotationRemaining);
  $('#rotationStatus').classList.toggle('paused',!settings.autoRotate);
  $('#pauseRotation').textContent = settings.autoRotate ? 'Ⅱ' : '▶';
  $('#pauseRotation').setAttribute('aria-label',settings.autoRotate?'Pausar rotação':'Retomar rotação');
}

function scheduleRotation(reset = true) {
  clearTimeout(rotationTimer); clearInterval(rotationTicker);
  if (reset) rotationRemaining = Number(settings.rotationSeconds) || 45;
  updateRotationUi();
  if (!settings.autoRotate || currentView === 'mosaico') return;
  rotationTicker = setInterval(()=>{ rotationRemaining-=1; updateRotationUi(); },1000);
  rotationTimer = setTimeout(()=>{
    const queue=orderedCameras(); const index=queue.findIndex(camera=>camera.key===currentKey);
    const next=queue[(index+1+queue.length)%queue.length];
    selectCamera(next.key,currentView,true);
  },rotationRemaining*1000);
}

function renderWorldline() {
  const keys = [currentKey, ...favorites, 'geiranger', 'shibuya', 'hongdae', 'copacabana', 'nazare'].filter((key, index, all) => cameraByKey[key] && all.indexOf(key) === index).slice(0,5);
  const host = $('#worldlineCities');
  host.replaceChildren(...keys.map(key => {
    const camera = cameraByKey[key];
    const button = document.createElement('button');
    button.className = `city-time${key === currentKey ? ' active' : ''}`;
    button.dataset.place = key;
    button.innerHTML = `<span>${camera.city.split(' — ')[0]}</span><strong>${safeTime(camera)}</strong>`;
    button.addEventListener('click', () => selectCamera(key));
    return button;
  }));
}

function renderHorizonSuggestions() {
  const host = $('#horizonSuggestions');
  host.replaceChildren(...orderedCameras().filter(c => c.key !== currentKey).slice(0,3).map(camera => {
    const button = document.createElement('button');
    button.textContent = camera.city.split(' — ')[0];
    button.addEventListener('click', () => selectCamera(camera.key, 'horizonte'));
    return button;
  }));
}

function clearMosaicStreams() { $$('.tile-live').forEach(node => node.remove()); }

function renderMosaic() {
  const host = $('#mosaicGrid');
  const selected = orderedCameras().filter(camera => camera.key !== currentKey);
  selected.unshift(cameraByKey[currentKey]);
  const visible = selected.slice(0,5);
  host.replaceChildren(...visible.map((camera, index) => {
    const tile = document.createElement('article');
    tile.className = `mosaic-tile visual-card${index === 0 ? ' featured' : ''}`;
    tile.tabIndex = 0;
    tile.dataset.place = camera.key;
    tile.innerHTML = `<img src="${camera.poster}" alt="${camera.city} ao vivo"><div class="media-scrim"></div><span class="place-badge"><i></i> AO VIVO · ${camera.quality}</span><button class="tile-favorite" aria-label="Favoritar ${camera.city}">${favorites.has(camera.key) ? '★' : '☆'}</button><div class="tile-copy"><span>${camera.city.toUpperCase()}</span><p>${camera.country} · transmissão direta</p></div>`;
    tile.addEventListener('click', event => { if (!event.target.closest('.tile-favorite')) selectCamera(camera.key, 'agora'); });
    tile.addEventListener('keydown', event => { if (event.key === 'Enter') selectCamera(camera.key, 'agora'); });
    tile.querySelector('.tile-favorite').addEventListener('click', () => toggleFavorite(camera.key));
    if (index < 3) {
      const holder = document.createElement('div');
      holder.className = 'tile-live';
      holder.appendChild(createPlayer(camera, { muted:true, controls:false }));
      tile.prepend(holder);
    }
    return tile;
  }));
}

function setView(name, announce = true) {
  currentView = name;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.rail-button[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  clearMosaicStreams();
  if (name === 'agora') mountMainPlayer($('#focusHost'));
  if (name === 'horizonte') mountMainPlayer($('#horizonHost'));
  if (name === 'mosaico') { liveShell.remove(); renderMosaic(); }
  scheduleRotation(false);
  if (announce) showToast({ agora:`${cameraByKey[currentKey].city} em foco`, mosaico:'Mosaico vivo aberto', horizonte:'Modo Horizonte' }[name]);
}

const weatherLabels = {0:'céu limpo',1:'quase limpo',2:'parcialmente nublado',3:'nublado',45:'neblina',48:'neblina',51:'garoa leve',53:'garoa',55:'garoa forte',61:'chuva leve',63:'chuva',65:'chuva forte',71:'neve leve',73:'neve',75:'neve forte',80:'pancadas de chuva',81:'pancadas de chuva',82:'chuva intensa',95:'trovoadas',96:'trovoadas e granizo',99:'tempestade'};
async function updateWeather() {
  const camera = cameraByKey[currentKey];
  $('#focusTemp').textContent = '--°C';
  $('#focusWeather').textContent = camera.lat == null ? 'clima não configurado' : 'atualizando clima';
  if (camera.lat == null) { $('#horizonWeather').textContent = 'clima não configurado'; return; }
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${camera.lat}&longitude=${camera.lon}&current=temperature_2m,weather_code&timezone=auto`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    const temp = `${Math.round(data.current.temperature_2m)}°C`;
    const label = weatherLabels[data.current.weather_code] || 'condições atuais';
    $('#focusTemp').textContent = temp; $('#focusWeather').textContent = label; $('#horizonWeather').textContent = `${temp} · ${label}`;
  } catch { $('#focusWeather').textContent = 'clima indisponível'; $('#horizonWeather').textContent = 'clima indisponível'; }
}

const sensitiveNews = /acidente|colisão|atropel|morte|morre|crime|assalto|roubo|homicídio|trânsito|crash|collision|killed|murder|robbery/i;
const breakingNews = /urgente|breaking|alerta|emergência|evacua|terremoto|tsunami|desastre|tempestade|incêndio de grandes proporções|earthquake|emergency|evacuation|wildfire/i;
function cleanTitle(title='') { return title.replace(/\s+-\s+[^-]+$/, '').trim(); }
function filteredNews(items) {
  const preferred = items.filter(item => !sensitiveNews.test(item.title || '') || breakingNews.test(item.title || ''));
  const unique=[]; const seen=new Set();
  for(const item of (preferred.length>=3?preferred:items)){
    const key=cleanTitle(item.title).toLocaleLowerCase('pt-BR').replace(/\W/g,'');
    if(!key||seen.has(key))continue; seen.add(key); unique.push(item);
  }
  return unique.slice(0,12);
}
function renderNewsSlide() {
  const list = $('#localNewsList');
  if(!newsItems.length){list.innerHTML='<p class="panel-empty">As manchetes não responderam agora.</p>';return;}
  newsIndex=(newsIndex+newsItems.length)%newsItems.length;
  const item=newsItems[newsIndex]; const when=item.pubDate?new Date(item.pubDate):new Date();
  const link=document.createElement('a');link.className='news-feature';link.href=item.link;link.target='_blank';link.rel='noopener';
  const visual=document.createElement('div');visual.className='news-visual';
  const number=document.createElement('span');number.className='news-number';number.textContent=String(newsIndex+1).padStart(2,'0');visual.append(number);
  const fallbackImage=`https://i.ytimg.com/vi/${cameraByKey[currentKey]?.video}/maxresdefault.jpg`;
  const image=document.createElement('img');image.src=item.image||fallbackImage;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';image.addEventListener('error',()=>{if(image.src!==fallbackImage)image.src=fallbackImage;else visual.classList.add('image-failed')});visual.prepend(image);
  const copy=document.createElement('div'),time=document.createElement('time'),title=document.createElement('h3'),meta=document.createElement('p');
  time.textContent=`${when.toLocaleTimeString(settings.language,{hour:'2-digit',minute:'2-digit'})} · ${item.author||'fonte local'}`;title.textContent=cleanTitle(item.title);meta.textContent='Notícia selecionada entre diferentes fontes locais · abrir matéria';copy.append(time,title,meta);link.append(visual,copy);list.replaceChildren(link);
  rememberHeadline(item.title);
  $('#newsDots').innerHTML=newsItems.slice(0,8).map((_,i)=>`<i class="${i===newsIndex%8?'active':''}"></i>`).join('');
}
function startNewsCarousel(){clearInterval(newsCarouselTimer);newsCarouselTimer=setInterval(()=>{newsIndex+=1;renderNewsSlide()},Math.max(4,Number(settings.newsSeconds)||9)*1000)}
function renderNews(items) {
  newsItems=items; newsIndex=0; renderNewsSlide(); startNewsCarousel();
  tickerTrack.replaceChildren(); tickerTrack.classList.remove('is-short');
  const doubled = [...items, ...items];
  doubled.forEach(item => {
    const span = document.createElement('span');
    const time = document.createElement('time');
    time.textContent = new Date(item.pubDate || Date.now()).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    const link = document.createElement('a'); link.href=item.link; link.target='_blank'; link.rel='noopener'; link.textContent=cleanTitle(item.title);
    span.append(time,link); tickerTrack.append(span,document.createElement('i'));
  });
}
function imageFromHtml(html=''){try{const doc=new DOMParser().parseFromString(html,'text/html');return doc.querySelector('img')?.src||''}catch{return''}}
function normalizeNewsItem(item){return{title:item.title||'',link:item.link||'',pubDate:item.pubDate||item.published||'',author:item.author||item.source||'fonte local',image:item.image||item.thumbnail||item.enclosure?.link||item.enclosure?.url||imageFromHtml(item.description||item.content||'')}}
async function fetchLocalNews(feed) {
  try {
    const response = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed)}`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!data.items?.length) throw new Error();
    return data.items.map(normalizeNewsItem);
  } catch {
    const response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(feed)}`);
    if (!response.ok) throw new Error();
    const xml = new DOMParser().parseFromString(await response.text(),'application/xml');
    return [...xml.querySelectorAll('item')].map(item => normalizeNewsItem({
      title:item.querySelector('title')?.textContent || '',
      link:item.querySelector('link')?.textContent || '',
      pubDate:item.querySelector('pubDate')?.textContent || '',
      author:item.querySelector('source')?.textContent || 'fonte local',
      image:item.querySelector('enclosure[type^="image"]')?.getAttribute('url') || item.querySelector('content[url]')?.getAttribute('url') || item.querySelector('thumbnail[url]')?.getAttribute('url') || imageFromHtml(item.querySelector('description')?.textContent || '')
    }));
  }
}
const newsPool = readStore(STORAGE.newsPool,[]).filter(item=>Date.now()-(item.cachedAt||0)<48*60*60*1000);
let newsHistory = readStore(STORAGE.newsHistory,[]).slice(-60);
let newsWarmIndex=0;
function headlineKey(title=''){return cleanTitle(title).toLocaleLowerCase(settings.language).replace(/[^\p{L}\p{N}]+/gu,'').slice(0,180)}
function rememberHeadline(title){const key=headlineKey(title);if(!key)return;newsHistory=[...newsHistory.filter(item=>item!==key),key].slice(-60);writeStore(STORAGE.newsHistory,newsHistory)}
function mergeNewsPool(items){const merged=new Map(newsPool.map(item=>[headlineKey(item.title),item]));for(const item of items){const key=headlineKey(item.title);if(key)merged.set(key,{...item,cachedAt:Date.now()})}newsPool.splice(0,newsPool.length,...[...merged.values()].sort((a,b)=>new Date(b.pubDate||0)-new Date(a.pubDate||0)).slice(0,180));writeStore(STORAGE.newsPool,newsPool)}
function freshNewsFor(camera,items){const place=(camera.city+' '+camera.country).toLocaleLowerCase(settings.language);const combined=filteredNews([...items,...newsPool]);const unseen=combined.filter(item=>!newsHistory.includes(headlineKey(item.title)));const local=unseen.filter(item=>(item.title+' '+item.author).toLocaleLowerCase(settings.language).includes(camera.country.toLocaleLowerCase(settings.language))||(item.title+' '+item.author).toLocaleLowerCase(settings.language).includes(camera.city.split(' — ')[0].toLocaleLowerCase(settings.language)));return [...local,...unseen,...combined].filter((item,index,all)=>all.findIndex(candidate=>headlineKey(candidate.title)===headlineKey(item.title))===index).slice(0,12)}
async function searchNewsFor(camera){const queries=[camera.news,`${camera.city} ${camera.country} local news`,`${camera.country} cultura tecnologia sociedade`];let items=[];try{const server=(soundlaneSettings.server||'https://p01--soundlane-bot--xz6744xjl6hb.code.run').replace(/\/$/,'');const responses=await Promise.all(queries.map(async query=>{const response=await fetch(`${server}/api/v1/news?q=${encodeURIComponent(query)}&lang=${encodeURIComponent(settings.language)}&limit=18`);if(!response.ok)throw new Error();return(await response.json()).items||[]}));items=responses.flat().map(normalizeNewsItem)}catch{const localeMap={'pt-BR':'pt-br',en:'en-us',fr:'fr-fr',es:'es-es',it:'it-it',de:'de-de'};const locale=localeMap[settings.language]||'pt-br';const feeds=queries.map(query=>`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=${locale}`);const batches=await Promise.allSettled(feeds.map(fetchLocalNews));items=batches.flatMap(result=>result.status==='fulfilled'?result.value:[])}mergeNewsPool(items);return items}
async function updateNews() {
  const camera = cameraByKey[currentKey];
  clearTimeout(newsTimer);
  $('#newsHeading').textContent = `${camera.city.split(' — ')[0]}, agora`;
  $('#localNewsList').innerHTML = '<p class="panel-empty">Buscando jornais e fontes locais…</p>';
  tickerTrack.className = 'ticker-track is-short'; tickerTrack.innerHTML = `<span class="news-loading">Buscando notícias recentes de ${camera.city}…</span>`;
  try {
    const items=freshNewsFor(camera,await searchNewsFor(camera));
    if (!items.length) throw new Error();
    renderNews(items);
  } catch {
    $('#localNewsList').innerHTML = '<p class="panel-empty">As manchetes locais não responderam agora. A câmera continua viva.</p>';
    tickerTrack.innerHTML = '<span class="news-loading">Manchetes temporariamente indisponíveis · transmissão continua ao vivo</span>';
  }
  newsTimer = setTimeout(updateNews, 2 * 60 * 1000);
}
async function warmNewsCache(){const queue=orderedCameras();const batch=queue.slice(newsWarmIndex,newsWarmIndex+3);newsWarmIndex=(newsWarmIndex+3)%Math.max(1,queue.length);await Promise.allSettled(batch.map(searchNewsFor))}

function renderAnime() {
  const host = $('#animeCarousel');
  if (!animeItems.length) { host.innerHTML = '<p class="panel-empty">A temporada não respondeu agora.</p>'; return; }
  animeIndex = (animeIndex + animeItems.length) % animeItems.length;
  const anime = animeItems[animeIndex];
  const dots = animeItems.slice(0,6).map((_,i) => `<i class="${i === animeIndex % 6 ? 'active' : ''}"></i>`).join('');
  host.innerHTML = `<a class="anime-slide" href="${anime.url}" target="_blank" rel="noopener"><img src="${anime.cover}" alt="Capa de ${anime.title}"><div class="anime-copy"><span>${anime.score ? `NOTA ${anime.score}` : 'EM EXIBIÇÃO'}</span><h3>${anime.title}</h3><p>${anime.detail || 'Em exibição nesta temporada'} · abrir fonte ↗</p><div class="anime-dots">${dots}</div></div></a>`;
}
function startAnimeCarousel(){clearInterval(animeTimer);animeTimer=setInterval(()=>{animeIndex+=1;renderAnime()},Math.max(5,Number(settings.animeSeconds)||11)*1000)}
async function loadAnime() {
  if (!settings.showAnime) { $('#animeCard').hidden = true; return; }
  $('#animeCard').hidden = false;
  try {
    const response = await fetch('https://api.jikan.moe/v4/seasons/now?limit=8&sfw=true');
    if (!response.ok) throw new Error();
    const json = await response.json();
    animeItems = (json.data || []).slice(0,8).map(item => ({ title:item.title_english || item.title, cover:item.images?.jpg?.large_image_url, score:item.score, detail:item.episodes ? `${item.episodes} episódios` : item.status, url:item.url }));
  } catch {
    try {
      const query = `query { Page(page:1,perPage:8){media(type:ANIME,status:RELEASING,sort:TRENDING_DESC){title{romaji english}coverImage{large}averageScore siteUrl nextAiringEpisode{episode timeUntilAiring}}}}`;
      const response = await fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query})});
      const json = await response.json();
      animeItems = (json.data?.Page?.media || []).map(item => ({ title:item.title.english || item.title.romaji, cover:item.coverImage.large, score:item.averageScore ? `${item.averageScore}%` : '', detail:item.nextAiringEpisode ? `episódio ${item.nextAiringEpisode.episode} a caminho` : 'em exibição', url:item.siteUrl }));
    } catch { animeItems = []; }
  }
  animeIndex = 0; renderAnime(); startAnimeCarousel();
}

function mountChat() {
  const host = $('#chatHost');
  host.replaceChildren();
  if (!settings.showChat) { host.innerHTML = '<p class="panel-empty">O chat está oculto nas preferências.</p>'; return; }
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube.com/live_chat?v=${cameraByKey[currentKey].video}&embed_domain=${encodeURIComponent(location.hostname || 'localhost')}`;
  iframe.title = `Chat ao vivo de ${cameraByKey[currentKey].city}`;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  host.appendChild(iframe);
}

function selectCamera(key, targetView = currentView === 'mosaico' ? 'agora' : currentView, fromRotation = false) {
  const camera = cameraByKey[key];
  if (!camera) return;
  currentKey = key; playerSignature = '';
  $('#focusCity').textContent = camera.city; $('#focusCountry').textContent = camera.country.toUpperCase();
  $('#focusPoster').src = camera.poster; $('.horizon-image').src = camera.poster;
  $('#horizonPlace').textContent = `${camera.city.toUpperCase()} · ${camera.country.toUpperCase()}`;
  $('#qualityBadge').textContent = camera.quality || 'HD';
  $('#mainCaption').textContent = `Sinal ao vivo fornecido por ${camera.source}.`;
  $('#sourceLink').href = sourceUrl(camera); $('#sourceLink').textContent = `${camera.source} ↗`;
  $('#favoritePlace').classList.toggle('on', favorites.has(key)); $('#favoritePlace').textContent = favorites.has(key) ? '★' : '☆';
  renderWorldline(); renderHorizonSuggestions(); updateClocks(); updateWeather(); updateNews(); mountChat(); setView(targetView,false);
  scheduleRotation(true);
  showToast(fromRotation?`A Janela viajou para ${camera.city}`:`${camera.city} está ao vivo`);
}

function toggleFavorite(key = currentKey) {
  if (favorites.has(key)) favorites.delete(key); else favorites.add(key);
  writeStore(STORAGE.favorites,[...favorites]);
  $('#favoriteCount').textContent = favorites.size; $('#favoriteCount').classList.toggle('visible',favorites.size>0);
  if (key === currentKey) { $('#favoritePlace').classList.toggle('on',favorites.has(key)); $('#favoritePlace').textContent=favorites.has(key)?'★':'☆'; }
  renderWorldline(); renderCatalog(); if (currentView === 'mosaico') renderMosaic();
  showToast(favorites.has(key) ? `${cameraByKey[key].city} entrou nas favoritas` : 'Removida das favoritas');
}

function openSettings(favoritesOnly = false) {
  $('#settingsDrawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); $('#settingsDrawer').setAttribute('aria-hidden','false');
  if (favoritesOnly) { $('#cameraSearch').value = ''; activeRegion='Favoritas'; } else if (activeRegion === 'Favoritas') activeRegion='Todos';
  $$('#regionFilters button').forEach(button => button.classList.toggle('active',button.dataset.region===activeRegion));
  renderCatalog(); setTimeout(() => $('#cameraSearch').focus(),300);
}
function closeSettings() { $('#settingsDrawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); $('#settingsDrawer').setAttribute('aria-hidden','true'); }

function renderCatalog() {
  const term = $('#cameraSearch').value.trim().toLocaleLowerCase('pt-BR');
  const filtered = orderedCameras().filter(camera => {
    const matchRegion = activeRegion === 'Todos' || (activeRegion === 'Favoritas' ? favorites.has(camera.key) : camera.region === activeRegion);
    const text = `${camera.city} ${camera.country} ${(camera.tags||[]).join(' ')}`.toLocaleLowerCase('pt-BR');
    return matchRegion && text.includes(term);
  });
  $('#catalogResultCount').textContent = `${filtered.length} ${filtered.length===1?'lugar':'lugares'}`;
  const host = $('#cameraCatalog');
  if (!filtered.length) { host.innerHTML='<p class="panel-empty">Nenhuma janela encontrada.</p>'; return; }
  host.replaceChildren(...filtered.map(camera => {
    const card = document.createElement('article'); card.className='camera-card';
    card.innerHTML=`<img src="${camera.poster}" alt=""><span class="cam-quality">● AO VIVO · ${camera.quality||'HD'}</span><button class="cam-star ${favorites.has(camera.key)?'on':''}" aria-label="Favoritar">${favorites.has(camera.key)?'★':'☆'}</button><button class="cam-copy" aria-label="Abrir ${camera.city}" style="border:0;background:none;text-align:left;color:inherit"><b>${camera.city}</b><span>${camera.country} · ${camera.source}</span></button>`;
    card.querySelector('.cam-copy').addEventListener('click',()=>{closeSettings();selectCamera(camera.key,'agora')});
    card.querySelector('.cam-star').addEventListener('click',()=>toggleFavorite(camera.key));
    return card;
  }));
}

function parseYoutubeId(value) {
  try { const url = new URL(value); if (url.hostname.includes('youtu.be')) return url.pathname.slice(1).split('/')[0]; if (url.pathname.includes('/embed/')) return url.pathname.split('/embed/')[1].split('/')[0]; return url.searchParams.get('v'); } catch { return null; }
}

function savePreferences() {
  settings.preferHd=$('#preferHd').checked; settings.showAnime=$('#showAnime').checked; settings.showChat=$('#showChat').checked; settings.autoRotate=$('#autoRotate').checked; settings.rotationSeconds=Number($('#rotationSeconds').value)||45;settings.newsSeconds=Number($('#newsSeconds').value)||9;settings.animeSeconds=Number($('#animeSeconds').value)||11;settings.language=$('#settingsLanguage').value||'pt-BR';
  writeStore(STORAGE.settings,settings); $('#animeCard').hidden=!settings.showAnime; playerSignature=''; mountChat();
  if (settings.showAnime && !animeItems.length) loadAnime();
  if (currentView!=='mosaico') mountMainPlayer(currentView==='horizonte'?$('#horizonHost'):$('#focusHost'),true);
  scheduleRotation(true);startNewsCarousel();startAnimeCarousel();applyLanguage();
  showToast('Preferências salvas neste dispositivo');
}

function setSoundlaneUi(state,text){$('#soundlaneState').textContent=text;$('.soundlane-bar').dataset.state=state;$('#soundscapeLabel').textContent=state==='live'?'SINAL AO VIVO':state==='connecting'?'CONECTANDO':'SINAL EM ESPERA'}
async function connectSoundlane(){
  try{await soundlane.connect(soundlaneSettings);setSoundlaneUi('connecting','à espera do Soundlane')}catch(error){setSoundlaneUi('error','servidor indisponível');console.warn(error)}
}
soundlane.addEventListener('status',event=>setSoundlaneUi(event.detail.state,event.detail.text));
soundlane.addEventListener('playing',()=>setSoundlaneUi('live','áudio ao vivo'));
soundlane.addEventListener('metadata',event=>{const data=event.detail;$('#soundlaneTitle').textContent=data.title||'Soundlane conectado';$('#soundlaneSource').textContent=[data.browser,data.source].filter(Boolean).join(' · ')||'áudio do seu computador';const icon=$('#soundlaneIcon');if(data.icon){icon.src=data.icon;icon.hidden=false}else icon.hidden=true});

function animateSoundscape(){
  const canvas=$('#soundscapeCanvas'),ctx=canvas.getContext('2d');let phase=0;
  function draw(){const ratio=devicePixelRatio||1,w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);if(canvas.width!==w*ratio||canvas.height!==h*ratio){canvas.width=w*ratio;canvas.height=h*ratio;ctx.setTransform(ratio,0,0,ratio,0,0)}ctx.clearRect(0,0,w,h);const bins=soundlane.getFrequencyData();const live=bins&&bins.some(value=>value>2);phase+=live ? .035 : .012;const gradient=ctx.createLinearGradient(0,0,w,0);gradient.addColorStop(0,'rgba(231,165,79,.15)');gradient.addColorStop(.5,'rgba(231,165,79,.95)');gradient.addColorStop(1,'rgba(221,69,53,.28)');ctx.strokeStyle=gradient;ctx.lineWidth=1.5;ctx.shadowColor='rgba(231,165,79,.35)';ctx.shadowBlur=8;ctx.beginPath();for(let x=0;x<=w;x+=3){const index=Math.min((bins?.length||1)-1,Math.floor((x/w)*(bins?.length||1)*.72));const energy=live?(bins[index]/255)*h*.42:0;const idle=Math.sin(x*.028+phase)*3+Math.sin(x*.009-phase*.7)*2;const y=h*.52+idle+(live?Math.sin(x*.04+phase*2)*energy-energy*.15:0);if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke();requestAnimationFrame(draw)}draw()
}

$$('[data-view]').forEach(button => button.addEventListener('click',()=>setView(button.dataset.view)));
$('#soundButton').addEventListener('click',event=>{soundEnabled=!soundEnabled;event.currentTarget.classList.toggle('active',soundEnabled);if(currentView!=='mosaico')mountMainPlayer(currentView==='horizonte'?$('#horizonHost'):$('#focusHost'),true);showToast(soundEnabled?'Som ao vivo ativado':'Transmissão silenciada')});
$('.soundscape-button').addEventListener('click',()=>$('#soundButton').click());
$('#reloadStream').addEventListener('click',()=>{mountMainPlayer($('#focusHost'),true);showToast('Reconectando à transmissão')});
$('#favoritePlace').addEventListener('click',()=>toggleFavorite());
$('#favoritesButton').addEventListener('click',()=>openSettings(true)); $('#settingsButton').addEventListener('click',()=>openSettings(false));
$('#closeSettings').addEventListener('click',closeSettings); $('#drawerBackdrop').addEventListener('click',closeSettings);
$('#cameraSearch').addEventListener('input',renderCatalog);
$$('#regionFilters button').forEach(button=>button.addEventListener('click',()=>{activeRegion=button.dataset.region;$$('#regionFilters button').forEach(b=>b.classList.toggle('active',b===button));renderCatalog()}));
['preferHd','showAnime','showChat','autoRotate'].forEach(id=>{ $(`#${id}`).checked=settings[id]; $(`#${id}`).addEventListener('change',savePreferences); });
$('#rotationSeconds').value=String(settings.rotationSeconds);$('#rotationSeconds').addEventListener('change',savePreferences);
$('#newsSeconds').value=String(settings.newsSeconds);$('#newsSeconds').addEventListener('change',savePreferences);
$('#animeSeconds').value=String(settings.animeSeconds);$('#animeSeconds').addEventListener('change',savePreferences);
$('#settingsLanguage').value=settings.language;$('#settingsLanguage').addEventListener('change',savePreferences);
$('#languageSelect').value=settings.language;$('#languageSelect').addEventListener('change',event=>{$('#settingsLanguage').value=event.target.value;savePreferences()});
$$('.panel-tabs button').forEach(button=>button.addEventListener('click',()=>{ $$('.panel-tabs button').forEach(b=>b.classList.toggle('active',b===button)); $$('.side-panel').forEach(panel=>panel.classList.toggle('active',panel.id===`panel-${button.dataset.panel}`)); if(button.dataset.panel==='chat')mountChat(); }));
$('#newsPrev').addEventListener('click',()=>{newsIndex--;renderNewsSlide();startNewsCarousel()});$('#newsNext').addEventListener('click',()=>{newsIndex++;renderNewsSlide();startNewsCarousel()});
$('#animePrev').addEventListener('click',()=>{animeIndex--;renderAnime();startAnimeCarousel()}); $('#animeNext').addEventListener('click',()=>{animeIndex++;renderAnime();startAnimeCarousel()});
$('#pauseRotation').addEventListener('click',()=>{settings.autoRotate=!settings.autoRotate;$('#autoRotate').checked=settings.autoRotate;writeStore(STORAGE.settings,settings);scheduleRotation(false);showToast(settings.autoRotate?'Rotação retomada':'Rotação pausada')});
$('#pauseTicker').addEventListener('click',event=>{tickerTrack.classList.toggle('paused');event.currentTarget.classList.toggle('is-paused')});
$('#fullscreenButton').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await $('#appShell').requestFullscreen();else await document.exitFullscreen()}catch{showToast('Tela cheia não está disponível')}});
$('#customCameraForm').addEventListener('submit',event=>{
  event.preventDefault(); const form=new FormData(event.currentTarget); const video=parseYoutubeId(form.get('url'));
  if(!video || !/^[\w-]{11}$/.test(video)){showToast('Não consegui reconhecer esse link do YouTube');return}
  const key=`custom-${video}`; const custom={key,city:form.get('city').trim(),country:form.get('country').trim(),region:'Personalizadas',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,video,source:'Câmera adicionada por você',news:`${form.get('city')} ${form.get('country')}`,tags:['personalizada'],quality:'HD',poster:`https://i.ytimg.com/vi/${video}/maxresdefault.jpg`,chat:true};
  const saved=readStore(STORAGE.custom,[]).filter(c=>c.key!==key); saved.push(custom); writeStore(STORAGE.custom,saved); showToast('Câmera adicionada — recarregando a Janela'); setTimeout(()=>location.reload(),700);
});
$('#soundlaneVolume').value=String(Math.round(soundlane.volume*100));$('#soundlaneVolume').addEventListener('input',event=>{const value=Number(event.target.value);$('#soundlaneVolumeValue').textContent=value;soundlane.setVolume(value/100)});
$('#soundlaneMute').addEventListener('click',event=>{soundlane.setMuted(!soundlane.muted);event.currentTarget.classList.toggle('active',soundlane.muted);event.currentTarget.textContent=soundlane.muted?'×':'◖';showToast(soundlane.muted?'Soundlane silenciado':'Som do Soundlane retomado')});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSettings();if(event.key==='1')setView('agora');if(event.key==='2')setView('mosaico');if(event.key==='3')setView('horizonte');if(event.key.toLowerCase()==='m')$('#soundButton').click()});

function registerWebMcpTools(){const context=document.modelContext;if(!context?.registerTool)return;context.registerTool({name:'show_live_place',title:'Mostrar câmera ao vivo',description:'Abre uma câmera ao vivo do catálogo da Janela.',inputSchema:{type:'object',properties:{place:{type:'string',enum:cameras.map(c=>c.key)}},required:['place'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute({place}){selectCamera(place,'agora');return{place,city:cameraByKey[place].city,status:'live_view_opened'}}});context.registerTool({name:'set_janela_view',title:'Mudar visualização',description:'Alterna entre Agora, Mosaico e Horizonte.',inputSchema:{type:'object',properties:{view:{type:'string',enum:['agora','mosaico','horizonte']}},required:['view'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute({view}){setView(view);return{view,status:'view_changed'}}})}

$('#liveCount').textContent=cameras.length; $('#favoriteCount').textContent=favorites.size; $('#favoriteCount').classList.toggle('visible',favorites.size>0); $('#animeCard').hidden=!settings.showAnime;
applyLanguage();renderCatalog(); renderWorldline(); renderHorizonSuggestions(); loadAnime(); selectCamera(currentKey,'agora');
setInterval(updateClocks,30000);setInterval(warmNewsCache,90*1000);setTimeout(warmNewsCache,12000);try{registerWebMcpTools()}catch{}
animateSoundscape();setTimeout(()=>connectSoundlane(),350);document.addEventListener('pointerdown',()=>soundlane.context?.resume(),{once:true});
if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});
