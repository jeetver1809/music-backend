// server.js (Piped-first streaming)
// Use a Piped instance to get audio stream URLs for YouTube videos.
// Falls back to Innertube only if Piped doesn't provide usable audio (optional).

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const ytsr = require('ytsr'); // for search
// optional fallback - only used if Piped fails; comment out if you don't want fallback
const { Innertube, UniversalCache } = require('youtubei.js');

const app = express();
app.use(express.json());

// Debug screenshot path you uploaded (for your reference)
const DEBUG_SCREENSHOT_PATH = '/mnt/data/98844ada-1e95-4e67-921b-46c187c1e25d.png';

// ------------------ CORS (expose streaming headers) ------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Accept-Encoding');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Encoding, Content-Length, ETag, Cache-Control');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.send('Music Jam Server Online! 🚀'));

// ------------------ Config ------------------
const PIPED_INSTANCE = process.env.PIPED_INSTANCE || 'https://pipedapi.kavin.rocks'; // change if you prefer
const PORT = process.env.PORT || 3001;

// ------------------ (Optional) Innertube fallback init ------------------
let yt = null;
async function initYouTube() {
  if (yt) return;
  try {
    yt = await Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true });
    console.log('✅ Innertube initialized');
  } catch (e) {
    console.warn('Innertube init failed:', e && e.message ? e.message : e);
  }
}

// ------------------ Utils ------------------
function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  if (/^[0-9A-Za-z_-]{11}$/.test(urlOrId)) return urlOrId;
  let m = urlOrId.match(/[?&]v=([0-9A-Za-z_-]{11})/);
  if (m && m[1]) return m[1];
  m = urlOrId.match(/youtu\.be\/([0-9A-Za-z_-]{11})/);
  if (m && m[1]) return m[1];
  m = urlOrId.match(/\/shorts\/([0-9A-Za-z_-]{11})/);
  if (m && m[1]) return m[1];
  m = urlOrId.match(/([0-9A-Za-z_-]{11})/);
  return m ? m[1] : null;
}

// Basic mime guess by extension for direct urls
function mimeForUrl(u) {
  const m = u.match(/\.(mp3|m4a|mp4|webm|ogg)(?:\?|$)/i);
  if (!m) return 'application/octet-stream';
  switch (m[1].toLowerCase()) {
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'audio/webm';
    case 'ogg': return 'audio/ogg';
    default: return 'application/octet-stream';
  }
}

// ------------------ Piped helpers ------------------
async function getPipedStreams(videoId) {
  // videoId must be a plain id (11 chars)
  if (!videoId) throw new Error('Invalid video id for piped');
  const url = `${PIPED_INSTANCE}/streams/${videoId}`;
  try {
    const res = await axios.get(url, { timeout: 10_000 });
    if (res && res.data) return res.data;
    return null;
  } catch (e) {
    console.warn('Piped fetch failed:', e && (e.response && e.response.status) ? `${e.response.status}` : (e.message || e));
    return null;
  }
}

function chooseBestAudioFromPiped(pipedData) {
  if (!pipedData) return null;
  const audioStreams = pipedData.audioStreams || pipedData.audio || pipedData.streams || [];
  if (!audioStreams || audioStreams.length === 0) return null;

  // prefer audio with content-type containing 'audio' or 'm4a', sort by bitrate
  const candidates = audioStreams
    .map(s => ({
      url: s.url || s.playUrl || s.cdnUrl || null,
      mimeType: s.mimeType || s.type || null,
      bitrate: s.bitrate || s.bandwidth || 0,
      quality: s.quality || s.qualityLabel || null
    }))
    .filter(s => s.url);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return candidates[0];
}

// ------------------ Innertube fallback (optional) ------------------
async function getInnertubeFormat(videoId) {
  try {
    await initYouTube();
    if (!yt) throw new Error('Innertube not initialized');
    const info = await yt.getInfo(videoId);
    if (!info) return null;
    // try chooseFormat
    const fmt = info.chooseFormat ? info.chooseFormat({ type: 'audio', quality: 'best' }) : null;
    if (fmt && fmt.url) return { url: fmt.url, mimeType: fmt.mimeType || mimeForUrl(fmt.url) };
    // fallback scan
    const formats = info.formats || (info.streamingData && (info.streamingData.adaptiveFormats || info.streamingData.formats)) || [];
    for (const f of formats) {
      if (f && f.url && (/audio/i.test(f.mimeType || '') || f.audioCodec)) {
        return { url: f.url, mimeType: f.mimeType || mimeForUrl(f.url) };
      }
    }
    return null;
  } catch (e) {
    console.warn('Innertube format fetch failed:', e && e.message ? e.message : e);
    return null;
  }
}

