const API_URL = '/proxy/it/archive'; // Use proxy endpoint

// Dynamically determine the proxy server URL.
// If loaded via localhost:8000, use it. If on Render, use the origin. Otherwise, default to Render proxy URL.
const PROXY_URL = (window.location.hostname === 'localhost' && window.location.port === '8000')
  ? 'http://localhost:8000'
  : (window.location.hostname.includes('onrender.com') 
    ? window.location.origin 
    : 'https://tsc-6qr9.onrender.com');

if (window.location.protocol === 'file:') {
  const warnMsg = "ATTENZIONE: Stai aprendo l'applicazione direttamente come file locale (file://).\n\n" +
                  "Per far funzionare correttamente lo streaming video ed evitare blocchi di sicurezza (CORS/CSP) da parte di Vixcloud,\n" +
                  "avvia il server Python con 'python server.py' e apri questo indirizzo nel tuo browser:\n" +
                  "http://localhost:8000";
  console.warn(warnMsg);
  alert(warnMsg);
}

let cdnUrl = 'https://cdn.streamingcommunityz.associates'; // Will load dynamically from proxy
let baseSite = 'https://streamingcommunityz.associates'; // Will load dynamically from proxy

// Fetch dynamic config from proxy
async function loadProxyConfig() {
  try {
    const response = await fetch(`${PROXY_URL}/proxy-config`);
    const config = await response.json();
    if (config) {
      if (config.cdn_site) cdnUrl = config.cdn_site;
      if (config.base_site) baseSite = config.base_site;
      console.log("Loaded dynamic config:", { cdnUrl, baseSite });
    }
  } catch (err) {
    console.warn("Could not load dynamic config from proxy, using fallback:", err);
  }
}

// Global App State
let currentView = 'gallery'; // 'gallery', 'details', 'player'
let allTitles = [];
let fetchedTitles = []; // Cache for current search or archive results
let focusedGalleryIndex = 0;

// Search & Filter Navigation State
let galleryFocusArea = 'grid'; // 'search' or 'grid'
let searchFocusedIndex = 0;    // 0: input, 1: btn-clear, 2: filter-all, 3: filter-movie, 4: filter-tv
let activeFilter = 'all';      // 'all', 'movie', 'tv'

// Details Navigation State
let detailsFocusArea = 'buttons'; // 'buttons', 'seasons', or 'episodes'
let detailsButtonIndex = 0; // 0 for Play, 1 for Close
let detailsEpisodeIndex = 0;
let detailsSeasonIndex = 0;
let activeSeasonNumber = 1;
let loadedTitleData = null; // Stored metadata of the opened title

// DOM Elements
let galleryEl, detailsEl, playerEl;
let searchInputEl, btnClearEl, filterAllEl, filterMovieEl, filterTvEl;

// Helper per chiamate API tramite proxy (necessario per aggirare i blocchi CORS sul browser locale)
async function proxyFetch(url, options = {}) {
  // Se l'URL fa già parte del nostro proxy o è un percorso relativo del proxy, usalo direttamente
  if (url.startsWith(PROXY_URL)) {
    return fetch(url, options);
  }
  if (url.startsWith('/proxy/') || url.startsWith('/vixcloud/') || url.startsWith('/vixcontent/')) {
    return fetch(PROXY_URL + url, options);
  }

  const isTizenPlayer = navigator.userAgent.includes('Tizen') || window.tizen !== undefined;
  
  // Su Tizen proviamo una chiamata diretta per evitare l'IP mismatch del token Vixcloud
  if (isTizenPlayer) {
    try {
      console.log(`[Tizen] Attempting direct fetch for: ${url}`);
      const directRes = await fetch(url, options);
      if (directRes.ok) {
        return directRes;
      }
    } catch (e) {
      console.log(`[Tizen] Direct fetch failed due to CORS or network error, falling back to proxy. Error: ${e.message}`);
    }
  }

  // Risoluzione dell'endpoint corretto del proxy in base all'host target
  let targetUrl;
  if (url.includes('vixcloud.co')) {
    const path = url.split('vixcloud.co')[1];
    targetUrl = `${PROXY_URL}/vixcloud${path}`;
  } else if (url.includes('vix-content.net')) {
    const match = url.match(/https?:\/\/([a-zA-Z0-9\-]+)\.vix\-content\.net(.*)/);
    if (match) {
      targetUrl = `${PROXY_URL}/vixcontent/${match[1]}${match[2]}`;
    } else {
      targetUrl = `${PROXY_URL}/proxy/${url}`;
    }
  } else if (url.includes('streamingcommunity')) {
    const match = url.match(/https?:\/\/streamingcommunity[a-z0-9\-.]+(.*)/);
    if (match) {
      targetUrl = `${PROXY_URL}/proxy${match[1]}`;
    } else {
      targetUrl = `${PROXY_URL}/proxy/${url}`;
    }
  } else {
    targetUrl = `${PROXY_URL}/proxy/${url}`;
  }

  console.log(`[Proxy] Fetching via proxy: ${targetUrl}`);
  return fetch(targetUrl, options);
}

