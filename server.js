// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Innertube, UniversalCache } = require('youtubei.js');
const ytsr = require('ytsr');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('Music Jam Server Online! 🚀'));

// --- Initialize YouTube Innertube session ---
let yt = null;
async function initYouTube() {
  try {
    yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });
    console.log("✅ YouTube InnerTube Initialized!");
  } catch (e) {
    console.error("❌ Failed to init YouTube:", e && e.message ? e.message : e);
  }
}
initYouTube();

// ------------------ Utilities ------------------

// Extracts a YouTube video ID from common URL forms or accepts an ID directly.
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

// ------------------ Rate limiting & caching ------------------

// IP token-bucket limiter for /stream
const RATE_CAPACITY = 30; // tokens per window
const RATE_WINDOW_MS = 60 * 1000; // window size in ms (60s)
const TOKEN_REFILL_PER_MS = RATE_CAPACITY / RATE_WINDOW_MS;
const ipBuckets = new Map(); // ip -> { tokens, last }

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

// GC old IP buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of ipBuckets.entries()) {
    if (now - bucket.last > 30 * 60 * 1000) { // 30 minutes idle
      ipBuckets.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// Short-lived caches
const INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FORMAT_CACHE_TTL_MS = 30 * 1000;   // 30 seconds

const infoCache = new Map();   // videoId -> { info, expiresAt }
const formatCache = new Map(); // videoId -> { url, mimeType, expiresAt }
const inflightFetches = new Map(); // videoId -> Promise

// Cleanup caches periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of infoCache.entries()) if (v.expiresAt <= now) infoCache.delete(k);
  for (const [k, v] of formatCache.entries()) if (v.expiresAt <= now) formatCache.delete(k);
}, 60 * 1000);

// ------------------ YouTube info & format helpers ------------------