// ------------------ Format resolver (Piped-first, fallback to Innertube) ------------------
async function resolveStreamUrl(inputUrl) {
  // If direct HTTP(S) non-YT URL, return it raw
  if (/^https?:\/\//i.test(inputUrl) && !/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(inputUrl)) {
    return { url: inputUrl, mimeType: mimeForUrl(inputUrl) };
  }

  const id = extractVideoId(inputUrl);
  if (!id) throw new Error('Invalid video id/url');

  // 1) Try Piped
  const piped = await getPipedStreams(id);
  if (piped) {
    const best = chooseBestAudioFromPiped(piped);
    if (best && best.url) {
      return { url: best.url, mimeType: best.mimeType || mimeForUrl(best.url) };
    }
  }

  // 2) Fallback attempt: Innertube (useful if Piped instance is down)
  const inn = await getInnertubeFormat(id);
  if (inn && inn.url) return inn;

  // 3) Nothing found
  throw new Error('No usable audio format found (Piped+Innertube failed)');
}

// ------------------ Rate limiting (IP token-bucket) ------------------
const RATE_CAPACITY = 30;
const RATE_WINDOW_MS = 60_000;
const TOKEN_REFILL_PER_MS = RATE_CAPACITY / RATE_WINDOW_MS;
const ipBuckets = new Map();

function allowRequestFromIp(ip) {
  if (!ip) return false;
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_CAPACITY - 1, last: now };
    ipBuckets.set(ip, bucket);
    return true;
  }
  const elapsed = now - bucket.last;
  const refill = elapsed * TOKEN_REFILL_PER_MS;
  bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + refill);
  bucket.last = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets.entries()) {
    if (now - v.last > 30 * 60_000) ipBuckets.delete(k);
  }
}, 10 * 60_000);

// ------------------ /stream endpoint (Range-aware, mirrors upstream headers) ------------------
app.get('/stream', async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).send('No url provided');

  const clientIp = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress);
  if (!allowRequestFromIp(clientIp)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).send('Too many requests - slow down');
  }

  try {
    const { url: upstreamUrl, mimeType } = await resolveStreamUrl(inputUrl);
    if (!upstreamUrl) throw new Error('No upstream url');

    // Forward Range header if present
    const forwardHeaders = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Referer': 'https://www.youtube.com/',
      'Accept': '*/*'
    };
    if (req.headers.range) forwardHeaders.Range = req.headers.range;

    const upstream = await axios({
      method: 'get',
      url: upstreamUrl,
      responseType: 'stream',
      headers: forwardHeaders,
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: status => (status >= 200 && status < 400) // allow 206
    });

    // copy safe headers and status so browser/media element can handle partial content
    const whitelist = ['content-range', 'accept-ranges', 'content-length', 'content-type', 'etag', 'cache-control'];
    res.status(upstream.status);
    for (const h of whitelist) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', mimeType || 'audio/mpeg');

    upstream.data.pipe(res);
    upstream.data.on('error', (e) => {
      try { res.end(); } catch (err) {}
    });
    req.on('close', () => {
      try { if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy(); } catch (e) {}
    });

  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.warn('Stream error:', msg);
    if (/No usable audio|unavailable|No upstream url|Invalid video id/i.test(msg)) {
      return res.status(410).send(`Content Unavailable: ${msg}`);
    }
    return res.status(500).send(`Server Error: ${msg}`);
  }
});