// Helper to fetch JSON data from the page's data-page attribute
async function fetchData() {
  const response = await fetch(`${PROXY_URL}${API_URL}`);
  const text = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");
  const appDiv = doc.querySelector('[data-page]');
  if (!appDiv) throw new Error('Data page JSON not found');
  const dataAttr = appDiv.getAttribute('data-page');
  const decoded = dataAttr.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const json = JSON.parse(decoded);
  return json.props.titles || [];
}

// Fetch title details page
async function fetchTitleDetails(id, slug) {
  const response = await fetch(`${PROXY_URL}/proxy/it/titles/${id}-${slug}`);
  const text = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");
  const appDiv = doc.querySelector('[data-page]');
  if (!appDiv) throw new Error('Detail JSON not found');
  const decoded = appDiv.getAttribute('data-page').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return JSON.parse(decoded).props;
}

// Fetch watch page to get embed URL
async function fetchEmbedUrl(titleId, episodeId = null) {
  let url = `${PROXY_URL}/proxy/it/watch/${titleId}`;
  if (episodeId) {
    url += `?e=${episodeId}`;
  }
  const response = await fetch(url);
  const text = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");
  const appDiv = doc.querySelector('[data-page]');
  if (!appDiv) throw new Error('Watch JSON not found');
  const decoded = appDiv.getAttribute('data-page').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const props = JSON.parse(decoded).props;
  return props.embedUrl;
}

// Build a gallery item element
function createItem(item) {
  const div = document.createElement('div');
  div.className = 'card';
  
  const img = document.createElement('img');
  const imgObj = item.images.find(i => i.type === 'poster') || item.images.find(i => i.type === 'cover');
  if (imgObj) {
    img.src = imgObj.original_url || `${cdnUrl}/images/${imgObj.filename}`;
  } else {
    img.src = '';
  }
  img.alt = item.name;
  
  const info = document.createElement('div');
  info.className = 'info';
  const h3 = document.createElement('h3');
  h3.textContent = item.name;
  info.appendChild(h3);
  
  div.appendChild(img);
  div.appendChild(info);
  return div;
}

// Render the gallery with initial archive data
async function renderGallery() {
  galleryEl = document.getElementById('gallery');
  try {
    fetchedTitles = await fetchData();
    applyFiltersAndRender();
  } catch (err) {
    console.error("Failed to load initial archive:", err);
  }
}

// Perform search via proxy on Enter key
async function performSearch() {
  const query = searchInputEl.value.trim();
  galleryEl.innerHTML = `<div style="color: #fff; padding: 20px; font-size: 20px; width: 100%;">Ricerca in corso...</div>`;
  
  if (query) {
    try {
      const response = await fetch(`${PROXY_URL}/proxy/it/search?q=${encodeURIComponent(query)}`);
      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const appDiv = doc.querySelector('[data-page]');
      if (appDiv) {
        const decoded = appDiv.getAttribute('data-page').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const props = JSON.parse(decoded).props;
        fetchedTitles = props.titles || [];
      } else {
        fetchedTitles = [];
      }
    } catch (err) {
      console.error("Search error:", err);
      fetchedTitles = [];
    }
  } else {
    try {
      fetchedTitles = await fetchData();
    } catch (err) {
      console.error("Failed to reload archive:", err);
      fetchedTitles = [];
    }
  }
  
  applyFiltersAndRender();
}

// Apply current active category filters and render titles inside grid
function applyFiltersAndRender() {
  let filtered = fetchedTitles;
  if (activeFilter === 'movie') {
    filtered = fetchedTitles.filter(t => t.type === 'movie');
  } else if (activeFilter === 'tv') {
    filtered = fetchedTitles.filter(t => t.type === 'tv');
  }
  
  allTitles = filtered;
  focusedGalleryIndex = 0;
  
  galleryEl.innerHTML = '';
  if (allTitles.length === 0) {
    galleryEl.innerHTML = `<div style="color: #888; padding: 20px; font-size: 20px; width: 100%;">Nessun titolo trovato per questo filtro.</div>`;
  } else {
    allTitles.forEach(item => galleryEl.appendChild(createItem(item)));
  }
  
  updateGalleryFocus();
}

// Select a filter category
function selectFilter(filterName) {
  activeFilter = filterName;
  
  filterAllEl.classList.toggle('active', activeFilter === 'all');
  filterMovieEl.classList.toggle('active', activeFilter === 'movie');
  filterTvEl.classList.toggle('active', activeFilter === 'tv');
  
  applyFiltersAndRender();
}

