// server.js (drop-in ready)
// Music Jam server with caching, rate-limiting, Range-aware streaming, and validated queueing.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Innertube, UniversalCache } = require('youtubei.js');
const ytsr = require('ytsr');
const axios = require('axios');

const app = express();
app.use(express.json());

// ------------------ CORS (explicit, exposes streaming headers) ------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // allow all origins
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Accept-Encoding');
  // Expose these headers so the browser can read them
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Encoding, Content-Length, ETag, Cache-Control');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.get('/', (req, res) => res.send('Music Jam Server Online! 🚀'));

// ------------------ YouTube Innertube init ------------------
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
const RATE_WINDOW_MS = 60 * 1000; // 60s
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
const formatCache = new Map(); // videoId/url -> { url, mimeType, expiresAt }
const inflightFetches = new Map(); // videoId -> Promise

// Cleanup caches periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of infoCache.entries()) if (v.expiresAt <= now) infoCache.delete(k);
  for (const [k, v] of formatCache.entries()) if (v.expiresAt <= now) formatCache.delete(k);
}, 60 * 1000);

// ------------------ YouTube helpers ------------------

// Always call Innertube with a VIDEO ID; coalesce concurrent fetches
async function getInfoWithCache(urlOrId) {
  const id = extractVideoId(urlOrId) || urlOrId;
  if (!id) throw new Error('Invalid video id/url');

  const now = Date.now();
  const cached = infoCache.get(id);
  if (cached && cached.expiresAt > now) {
    return cached.info;
  }

  if (inflightFetches.has(id)) {
    return inflightFetches.get(id);
  }

  const p = (async () => {
    try {
      if (!yt) await initYouTube();
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

// Find best usable audio/muxed format URL; cache short-lived format URLs
async function getFormatWithCache(urlOrId) {
  // QUICK PASSTHROUGH: if the provided urlOrId is a direct http(s) media URL
  // that is NOT a YouTube link, return it directly (so mp3 tests work).
  if (typeof urlOrId === 'string' && /^https?:\/\//i.test(urlOrId) &&
      !/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(urlOrId)) {
    // Guess mime type based on extension (optional)
    const extMatch = urlOrId.match(/\.(mp3|m4a|mp4|webm|ogg)(?:\?|$)/i);
    const mimeType = extMatch ? (
      extMatch[1].toLowerCase() === 'mp3' ? 'audio/mpeg' :
      extMatch[1].toLowerCase() === 'm4a' ? 'audio/mp4' :
      extMatch[1].toLowerCase() === 'mp4' ? 'video/mp4' :
      extMatch[1].toLowerCase() === 'webm' ? 'audio/webm' :
      extMatch[1].toLowerCase() === 'ogg' ? 'audio/ogg' :
      'application/octet-stream'
    ) : 'application/octet-stream';

    const key = urlOrId; // use entire URL as cache key for non-YT
    formatCache.set(key, { url: urlOrId, mimeType, expiresAt: Date.now() + FORMAT_CACHE_TTL_MS });
    return { url: urlOrId, mimeType };
  }

  const id = extractVideoId(urlOrId) || urlOrId;
  if (!id) throw new Error('Invalid video id/url');

  const now = Date.now();
  const fCached = formatCache.get(id);
  if (fCached && fCached.expiresAt > now) {
    return { url: fCached.url, mimeType: fCached.mimeType };
  }

  let info;
  try {
    info = await getInfoWithCache(id);
  } catch (err) {
    throw new Error(`yt.getInfo failed: ${err && err.message ? err.message : err}`);
  }

  // 1) Prefer audio-only format via Innertube helper
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

  // 2) Fallback: scan formats/adaptiveFormats for audio
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

  // 3) Last resort: pick any muxed format with a url
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

// ------------------ Range-aware /stream endpoint ------------------
app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('No URL provided');

  const clientIp = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress);
  if (!allowRequestFromIp(clientIp)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).send('Too many requests — slow down');
  }

  console.log(`🔄 Stream requested: ${videoUrl} from ${clientIp}`);

  try {
    // Resolve actual format URL first (re-uses getFormatWithCache)
    const { url: formatUrl, mimeType } = await getFormatWithCache(videoUrl);
    if (!formatUrl) throw new Error('No format URL resolved');

    // Build headers to forward to upstream; include Range if client asked for it
    const forwardHeaders = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Referer': 'https://www.youtube.com/',
      'Accept': '*/*'
    };
    if (req.headers.range) forwardHeaders.Range = req.headers.range;

    // Make upstream request (stream)
    const upstream = await axios({
      method: 'get',
      url: formatUrl,
      responseType: 'stream',
      headers: forwardHeaders,
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: status => (status >= 200 && status < 400) // allow 206
    });

    // Mirror the important headers/status from upstream to the client
    const headerWhitelist = ['content-range','accept-ranges','content-length','content-type','etag','cache-control'];
    // set status (use upstream status so 206 Partial Content is preserved)
    res.status(upstream.status);
    // copy safe headers
    for (const h of headerWhitelist) {
      if (upstream.headers[h]) {
        res.setHeader(h, upstream.headers[h]);
      }
    }
    // ensure Content-Type if missing
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', mimeType || 'audio/mp4');

    // Pipe the upstream stream to the client
    upstream.data.pipe(res);

    upstream.data.on('error', (err) => {
      console.error('Upstream stream error:', err && err.message ? err.message : err);
      try { res.end(); } catch (e) {}
    });

    // If the client disconnects, destroy upstream stream
    req.on('close', () => {
      try { if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy(); } catch (e) {}
    });

    return;
  } catch (err) {
    console.warn('Stream proxy error:', err && err.message ? err.message : err);
    const msg = err && err.message ? err.message : 'Unknown';
    if (/restricted|age|private|blocked|not available|geo|This video is unavailable/i.test(msg)) {
      return res.status(410).send(`Content Unavailable: ${msg}`);
    }
    return res.status(500).send(`Server Error: ${msg}`);
  }
});