// ------------------ /debug-info endpoint ------------------
app.get('/debug-info', async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).send({ ok: false, error: 'No url provided' });

  const id = extractVideoId(inputUrl);
  if (!id) return res.status(400).send({ ok: false, error: 'Could not extract video id' });

  // Try Piped
  const piped = await getPipedStreams(id);
  let pipedPreview = null;
  if (piped) {
    pipedPreview = {
      title: piped.title || null,
      audioCount: (piped.audioStreams || []).length,
      audioPreview: (piped.audioStreams || []).slice(0,10).map(s => ({ mimeType: s.mimeType || s.type, bitrate: s.bitrate || s.bandwidth || null, hasUrl: !!(s.url || s.playUrl) }))
    };
  }

  // Innertube info (best-effort)
  let innInfo = null;
  try {
    await initYouTube();
    if (yt) {
      const info = await yt.getInfo(id);
      innInfo = {
        title: (info.videoDetails && info.videoDetails.title) || info.title || 'Unknown',
        formatsCount: (info.formats || []).length,
        playability: info.playabilityStatus || {}
      };
    }
  } catch (e) {
    innInfo = { error: e && e.message ? e.message : String(e) };
  }

  return res.send({
    ok: true,
    id,
    piped: pipedPreview,
    innertube: innInfo,
    debugScreenshot: DEBUG_SCREENSHOT_PATH
  });
});

// ------------------ Socket.IO room & queue logic ------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const rooms = {};
const socketSearchTimestamps = new Map();
const SEARCH_MIN_INTERVAL_MS = 1500;
const socketRequestSongCounts = new Map();
const REQUEST_WINDOW_MS = 60_000;
const REQUEST_MAX_PER_WINDOW = 10;

function makePlayNext(roomCode) {
  return async function playNext() {
    const room = rooms[roomCode];
    if (!room || room.queue.length === 0) {
      if (room) room.isPlaying = false;
      return;
    }
    const nextSong = room.queue.shift();

    // Attempt to resolve stream URL (Piped-first) - this may throw
    try {
      const resolved = await resolveStreamUrl(nextSong.originalUrl);
      if (!resolved || !resolved.url) {
        io.to(roomCode).emit('song_error', `Could not resolve: ${nextSong.title}`);
        // continue to next
        setImmediate(playNext);
        return;
      }

      room.currentSongUrl = resolved.url;
      room.currentTitle = nextSong.title || 'Unknown';
      room.currentThumbnail = nextSong.thumbnail || null;
      room.isPlaying = true;
      room.timestamp = 0;
      room.lastUpdate = Date.now();

      io.to(roomCode).emit('play_song', {
        url: room.currentSongUrl,
        title: room.currentTitle,
        thumbnail: room.currentThumbnail
      });
      io.to(roomCode).emit('queue_updated', room.queue);

    } catch (e) {
      console.warn('playNext resolve failed:', e && e.message ? e.message : e);
      io.to(roomCode).emit('song_error', `Could not load: ${nextSong.title}`);
      setImmediate(playNext);
    }
  };
}