// Update DOM classes to reflect gallery focus
function updateGalleryFocus() {
  // Remove focus class from all elements in the main gallery/search area
  const focusedElements = document.querySelectorAll('.search-container .focused, #search-bar .focused, .grid .card.focused, .filters .filter-btn.focused, .clear-btn.focused');
  focusedElements.forEach(el => el.classList.remove('focused'));
  
  if (galleryFocusArea === 'search') {
    if (searchFocusedIndex === 0) {
      searchInputEl.classList.add('focused');
    } else if (searchFocusedIndex === 1) {
      if (btnClearEl) btnClearEl.classList.add('focused');
    } else {
      const btns = [filterAllEl, filterMovieEl, filterTvEl];
      const targetBtn = btns[searchFocusedIndex - 2];
      if (targetBtn) targetBtn.classList.add('focused');
    }
  } else if (galleryFocusArea === 'grid') {
    const cards = galleryEl.querySelectorAll('.card');
    if (cards.length > 0) {
      if (focusedGalleryIndex >= cards.length) focusedGalleryIndex = cards.length - 1;
      if (focusedGalleryIndex < 0) focusedGalleryIndex = 0;
      
      const activeCard = cards[focusedGalleryIndex];
      activeCard.classList.add('focused');
      
      activeCard.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }
}

// Helper to determine the number of grid columns dynamically
function getGridColumns() {
  const cards = document.querySelectorAll('.card');
  if (cards.length <= 1) return 1;
  const firstTop = cards[0].offsetTop;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].offsetTop > firstTop) {
      return i;
    }
  }
  return cards.length;
}

// Open details view for a title
function showDetails(item) {
  currentView = 'details';
  detailsEl.style.display = 'flex';
  
  // Remove focus class from gallery items
  const activeCard = galleryEl.querySelector('.card.focused');
  if (activeCard) activeCard.classList.remove('focused');
  
  detailsEl.innerHTML = `
    <div class="details-top">
      <div class="details-overlay"></div>
      <div class="details-content">
        <h2 class="details-title">Caricamento...</h2>
      </div>
    </div>
  `;
  
  // Reset navigation state inside details
  detailsFocusArea = 'buttons';
  detailsButtonIndex = 0;
  detailsEpisodeIndex = 0;
  detailsSeasonIndex = 0;
  activeSeasonNumber = 1;
  
  loadDetailsData(item);
}

// Populate details view with fetched metadata
async function loadDetailsData(item) {
  try {
    const props = await fetchTitleDetails(item.id, item.slug);
    loadedTitleData = props;
    
    const titleObj = props.title || item;
    const plotTrans = titleObj.translations.find(t => t.key === 'plot');
    
    // Decode HTML entities
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = plotTrans ? plotTrans.value : 'Trama non disponibile.';
    const plotText = tempDiv.textContent;
    
    const releaseYear = titleObj.release_date ? new Date(titleObj.release_date).getFullYear() : (titleObj.release_date_it ? new Date(titleObj.release_date_it).getFullYear() : 'N/D');
    
    // Backdrop Image
    const bgImg = titleObj.images.find(i => i.type === 'background') || titleObj.images.find(i => i.type === 'cover');
    const bgUrl = bgImg ? (bgImg.original_url || `${cdnUrl}/images/${bgImg.filename}`) : '';
    
    // Logo Image
    const logoImg = titleObj.images.find(i => i.type === 'logo');
    const logoUrl = logoImg ? (logoImg.original_url || `${cdnUrl}/images/${logoImg.filename}`) : '';
    
    // Initialize seasons indexes
    if (titleObj.type === 'tv') {
      activeSeasonNumber = props.loadedSeason ? props.loadedSeason.number : 1;
      const seasons = titleObj.seasons || [];
      const sIdx = seasons.findIndex(s => s.number === activeSeasonNumber);
      detailsSeasonIndex = sIdx >= 0 ? sIdx : 0;
    }
    
    let buttonsHtml = '';
    if (titleObj.type === 'movie') {
      buttonsHtml = `
        <button class="btn btn-primary btn-play focused">Riproduci</button>
        <button class="btn btn-close">Chiudi</button>
      `;
    } else {
      buttonsHtml = `
        <button class="btn btn-primary btn-play focused">Riproduci S${activeSeasonNumber}:E1</button>
        <button class="btn btn-close">Chiudi</button>
      `;
    }
    
    let bottomHtml = '';
    if (titleObj.type === 'tv') {
      const seasons = titleObj.seasons || [];
      let seasonsButtonsHtml = '';
      seasons.forEach((s, idx) => {
        const isCurrent = s.number === activeSeasonNumber;
        seasonsButtonsHtml += `
          <button class="season-btn ${isCurrent ? 'active' : ''}" data-number="${s.number}" data-index="${idx}">
            Stagione ${s.number}
          </button>
        `;
      });
      
      const episodes = props.loadedSeason ? (props.loadedSeason.episodes || []) : [];
      let episodesListHtml = '';
        episodes.forEach((ep, idx) => {
          episodesListHtml += `
            <div class="episode-card" data-index="${idx}" data-id="${ep.id}">
              <div class="episode-number">Ep. ${ep.number}</div>
              <div class="episode-name">${ep.name || 'Senza nome'}</div>
            </div>
          `;
        });
      
      bottomHtml = `
        <div class="details-bottom">
          <div class="seasons-list-row">
            ${seasonsButtonsHtml}
          </div>
          <div class="episodes-list">
            ${episodesListHtml || '<div style="color:#aaa; padding:10px;">Nessun episodio caricato</div>'}
          </div>
        </div>
      `;
    }
    
    detailsEl.innerHTML = `
      <div class="details-top">
        ${bgUrl ? `<img class="details-backdrop" src="${bgUrl}" alt="backdrop" />` : ''}
        <div class="details-overlay"></div>
        <div class="details-content">
          ${logoUrl ? `<img class="details-logo" src="${logoUrl}" alt="logo" />` : `<h2 class="details-title">${titleObj.name}</h2>`}
          <div class="details-meta">
            <span class="rating">★ ${titleObj.score || '0.0'}</span>
            <span class="year">${releaseYear}</span>
            <span class="badge">${titleObj.quality || 'HD'}</span>
            ${titleObj.type === 'tv' ? `<span class="badge">${titleObj.seasons_count} Stagioni</span>` : ''}
          </div>
          <p class="details-plot">${plotText}</p>
          <div class="details-buttons">
            ${buttonsHtml}
          </div>
        </div>
      </div>
      ${bottomHtml}
    `;
    
    updateDetailsFocus();
    
  } catch (err) {
    console.error("Failed to load details:", err);
    detailsEl.innerHTML = `
      <div class="details-top">
        <div class="details-overlay"></div>
        <div class="details-content">
          <h2 class="details-title">Errore</h2>
          <p>Impossibile caricare i dettagli di questo titolo.</p>
          <div class="details-buttons">
            <button class="btn btn-close focused">Chiudi</button>
          </div>
        </div>
      </div>
    `;
    updateDetailsFocus();
  }
}