// ------------------ DEBUG endpoint ------------------
app.get('/debug-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send({ ok: false, error: 'No url provided' });

  const id = extractVideoId(url);
  if (!id) return res.status(400).send({ ok: false, error: 'Could not extract video id' });

  try {
    if (!yt) await initYouTube();
    const info = await yt.getInfo(id);

    const title = (info.videoDetails && info.videoDetails.title) || info.title || 'Unknown';
    const playability = info.playabilityStatus || {};
    const isLive = !!(info.isLive || (info.videoDetails && info.videoDetails.isLive));
    const formats = info.formats || (info.streamingData && (info.streamingData.adaptiveFormats || info.streamingData.formats)) || [];

    const formatsSummary = formats.slice(0, 50).map(f => ({
      itag: f.itag || null,
      container: f.container || null,
      mimeType: f.mimeType || null,
      audioCodec: f.audioCodec || null,
      qualityLabel: f.qualityLabel || null,
      bitrate: f.bitrate || f.averageBitrate || null,
      hasUrl: !!f.url,
      approxSizeMb: f.contentLength ? Math.round((Number(f.contentLength)||0)/(1024*1024)) : null
    }));

    return res.send({
      ok: true,
      id,
      title,
      isLive,
      playability,
      formatsCount: formats.length,
      formatsPreview: formatsSummary
    });
  } catch (err) {
    console.error('debug-info error', err && err.message ? err.message : err);
    return res.status(500).send({ ok: false, error: err && err.message ? err.message : String(err) });
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

// Helper: play next in a room
function makePlayNext(roomCode) {
  return function playNext() {
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
}

io.on('connection', (socket) => {
  console.log(`⚡ User connected: ${socket.id}`);

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

  // Validated request_song handler
  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    try {
      // 1) Validate availability via getInfoWithCache (throws if unavailable)
      try {
        // For non-YT URLs, getInfoWithCache will throw; so we only run getInfoWithCache for YT links.
        // Use extractVideoId to decide.
        const id = extractVideoId(youtubeUrl);
        if (id) {
          await getInfoWithCache(id);
        } else {
          // Non-YT URL — try a HEAD to ensure it's reachable
          try {
            await axios.head(youtubeUrl, { timeout: 8000 });
          } catch (e) {
            console.warn('request_song: non-YT URL HEAD failed', youtubeUrl, e && e.message ? e.message : e);
            return socket.emit('song_error', `Cannot add "${title || 'this file'}": unreachable or unsupported.`);
          }
        }
      } catch (infoErr) {
        console.warn('request_song: getInfo failed for', youtubeUrl, infoErr && infoErr.message ? infoErr.message : infoErr);
        return socket.emit('song_error', `Cannot add "${title || 'this video'}": ${infoErr.message || 'unavailable'}`);
      }

      // 2) Per-socket rate limit for adding songs
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

      // 3) Ensure room exists and push to queue
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

      // 4) If nothing is playing, start playback
      if (!room.isPlaying) {
        const playNext = makePlayNext(roomCode);
        playNext();
      }
    } catch (e) {
      console.error('request_song: unexpected error', e && e.message ? e.message : e);
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
});

// ------------------ Start server ------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