io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  socket.on('join_room', ({ roomCode, username }) => {
    socket.join(roomCode);
    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        currentSongUrl: null,
        currentTitle: 'No Song Playing',
        currentThumbnail: null,
        queue: [],
        users: [],
        isPlaying: false,
        timestamp: 0,
        lastUpdate: Date.now()
      };
    }
    const room = rooms[roomCode];
    const newUser = { id: socket.id, name: username || `User ${socket.id.substr(0,4)}` };
    if (!room.users.find(u => u.id === socket.id)) room.users.push(newUser);
    io.to(roomCode).emit('update_users', room.users);

    let adjustedTime = room.timestamp;
    if (room.isPlaying) {
      adjustedTime += (Date.now() - room.lastUpdate) / 1000;
    }

    socket.emit('sync_state', {
      url: room.currentSongUrl,
      title: room.currentTitle,
      thumbnail: room.currentThumbnail,
      isPlaying: room.isPlaying,
      timestamp: adjustedTime,
      queue: room.queue
    });
  });

  socket.on('disconnect', () => {
    for (const rc in rooms) {
      const room = rooms[rc];
      const idx = room.users.findIndex(u => u.id === socket.id);
      if (idx !== -1) {
        room.users.splice(idx, 1);
        io.to(rc).emit('update_users', room.users);
        if (room.users.length === 0) delete rooms[rc];
        break;
      }
    }
    socketSearchTimestamps.delete(socket.id);
    socketRequestSongCounts.delete(socket.id);
    console.log('Socket disconnected', socket.id);
  });

  socket.on('search_query', async (query) => {
    try {
      const last = socketSearchTimestamps.get(socket.id) || 0;
      const now = Date.now();
      if (now - last < SEARCH_MIN_INTERVAL_MS) return socket.emit('search_results', []);
      socketSearchTimestamps.set(socket.id, now);

      const resultsRaw = await ytsr(query, { limit: 10 });
      const results = (resultsRaw.items || []).filter(i => i.type === 'video').slice(0,8).map(item => ({
        title: item.title,
        id: item.id,
        url: item.url,
        thumbnail: (item.bestThumbnail && item.bestThumbnail.url) || (item.thumbnails && item.thumbnails[0] && item.thumbnails[0].url) || null
      }));
      socket.emit('search_results', results);
    } catch (e) {
      console.warn('search failed', e && e.message ? e.message : e);
      socket.emit('song_error', 'Search failed.');
    }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    try {
      // validate: if youtube url, check piped returns something
      const id = extractVideoId(youtubeUrl);
      if (id) {
        const piped = await getPipedStreams(id);
        if (!piped || !(piped.audioStreams && piped.audioStreams.length > 0)) {
          // try innertube to check availability (best-effort)
          let innOk = false;
          try {
            await initYouTube();
            if (yt) {
              const info = await yt.getInfo(id);
              innOk = !!(info && (info.formats || []).length);
            }
          } catch (e) {
            innOk = false;
          }
          if (!innOk) {
            return socket.emit('song_error', `Cannot add "${title || 'this video'}": unavailable or restricted.`);
          }
        }
      } else {
        // non-yt URL - quick HEAD check
        try {
          await axios.head(youtubeUrl, { timeout: 8000 });
        } catch (e) {
          return socket.emit('song_error', `Cannot add "${title || 'this file'}": unreachable.`);
        }
      }

      // per-socket add rate limit
      const now = Date.now();
      let rec = socketRequestSongCounts.get(socket.id);
      if (!rec || now - rec.windowStart > REQUEST_WINDOW_MS) rec = { count: 0, windowStart: now };
      if (rec.count >= REQUEST_MAX_PER_WINDOW) return socket.emit('song_error', 'Too many song requests — slow down.');
      rec.count += 1;
      socketRequestSongCounts.set(socket.id, rec);

      if (!rooms[roomCode]) {
        rooms[roomCode] = {
          currentSongUrl: null,
          currentTitle: 'No Song Playing',
          currentThumbnail: null,
          queue: [],
          users: [],
          isPlaying: false,
          timestamp: 0,
          lastUpdate: Date.now()
        };
      }

      const room = rooms[roomCode];
      room.queue.push({ title: title || 'Unknown', thumbnail: thumbnail || null, originalUrl: youtubeUrl, audioUrl: null });
      io.to(roomCode).emit('queue_updated', room.queue);

      if (!room.isPlaying) {
        const playNext = makePlayNext(roomCode);
        await playNext();
      }

    } catch (e) {
      console.error('request_song error', e && e.message ? e.message : e);
      socket.emit('song_error', 'Server error while adding song.');
    }
  });

  socket.on('skip_track', (roomCode) => {
    const playNext = makePlayNext(roomCode);
    playNext();
  });

  socket.on('pause_track', ({ roomCode, timestamp }) => {
    if (rooms[roomCode]) {
      rooms[roomCode].isPlaying = false;
      rooms[roomCode].timestamp = timestamp;
      rooms[roomCode].lastUpdate = Date.now();
      socket.to(roomCode).emit('receive_pause', timestamp);
    }
  });

  socket.on('play_track', ({ roomCode, timestamp }) => {
    if (rooms[roomCode]) {
      rooms[roomCode].isPlaying = true;
      rooms[roomCode].timestamp = timestamp;
      rooms[roomCode].lastUpdate = Date.now();
      socket.to(roomCode).emit('receive_play', timestamp);
    }
  });

  socket.on('seek_track', ({ roomCode, timestamp }) => {
    if (rooms[roomCode]) {
      rooms[roomCode].timestamp = timestamp;
      rooms[roomCode].lastUpdate = Date.now();
      io.to(roomCode).emit('receive_seek', timestamp);
    }
  });

}); // io.on connection

// ------------------ Start server ------------------
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (Piped instance: ${PIPED_INSTANCE})`));