// Fetch episodes of a specific season dynamically and rerender the bottom UI
async function changeSeason(seasonNumber) {
  if (!loadedTitleData || !loadedTitleData.title) return;
  
  const titleObj = loadedTitleData.title;
  activeSeasonNumber = seasonNumber;
  
  // Show loading indicator in episodes list
  const episodesListEl = detailsEl.querySelector('.episodes-list');
  if (episodesListEl) {
    episodesListEl.innerHTML = `<div style="color: #fff; padding: 10px; font-size: 14px;">Caricamento episodi...</div>`;
  }
  
  // Update Play button label text to reflect selected season
  const playBtn = detailsEl.querySelector('.details-buttons .btn-play');
  if (playBtn) {
    playBtn.textContent = `Riproduci S${activeSeasonNumber}:E1`;
  }
  
  try {
    const response = await fetch(`${PROXY_URL}/proxy/it/titles/${titleObj.id}-${titleObj.slug}/season-${seasonNumber}`);
    const text = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");
    const appDiv = doc.querySelector('[data-page]');
    if (!appDiv) throw new Error('Data page JSON not found');
    const decoded = appDiv.getAttribute('data-page').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const newProps = JSON.parse(decoded).props;
    
    // Update loadedTitleData
    loadedTitleData = newProps;
    
    // Rerender the bottom section!
    const bottomContainer = detailsEl.querySelector('.details-bottom');
    if (bottomContainer) {
      const seasons = titleObj.seasons || [];
      let seasonsButtonsHtml = '';
      seasons.forEach((s, idx) => {
        const isCurrent = s.number === activeSeasonNumber;
        seasonsButtonsHtml += `
          <button class="season-btn ${isCurrent ? 'active' : ''}" data-number="${s.number}" data-index="${idx}">
            Stagione ${s.number}
          </button>
        `;
      });
      
      const episodes = newProps.loadedSeason ? (newProps.loadedSeason.episodes || []) : [];
      let episodesListHtml = '';
      episodes.forEach((ep, idx) => {
        episodesListHtml += `
          <div class="episode-card" data-index="${idx}" data-id="${ep.id}">
            <div class="episode-number">Ep. ${ep.number}</div>
            <div class="episode-name">${ep.name || 'Senza nome'}</div>
          </div>
        `;
      });
      
      bottomContainer.innerHTML = `
        <div class="seasons-list-row">
          ${seasonsButtonsHtml}
        </div>
        <div class="episodes-list">
          ${episodesListHtml || '<div style="color:#aaa; padding:10px;">Nessun episodio caricato</div>'}
        </div>
      `;
    }
    
    updateDetailsFocus();
    
  } catch (err) {
    console.error("Failed to load season:", err);
    if (episodesListEl) {
      episodesListEl.innerHTML = `<div style="color: #ff5555; padding: 10px; font-size: 14px;">Errore nel caricamento degli episodi.</div>`;
    }
  }
}