// Always call Innertube with a VIDEO ID (safer). Coalesce concurrent fetches.
async function getInfoWithCache(urlOrId) {
  const id = extractVideoId(urlOrId) || urlOrId;
  if (!id) throw new Error('Invalid video id/url');

  const now = Date.now();
  const cached = infoCache.get(id);
  if (cached && cached.expiresAt > now) {
    return cached.info;
  }

  if (inflightFetches.has(id)) {
    // return the existing in-flight promise
    return inflightFetches.get(id);
  }

  const p = (async () => {
    try {
      if (!yt) await initYouTube();
      // Use the video ID when calling getInfo (fixes some Innertube issues)
      const info = await yt.getInfo(id);
      infoCache.set(id, { info, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
      return info;
    } finally {
      inflightFetches.delete(id);
    }
  })();

  inflightFetches.set(id, p);
  return p;
}

// Find a usable format URL (prefer audio-only). Save short-lived format URLs in cache.
async function getFormatWithCache(urlOrId) {
  const id = extractVideoId(urlOrId) || urlOrId;
  if (!id) throw new Error('Invalid video id/url');

  const now = Date.now();
  const fCached = formatCache.get(id);
  if (fCached && fCached.expiresAt > now) {
    return { url: fCached.url, mimeType: fCached.mimeType };
  }

  // get info (cached/coalesced)
  let info;
  try {
    info = await getInfoWithCache(id);
  } catch (err) {
    throw new Error(`yt.getInfo failed: ${err && err.message ? err.message : err}`);
  }

  // 1) Try innertube chooseFormat audio
  try {
    if (info && typeof info.chooseFormat === 'function') {
      const best = info.chooseFormat({ type: 'audio', quality: 'best' });
      if (best && best.url) {
        formatCache.set(id, { url: best.url, mimeType: best.mimeType || 'audio/mp4', expiresAt: Date.now() + FORMAT_CACHE_TTL_MS });
        return { url: best.url, mimeType: best.mimeType || 'audio/mp4' };
      }
    }
  } catch (e) {
    console.warn('chooseFormat(audio) failed:', e && e.message ? e.message : e);
  }

  // 2) Fallback: scan formats or streamingData for audio
  const formats = info.formats || (info.streamingData && (info.streamingData.adaptiveFormats || info.streamingData.formats)) || [];
  const candidates = [];

  for (const f of formats) {
    const mime = f.mimeType || '';
    const hasAudioCodec = /audio/i.test(mime) || !!f.audioCodec || !!f.audioQuality || !!f.audioSampleRate;
    const hasUrl = !!f.url;
    if (hasUrl && hasAudioCodec) {
      candidates.push({
        url: f.url,
        mimeType: f.mimeType || (f.container ? `audio/${f.container}` : 'audio/mp4'),
        bitrate: f.bitrate || f.averageBitrate || 0,
        audioOnly: /audio\/|audioonly|m4a|webm/.test(mime)
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.audioOnly !== b.audioOnly) return a.audioOnly ? -1 : 1;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });
    const chosen = candidates[0];
    formatCache.set(id, { url: chosen.url, mimeType: chosen.mimeType || 'audio/mp4', expiresAt: Date.now() + FORMAT_CACHE_TTL_MS });
    return { url: chosen.url, mimeType: chosen.mimeType || 'audio/mp4' };
  }

  // 3) Last resort: pick any muxed format with a URL
  for (const f of formats) {
    if (f && f.url) {
      const mime = f.mimeType || '';
      if (/mp4|webm|ogg/i.test(mime) || f.container) {
        formatCache.set(id, { url: f.url, mimeType: f.mimeType || 'video/mp4', expiresAt: Date.now() + FORMAT_CACHE_TTL_MS });
        return { url: f.url, mimeType: f.mimeType || 'video/mp4' };
      }
    }
  }

  throw new Error('No usable audio or muxed format URL found for video (maybe restricted or removed)');
}

// ------------------ /stream endpoint ------------------

app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('No URL provided');

  const clientIp = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress);
  if (!allowRequestFromIp(clientIp)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).send('Too many requests — slow down');
  }

  console.log(`🔄 Stream requested: ${videoUrl} from ${clientIp}`);

  // helper to attempt streaming
  const attemptStream = async () => {
    const { url: formatUrl, mimeType } = await getFormatWithCache(videoUrl);
    if (!formatUrl) throw new Error('No format URL resolved');

    // optional: HEAD check (some servers block HEAD; ignore HEAD failures)
    try {
      await axios.head(formatUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com/' },
        timeout: 8000
      });
    } catch (herr) {
      // HEAD sometimes fails even though GET works; log and continue
      console.warn('HEAD check warning for format URL:', herr && herr.message ? herr.message : herr);
    }

    const resp = await axios({
      method: 'get',
      url: formatUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*',
        'Referer': 'https://www.youtube.com/'
      },
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    res.setHeader('Content-Type', mimeType || 'audio/mp4');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Transfer-Encoding', 'chunked');

    resp.data.pipe(res);

    resp.data.on('error', (err) => {
      console.error('Upstream stream error:', err && err.message ? err.message : err);
      try { res.end(); } catch (e) {}
    });

    req.on('close', () => {
      try { if (resp.data && resp.data.destroy) resp.data.destroy(); } catch (e) {}
    });

    return true;
  };

  try {
    await attemptStream();
  } catch (err) {
    console.warn('First stream attempt failed:', err && err.message ? err.message : err);
    const transient = /timed out|timeout|ECONNRESET|socket hang up|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|502|503/i.test(err && err.message ? err.message : '');
    if (transient) {
      console.log('Retrying stream once due to transient error...');
      try {
        await attemptStream();
        return;
      } catch (err2) {
        console.error('Retry stream failed:', err2 && err2.message ? err2.message : err2);
        if (!res.headersSent) return res.status(502).send(`Proxy Error: ${err2.message || err2}`);
      }
    } else {
      console.error('Stream proxy error (non-transient):', err && err.message ? err.message : err);
      if (!res.headersSent) {
        if (/restricted|age|private|blocked|not available|geo/i.test(err && err.message ? err.message : '')) {
          return res.status(410).send(`Content Unavailable: ${err.message || err}`);
        }
        return res.status(500).send(`Server Error: ${err.message || err}`);
      }
    }
  }
});

