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

// --- YT Init ---
let yt = null;
async function initYouTube() {
  try {
    yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });
    console.log("✅ YouTube InnerTube Initialized!");
  } catch (e) {
    console.error("❌ Failed to init YouTube:", e);
  }
}
initYouTube();

// --- Utilities: ID extraction ---
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

// ------------------- RATE LIMIT / CACHING -------------------

// --- 1) IP Token-bucket limiter for /stream ---
const RATE_CAPACITY = 30; // tokens
const RATE_WINDOW_MS = 60 * 1000; // 60s
const TOKEN_REFILL_PER_MS = RATE_CAPACITY / RATE_WINDOW_MS; // tokens added per ms
const ipBuckets = new Map(); // ip -> { tokens, last }

// returns true if allowed, false otherwise
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

// Garbage-collect old IP buckets every 10 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of ipBuckets.entries()) {
    if (now - bucket.last > 30 * 60 * 1000) { // 30 min idle
      ipBuckets.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// --- 2) Short-lived caches ---
// infoCache: caches yt.getInfo results (longer TTL so repeated plays/searches reuse it)
const INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const infoCache = new Map(); // videoId -> { info, expiresAt }

// formatCache: caches chosen audio format URL (short TTL because format.url can expire quickly)
const FORMAT_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const formatCache = new Map(); // videoId -> { url, mimeType, expiresAt }

// inflightFetches: coalesce multiple simultaneous fetches for same video
const inflightFetches = new Map(); // videoId -> Promise

// Helper: getInfoWithCache(videoIdOrUrl)
async function getInfoWithCache(urlOrId) {
  const id = extractVideoId(urlOrId) || urlOrId;
  if (!id) throw new Error('Invalid video id/url');

  const cached = infoCache.get(id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.info;
  }

  if (inflightFetches.has(id)) {
    return inflightFetches.get(id); // return existing promise
  }

  const p = (async () => {
    try {
      if (!yt) await initYouTube();
      // Innertube can accept either id or url
      const info = await yt.getInfo(urlOrId);
      // store in cache
      infoCache.set(id, { info, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
      return info;
    } finally {
      inflightFetches.delete(id);
    }
  })();

  inflightFetches.set(id, p);
  return p;
}

// Helper: getFormatWithCache(videoIdOrUrl) -> { url, mimeType }
async function getFormatWithCache(urlOrId) {
  const id = extractVideoId(urlOrId) || urlOrId;
  if (!id) throw new Error('Invalid video id/url');

  const now = Date.now();
  const fCached = formatCache.get(id);
  if (fCached && fCached.expiresAt > now) {
    return { url: fCached.url, mimeType: fCached.mimeType };
  }

  // fetch info (coalesced)
  const info = await getInfoWithCache(urlOrId);
  const format = info.chooseFormat({ type: 'audio', quality: 'best' });
  if (!format || !format.url) throw new Error('No audio format found');

  // store short-lived format URL
  formatCache.set(id, {
    url: format.url,
    mimeType: format.mimeType || 'audio/mp4',
    expiresAt: Date.now() + FORMAT_CACHE_TTL_MS
  });

  return { url: format.url, mimeType: format.mimeType || 'audio/mp4' };
}

// Periodically clear expired entries in caches (every minute)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of infoCache.entries()) if (v.expiresAt <= now) infoCache.delete(k);
  for (const [k, v] of formatCache.entries()) if (v.expiresAt <= now) formatCache.delete(k);
}, 60 * 1000);

// ------------------- STREAM ENDPOINT (with IP rate limit + format cache) -------------------
app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('No URL provided');

  // Rate-limit by client IP
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (!allowRequestFromIp(clientIp)) {
    res.setHeader('Retry-After', '60'); // suggest retry after 60s
    return res.status(429).send('Too many requests — slow down');
  }

  console.log(`🔄 Stream requested: ${videoUrl} from ${clientIp}`);

  try {
    // Use cached or freshly-fetched audio format URL (coalesced)
    const { url: formatUrl, mimeType } = await getFormatWithCache(videoUrl);

    // Proxy the stream (axios stream)
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

    // Pipe to client
    resp.data.pipe(res);

    resp.data.on('error', (err) => {
      console.error('Upstream stream error:', err && err.message);
      try { res.end(); } catch (e) {}
    });

    // If client disconnects, destroy upstream stream
    req.on('close', () => {
      try { if (resp.data && resp.data.destroy) resp.data.destroy(); } catch (e) {}
    });

  } catch (e) {
    console.error('Stream proxy error:', e && e.message);
    if (!res.headersSent) res.status(500).send(`Server Error: ${e.message}`);
  }
});

// ------------------- SOCKET.IO (with simple socket throttles) -------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

// Socket throttles: per-socket last timestamps
const socketSearchTimestamps = new Map(); // socketId -> lastSearchMs
const SEARCH_MIN_INTERVAL_MS = 1500; // allow ~1 search per 1.5s

const socketRequestSongCounts = new Map(); // socketId -> { count, windowStart }
const REQUEST_WINDOW_MS = 60 * 1000; // 1 minute
const REQUEST_MAX_PER_WINDOW = 10; // max songs a socket can add per minute

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
        // throttle - ignore or send empty
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
          thumbnail: (item.bestThumbnail && item.bestThumbnail.url) || (item.thumbnails && item.thumbnails[0] && item.thumbnails[0].url) || null
        }));

      socket.emit('search_results', results);
    } catch (e) {
      console.error('Search failed', e && e.message);
      socket.emit('song_error', 'Search failed.');
    }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    // simple per-socket rate limit for adding songs
    const now = Date.now();
    let srec = socketRequestSongCounts.get(socket.id);
    if (!srec || now - srec.windowStart > REQUEST_WINDOW_MS) {
      srec = { count: 0, windowStart: now };
    }
    if (srec.count >= REQUEST_MAX_PER_WINDOW) {
      // Too many requests from this socket in window
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