// Update DOM classes to reflect the currently focused element in details view
function updateDetailsFocus() {
  const focusedElements = detailsEl.querySelectorAll('.focused');
  focusedElements.forEach(el => el.classList.remove('focused'));
  
  if (detailsFocusArea === 'buttons') {
    const buttons = detailsEl.querySelectorAll('.details-buttons .btn');
    if (buttons.length > 0) {
      if (detailsButtonIndex >= buttons.length) detailsButtonIndex = buttons.length - 1;
      if (detailsButtonIndex < 0) detailsButtonIndex = 0;
      buttons[detailsButtonIndex].classList.add('focused');
    }
  } else if (detailsFocusArea === 'seasons') {
    const seasonBtns = detailsEl.querySelectorAll('.seasons-list-row .season-btn');
    if (seasonBtns.length > 0) {
      if (detailsSeasonIndex >= seasonBtns.length) detailsSeasonIndex = seasonBtns.length - 1;
      if (detailsSeasonIndex < 0) detailsSeasonIndex = 0;
      
      const activeBtn = seasonBtns[detailsSeasonIndex];
      activeBtn.classList.add('focused');
      
      activeBtn.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  } else if (detailsFocusArea === 'episodes') {
    const episodes = detailsEl.querySelectorAll('.episodes-list .episode-card');
    if (episodes.length > 0) {
      if (detailsEpisodeIndex >= episodes.length) detailsEpisodeIndex = episodes.length - 1;
      if (detailsEpisodeIndex < 0) detailsEpisodeIndex = 0;
      
      const activeCard = episodes[detailsEpisodeIndex];
      activeCard.classList.add('focused');
      
      activeCard.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }
}// Get the video element from the player view
function getPlayerVideo() {
  return document.getElementById('native-player');
}

// Extract the direct HLS stream URL from the StreamingCommunity embed URL
async function extractStreamUrl(embedUrl) {
  // 1. Fetch StreamingCommunity embed page
  console.log("Fetching SC embed iframe:", embedUrl);
  const scResponse = await proxyFetch(embedUrl);
  const scHtml = await scResponse.text();
  
  // Extract Vixcloud iframe URL
  const iframeMatch = scHtml.match(/<iframe[^>]+src=["']([^"']+)["']/);
  if (!iframeMatch) throw new Error("Vixcloud iframe non trovato nella pagina di embed");
  const vixcloudUrl = iframeMatch[1].replace(/&amp;/g, '&');
  
  // 2. Fetch Vixcloud page
  console.log("Fetching Vixcloud HTML:", vixcloudUrl);
  
  const vixResponse = await proxyFetch(vixcloudUrl);
  const vixHtml = await vixResponse.text();
  
  // Extract window.masterPlaylist params using regex
  const tokenMatch = vixHtml.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
  const expiresMatch = vixHtml.match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
  const urlMatch = vixHtml.match(/url\s*:\s*['"](https?:\/\/[^'"]+\/playlist\/[^'"]+)['"]/);
  
  if (!tokenMatch || !expiresMatch || !urlMatch) {
    throw new Error("Impossibile estrarre i parametri di streaming da Vixcloud");
  }
  
  const token = tokenMatch[1];
  const expires = expiresMatch[1];
  const playlistBaseUrl = urlMatch[1];
  
  // 3. Construct stream URL
  const cleanPlaylistUrl = playlistBaseUrl.split('?')[0];
  const streamUrl = `${cleanPlaylistUrl}?token=${token}&expires=${expires}&b=1`;
  
  return { type: 'hls', url: streamUrl };
}

// Launch Video Player using HTML5 video tag with direct HLS stream
async function playTitle(titleId, episodeId = null) {
  try {
    currentView = 'player';
    playerEl.style.display = 'block';
    playerEl.innerHTML = `
      <div id="debug-overlay" style="position: absolute; top: 10px; left: 10px; z-index: 9999; color: #0f0; background: rgba(0,0,0,0.8); padding: 10px; font-size: 14px; font-family: monospace; white-space: pre-wrap; max-width: 80%; pointer-events: none;">[Debug Log]</div>
      <video id="native-player" autoplay style="width: 100%; height: 100%; background: #000;"></video>
    `;
    
    const debugLog = document.getElementById('debug-overlay');
    const log = (msg) => { debugLog.innerHTML += `\n${msg}`; console.log(msg); };
    
    log(`Fetching embed URL...`);
    const embedUrl = await fetchEmbedUrl(titleId, episodeId);
    
    log(`Extracting stream URL from: ${embedUrl.substring(0, 50)}...`);
    const streamData = await extractStreamUrl(embedUrl);
    
    const streamUrl = streamData.url;
    log(`Stream URL ready.`);
    
    const video = document.getElementById('native-player');
    
    video.addEventListener('error', (e) => {
      const err = video.error;
      log(`Native Video Error: ${err ? err.code + ' ' + err.message : 'Unknown'}`);
    });
    
    const isSafariPlayer = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome') && !navigator.userAgent.includes('Tizen');
    const isTizenPlayer = navigator.userAgent.includes('Tizen') || window.tizen !== undefined;
    const hasAVPlay = (typeof webapis !== 'undefined' && webapis.avplay);
    
    log(`Browser detection: Safari=${isSafariPlayer}, Tizen=${isTizenPlayer}, AVPlay=${hasAVPlay}`);
    
    if (hasAVPlay) {
      log(`Using Tizen AVPlay API...`);
      playerEl.innerHTML += `<object id="av-player" type="application/avplayer" style="width: 100%; height: 100%; position: absolute; top:0; left:0; z-index: 10;"></object>`;
      document.getElementById('debug-overlay').style.zIndex = "9999";
      
      try {
        webapis.avplay.open(streamUrl);
        webapis.avplay.setDisplayRect(0, 0, window.innerWidth, window.innerHeight);
        
        webapis.avplay.setListener({
          onbufferingstart: function() { log("AVPlay: Buffering start"); },
          onbufferingprogress: function(percent) { /* log("AVPlay: Buffering " + percent + "%"); */ },
          onbufferingcomplete: function() { log("AVPlay: Buffering complete"); },
          onerror: function(eventType) { log("AVPlay Error: " + eventType); },
          onevent: function(eventType, eventData) { log("AVPlay Event: " + eventType + " " + (eventData || "")); },
          onstreamcompleted: function() { log("AVPlay: Stream completed"); stopPlayer(); }
        });
        
        try {
          const props = { "UserAgent": navigator.userAgent };
          webapis.avplay.setStreamingProperty("SET_PROPERTIES", JSON.stringify(props));
        } catch(e) { log("AVPlay setProperty warning: " + e.message); }
        
        webapis.avplay.prepareAsync(function() {
          log("AVPlay: prepareAsync success, starting playback...");
          webapis.avplay.play();
        }, function(error) {
          log("AVPlay prepareAsync error: " + error.name + " " + error.message);
        });
        
        playerEl._hasAVPlay = true;
      } catch (e) {
        log(`AVPlay Exception: ${e.name} ${e.message}`);
      }
    } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      log(`Using hls.js player with CORS proxy...`);
      // Proxy the m3u8 playlist through our Render proxy to bypass CORS on Tizen AND keep the IP matching!
      let proxiedStreamUrl = streamUrl;
      if (streamUrl.includes('https://vixcloud.co')) {
        proxiedStreamUrl = streamUrl.replace('https://vixcloud.co', PROXY_URL + '/vixcloud');
      } else if (!streamUrl.startsWith('http') && !streamUrl.startsWith('/')) {
        proxiedStreamUrl = `${PROXY_URL}/proxy/${streamUrl}`;
      }
      
      const hls = new Hls({
        maxMaxBufferLength: 10,
        enableWorker: true,
        debug: false
      });
      hls.loadSource(proxiedStreamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        log(`HLS Manifest parsed. Attempting play...`);
        video.play().catch(e => log(`Play failed: ${e.message}`));
      });
      hls.on(Hls.Events.ERROR, function(event, data) {
        log(`HLS Error [${data.type}]: ${data.details}`);
        if (data.fatal) {
          log(`Fatal error! Trying to recover...`);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Se fallisce il proxy, prova a fallback sul Native Player senza proxy
              log(`Network error, falling back to Native Player...`);
              video.src = streamUrl;
              video.play().catch(e => log(`Fallback Play failed: ${e.message}`));
              hls.destroy();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        }
      });
      playerEl._hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      log(`Fallback Native Player (Hls.js not supported)...`);
      video.src = streamUrl;
      video.play().catch(e => log(`Play failed: ${e.message}`));
    } else {
      log(`Error: Browser does not support HLS or Hls.js`);
      throw new Error("Il tuo browser non supporta la riproduzione HLS.");
    }
  } catch (err) {
    console.error(err);
    if (document.getElementById('debug-overlay')) {
      document.getElementById('debug-overlay').innerHTML += `\nEXCEPTION: ${err.message}`;
    } else {
      alert("Errore caricamento player: " + err.message);
    }
    setTimeout(() => stopPlayer(), 10000); // Wait 10s to read log before closing
  }
}

// Close player and return to details
function stopPlayer() {
  currentView = 'details';
  playerEl.style.display = 'none';
  
  if (playerEl._hasAVPlay && typeof webapis !== 'undefined' && webapis.avplay) {
    try {
      webapis.avplay.stop();
      webapis.avplay.close();
    } catch (e) {}
    playerEl._hasAVPlay = false;
  }
  
  // Clean up hls.js instance if exists
  if (playerEl._hlsInstance) {
    try {
      playerEl._hlsInstance.destroy();
    } catch (e) {}
    playerEl._hlsInstance = null;
  }
  
  playerEl.innerHTML = ''; // Destroys video element to stop sound and video
  updateDetailsFocus();
}

// Keyboard and Remote Control key down mapping
function isBackKey(key, keyCode) {
  return key === 'Backspace' || key === 'Escape' || key === 'ArrowBack' || key === 'Back' || key === 'BrowserBack' || key === '\\' || key === '/' || keyCode === 10009 || key === 'XF86Backspace';
}

function handleGalleryKeys(key, keyCode, e) {
  if (galleryFocusArea === 'search') {
    if (key === 'ArrowRight') {
      searchFocusedIndex = (searchFocusedIndex + 1) % 5;
      updateGalleryFocus();
    } else if (key === 'ArrowLeft') {
      searchFocusedIndex = (searchFocusedIndex - 1 + 5) % 5;
      updateGalleryFocus();
    } else if (key === 'ArrowDown') {
      const cards = galleryEl.querySelectorAll('.card');
      if (cards.length > 0) {
        galleryFocusArea = 'grid';
        focusedGalleryIndex = 0;
        updateGalleryFocus();
      }
    } else if (key === 'Enter') {
      if (searchFocusedIndex === 0) {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        searchInputEl.focus();
      } else if (searchFocusedIndex === 1) {
        if (searchInputEl) searchInputEl.value = '';
        performSearch();
      } else if (searchFocusedIndex === 2) {
        selectFilter('all');
      } else if (searchFocusedIndex === 3) {
        selectFilter('movie');
      } else if (searchFocusedIndex === 4) {
        selectFilter('tv');
      }
    }
    return;
  }
  
  const cards = galleryEl.querySelectorAll('.card');
  if (!cards.length) return;
  
  const cols = getGridColumns();
  let nextIndex = focusedGalleryIndex;
  
  if (key === 'ArrowRight') {
    nextIndex = (focusedGalleryIndex + 1) % cards.length;
  } else if (key === 'ArrowLeft') {
    nextIndex = (focusedGalleryIndex - 1 + cards.length) % cards.length;
  } else if (key === 'ArrowDown') {
    if (focusedGalleryIndex + cols < cards.length) {
      nextIndex = focusedGalleryIndex + cols;
    }
  } else if (key === 'ArrowUp') {
    if (focusedGalleryIndex - cols >= 0) {
      nextIndex = focusedGalleryIndex - cols;
    } else {
      galleryFocusArea = 'search';
      searchFocusedIndex = 0; // Default to input
      updateGalleryFocus();
      return;
    }
  } else if (key === 'Enter') {
    const activeItem = allTitles[focusedGalleryIndex];
    if (activeItem) {
      showDetails(activeItem);
    }
    return;
  }
  
  if (nextIndex !== focusedGalleryIndex) {
    cards[focusedGalleryIndex].classList.remove('focused');
    focusedGalleryIndex = nextIndex;
    cards[focusedGalleryIndex].classList.add('focused');
    cards[focusedGalleryIndex].scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    });
  }
}