// ------------------ Socket.IO + room logic ------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

// Simple socket throttles
const socketSearchTimestamps = new Map();
const SEARCH_MIN_INTERVAL_MS = 1500;

const socketRequestSongCounts = new Map();
const REQUEST_WINDOW_MS = 60 * 1000;
const REQUEST_MAX_PER_WINDOW = 10;

io.on('connection', (socket) => {
  console.log(`⚡ User connected: ${socket.id}`);

  const playNext = (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.queue.length === 0) {
      if (room) room.isPlaying = false;
      return;
    }
    const nextSong = room.queue.shift();
    const proxyUrl = `/stream?url=${encodeURIComponent(nextSong.originalUrl)}`;

    room.currentSongUrl = proxyUrl;
    room.currentTitle = nextSong.title;
    room.currentThumbnail = nextSong.thumbnail;
    room.isPlaying = true;
    room.timestamp = 0;
    room.lastUpdate = Date.now();

    io.to(roomCode).emit('play_song', {
      url: proxyUrl,
      title: nextSong.title,
      thumbnail: nextSong.thumbnail
    });
    io.to(roomCode).emit('queue_updated', room.queue);
  };

  socket.on('join_room', ({ roomCode, username }) => {
    socket.join(roomCode);
    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        currentSongUrl: null,
        currentTitle: "No Song Playing",
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
      const timeDiff = (Date.now() - room.lastUpdate) / 1000;
      adjustedTime += timeDiff;
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
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const index = room.users.findIndex(user => user.id === socket.id);
      if (index !== -1) {
        room.users.splice(index, 1);
        io.to(roomCode).emit('update_users', room.users);
        if (room.users.length === 0) delete rooms[roomCode];
        break;
      }
    }
    socketSearchTimestamps.delete(socket.id);
    socketRequestSongCounts.delete(socket.id);
    console.log(`⚡ User disconnected: ${socket.id}`);
  });

  socket.on('search_query', async (query) => {
    try {
      const last = socketSearchTimestamps.get(socket.id) || 0;
      const now = Date.now();
      if (now - last < SEARCH_MIN_INTERVAL_MS) {
        return socket.emit('search_results', []);
      }
      socketSearchTimestamps.set(socket.id, now);

      const searchResults = await ytsr(query, { limit: 10 });
      const results = (searchResults.items || [])
        .filter(item => item.type === 'video')
        .slice(0, 8)
        .map(item => ({
          title: item.title,
          id: item.id,
          url: item.url,
          thumbnail:
            (item.bestThumbnail && item.bestThumbnail.url) ||
            (item.thumbnails && item.thumbnails[0] && item.thumbnails[0].url) ||
            null
        }));

      socket.emit('search_results', results);
    } catch (e) {
      console.error('Search failed', e && e.message ? e.message : e);
      socket.emit('song_error', 'Search failed.');
    }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    const now = Date.now();
    let srec = socketRequestSongCounts.get(socket.id);
    if (!srec || now - srec.windowStart > REQUEST_WINDOW_MS) {
      srec = { count: 0, windowStart: now };
    }
    if (srec.count >= REQUEST_MAX_PER_WINDOW) {
      return socket.emit('song_error', 'Too many song requests — slow down.');
    }
    srec.count += 1;
    socketRequestSongCounts.set(socket.id, srec);

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        currentSongUrl: null,
        currentTitle: "No Song Playing",
        currentThumbnail: null,
        queue: [],
        users: [],
        isPlaying: false,
        timestamp: 0,
        lastUpdate: Date.now()
      };
    }

    const room = rooms[roomCode];
    room.queue.push({
      title: title,
      thumbnail: thumbnail,
      originalUrl: youtubeUrl,
      audioUrl: null
    });

    io.to(roomCode).emit('queue_updated', room.queue);

    if (!room.isPlaying) {
      playNext(roomCode);
    }
  });

  socket.on('skip_track', (roomCode) => playNext(roomCode));

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
});

// ------------------ Start server ------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