function handleDetailsKeys(key, keyCode) {
  if (isBackKey(key, keyCode)) {
    currentView = 'gallery';
    detailsEl.style.display = 'none';
    loadedTitleData = null;
    updateGalleryFocus();
    return;
  }
  
  if (detailsFocusArea === 'buttons') {
    if (key === 'ArrowRight') {
      detailsButtonIndex = 1; // Chiudi button
      updateDetailsFocus();
    } else if (key === 'ArrowLeft') {
      detailsButtonIndex = 0; // Play button
      updateDetailsFocus();
    } else if (key === 'ArrowDown') {
      const titleObj = loadedTitleData ? loadedTitleData.title : null;
      if (titleObj && titleObj.type === 'tv') {
        const seasonBtns = detailsEl.querySelectorAll('.seasons-list-row .season-btn');
        if (seasonBtns.length > 0) {
          detailsFocusArea = 'seasons';
          updateDetailsFocus();
        }
      }
    } else if (key === 'Enter') {
      if (detailsButtonIndex === 0) {
        const titleObj = loadedTitleData.title;
        if (titleObj.type === 'movie') {
          playTitle(titleObj.id);
        } else {
          const episodes = (loadedTitleData.loadedSeason && loadedTitleData.loadedSeason.episodes) || [];
          if (episodes.length > 0) {
            playTitle(titleObj.id, episodes[0].id);
          } else {
            alert("Nessun episodio disponibile.");
          }
        }
      } else {
        // Close details view
        handleDetailsKeys('Escape');
      }
    }
  } else if (detailsFocusArea === 'seasons') {
    const seasonBtns = detailsEl.querySelectorAll('.seasons-list-row .season-btn');
    if (key === 'ArrowRight') {
      if (detailsSeasonIndex + 1 < seasonBtns.length) {
        detailsSeasonIndex++;
        updateDetailsFocus();
      }
    } else if (key === 'ArrowLeft') {
      if (detailsSeasonIndex - 1 >= 0) {
        detailsSeasonIndex--;
        updateDetailsFocus();
      }
    } else if (key === 'ArrowUp') {
      detailsFocusArea = 'buttons';
      updateDetailsFocus();
    } else if (key === 'ArrowDown') {
      const episodes = detailsEl.querySelectorAll('.episodes-list .episode-card');
      if (episodes.length > 0) {
        detailsFocusArea = 'episodes';
        detailsEpisodeIndex = 0;
        updateDetailsFocus();
      }
    } else if (key === 'Enter') {
      const activeBtn = seasonBtns[detailsSeasonIndex];
      if (activeBtn) {
        const sNum = parseInt(activeBtn.getAttribute('data-number'));
        if (sNum && sNum !== activeSeasonNumber) {
          changeSeason(sNum);
        }
      }
    }
  } else if (detailsFocusArea === 'episodes') {
    const episodes = detailsEl.querySelectorAll('.episodes-list .episode-card');
    if (key === 'ArrowRight') {
      if (detailsEpisodeIndex + 1 < episodes.length) {
        detailsEpisodeIndex++;
        updateDetailsFocus();
      }
    } else if (key === 'ArrowLeft') {
      if (detailsEpisodeIndex - 1 >= 0) {
        detailsEpisodeIndex--;
        updateDetailsFocus();
      }
    } else if (key === 'ArrowUp') {
      const titleObj = loadedTitleData ? loadedTitleData.title : null;
      if (titleObj && titleObj.type === 'tv') {
        detailsFocusArea = 'seasons';
      } else {
        detailsFocusArea = 'buttons';
      }
      updateDetailsFocus();
    } else if (key === 'Enter') {
      const titleObj = loadedTitleData.title;
      const episodesList = (loadedTitleData.loadedSeason && loadedTitleData.loadedSeason.episodes) || [];
      const activeEp = episodesList[detailsEpisodeIndex];
      if (activeEp) {
        playTitle(titleObj.id, activeEp.id);
      }
    }
  }
}

function handlePlayerKeys(key, keyCode) {
  if (isBackKey(key, keyCode)) {
    stopPlayer();
    return;
  }
  
  const video = getPlayerVideo();
  if (!video) return;
  
  // Play/Pause controls (Toggle / Play / Pause keys)
  const isPlayKey = key === 'MediaPlay' || keyCode === 415;
  const isPauseKey = key === 'MediaPause' || keyCode === 19;
  const isToggleKey = key === 'Enter' || key === ' ' || key === 'MediaPlayPause' || keyCode === 10252;
  
  if (isPlayKey) {
    try { video.play(); } catch (err) {}
  } else if (isPauseKey) {
    try { video.pause(); } catch (err) {}
  } else if (isToggleKey) {
    try {
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    } catch (err) {}
  }
  
  // Seek controls with Left/Right Arrows
  if (key === 'ArrowRight') {
    try {
      video.currentTime += 10; // Seek forward 10s
    } catch (err) {}
  } else if (key === 'ArrowLeft') {
    try {
      video.currentTime -= 10; // Seek backward 10s
    } catch (err) {}
  }
}

// Bind overall remote control events
function bindRemote() {
  updateGalleryFocus();
  
  // Exit application helper
  function exitApp() {
    console.log("Exiting application...");
    if (window.tizen && tizen.application) {
      try {
        tizen.application.getCurrentApplication().exit();
        return;
      } catch (err) {
        console.warn("Tizen application exit failed:", err);
      }
    }
    try {
      window.close();
    } catch (e) {}
    try {
      if (window.history && window.history.length > 1) {
        window.history.back();
      }
    } catch (e) {}
    try {
      window.location.href = "about:blank";
    } catch (e) {}
  }
  
  // Force exit when app goes to background (pressed Home button), reload on resume to start fresh
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (currentView === 'player') stopPlayer();
      exitApp();
    } else {
      window.location.reload();
    }
  });
  document.addEventListener('webkitvisibilitychange', () => {
    if (document.webkitHidden) {
      if (currentView === 'player') stopPlayer();
      exitApp();
    } else {
      window.location.reload();
    }
  });
  
  document.addEventListener('keydown', e => {
    // Intercept Back key to prevent default TV actions (like exiting app) if we are in details/player views
    if (currentView !== 'gallery' && isBackKey(e.key, e.keyCode)) {
      e.preventDefault();
    }
    
    if (currentView === 'gallery') {
      // If the input has focus, let the browser capture key events (except Escape/Backspace which exits focus)
      if (document.activeElement === searchInputEl) {
        if (isBackKey(e.key, e.keyCode)) {
          searchInputEl.blur();
          updateGalleryFocus();
          e.preventDefault();
        }
        return; // Don't intercept normal typing keys
      }
      
      // If not in input, and back key is pressed, exit application
      if (isBackKey(e.key, e.keyCode)) {
        e.preventDefault();
        exitApp();
        return;
      }
      
      handleGalleryKeys(e.key, e.keyCode, e);
    } else if (currentView === 'details') {
      handleDetailsKeys(e.key, e.keyCode);
    } else if (currentView === 'player') {
      handlePlayerKeys(e.key, e.keyCode);
    }
  });
}

window.addEventListener('load', async () => {
  try {
    detailsEl = document.getElementById('details-view');
    playerEl = document.getElementById('player-view');
    
    // Bind search and filter DOM elements
    searchInputEl = document.getElementById('search-input');
    btnClearEl = document.getElementById('btn-clear');
    filterAllEl = document.getElementById('filter-all');
    filterMovieEl = document.getElementById('filter-movie');
    filterTvEl = document.getElementById('filter-tv');
    
    if (btnClearEl) {
      btnClearEl.addEventListener('click', () => {
        if (searchInputEl) searchInputEl.value = '';
        performSearch();
      });
    }
    
    // Bind Enter key listener inside search input
    searchInputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        performSearch();
        searchInputEl.blur();
        e.preventDefault();
        e.stopPropagation();
      }
    });
    
    // Bind Form submit (catches virtual keyboard "Done" / "Fatto" / Enter arrow button clicks)
    const searchForm = document.getElementById('search-form');
    if (searchForm) {
      searchForm.addEventListener('submit', e => {
        e.preventDefault();
        performSearch();
        searchInputEl.blur();
      });
    }
    
    await loadProxyConfig();
    await renderGallery();
    bindRemote();
  } catch (err) {
    console.error(err);
  }
});
