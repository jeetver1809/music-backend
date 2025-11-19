// // server.js (Fixed for Render & YouTube 410 Errors)
// // Includes Cookie Auth and User-Agent Spoofing

// const express = require('express');
// const http = require('http');
// const { Server } = require('socket.io');
// const { Innertube, UniversalCache } = require('youtubei.js');
// const ytsr = require('ytsr');
// const axios = require('axios');

// const app = express();
// app.use(express.json());

// // ------------------ CORS ------------------
// app.use((req, res, next) => {
//   res.setHeader('Access-Control-Allow-Origin', '*');
//   res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Accept-Encoding');
//   res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Encoding, Content-Length, ETag, Cache-Control');
//   if (req.method === 'OPTIONS') return res.sendStatus(204);
//   next();
// });

// app.get('/', (req, res) => res.send('Music Jam Server Online (Patched) 🚀'));

// // ------------------ YouTube Innertube Init ------------------
// let yt = null;

// // Function to Initialize YouTube with Cookie
// async function initYouTube() {
//   try {
//     console.log("🔄 Initializing YouTube InnerTube...");
//     yt = await Innertube.create({
//       cache: new UniversalCache(false),
//       generate_session_locally: true,
//       // CRITICAL FIX: Inject cookie from Render Env Var
//       cookie: process.env.YT_COOKIE || '' 
//     });
//     console.log("✅ YouTube InnerTube Initialized (Cookie Loaded)!");
//   } catch (e) {
//     console.error("❌ Failed to init YouTube:", e && e.message ? e.message : e);
//   }
// }
// initYouTube();

// // ------------------ Utilities ------------------
// function extractVideoId(urlOrId) {
//   if (!urlOrId) return null;
//   if (/^[0-9A-Za-z_-]{11}$/.test(urlOrId)) return urlOrId;
//   let m = urlOrId.match(/[?&]v=([0-9A-Za-z_-]{11})/);
//   if (m && m[1]) return m[1];
//   m = urlOrId.match(/youtu\.be\/([0-9A-Za-z_-]{11})/);
//   if (m && m[1]) return m[1];
//   m = urlOrId.match(/\/shorts\/([0-9A-Za-z_-]{11})/);
//   if (m && m[1]) return m[1];
//   m = urlOrId.match(/([0-9A-Za-z_-]{11})/);
//   return m ? m[1] : null;
// }

// // ------------------ Rate Limiting & Caching ------------------
// const RATE_CAPACITY = 30; 
// const RATE_WINDOW_MS = 60 * 1000; 
// const TOKEN_REFILL_PER_MS = RATE_CAPACITY / RATE_WINDOW_MS;
// const ipBuckets = new Map();

// function allowRequestFromIp(ip) {
//   if (!ip) return false;
//   const now = Date.now();
//   let bucket = ipBuckets.get(ip);
//   if (!bucket) {
//     bucket = { tokens: RATE_CAPACITY - 1, last: now };
//     ipBuckets.set(ip, bucket);
//     return true;
//   }
//   const elapsed = now - bucket.last;
//   const refill = elapsed * TOKEN_REFILL_PER_MS;
//   bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + refill);
//   bucket.last = now;
//   if (bucket.tokens >= 1) {
//     bucket.tokens -= 1;
//     return true;
//   }
//   return false;
// }

// // Cache setup
// const INFO_CACHE_TTL_MS = 5 * 60 * 1000;
// const FORMAT_CACHE_TTL_MS = 30 * 1000;
// const infoCache = new Map();
// const formatCache = new Map();
// const inflightFetches = new Map();

// // GC Interval
// setInterval(() => {
//   const now = Date.now();
//   for (const [ip, bucket] of ipBuckets.entries()) if (now - bucket.last > 30 * 60 * 1000) ipBuckets.delete(ip);
//   for (const [k, v] of infoCache.entries()) if (v.expiresAt <= now) infoCache.delete(k);
//   for (const [k, v] of formatCache.entries()) if (v.expiresAt <= now) formatCache.delete(k);
// }, 60 * 1000);

// // ------------------ YouTube Helpers ------------------

// async function getInfoWithCache(urlOrId) {
//   const id = extractVideoId(urlOrId) || urlOrId;
//   if (!id) throw new Error('Invalid video id/url');

//   const now = Date.now();
//   const cached = infoCache.get(id);
//   if (cached && cached.expiresAt > now) return cached.info;
//   if (inflightFetches.has(id)) return inflightFetches.get(id);

//   const p = (async () => {
//     try {
//       if (!yt) await initYouTube();
//       const info = await yt.getInfo(id);
//       infoCache.set(id, { info, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
//       return info;
//     } finally {
//       inflightFetches.delete(id);
//     }
//   })();

//   inflightFetches.set(id, p);
//   return p;
// }

// async function getFormatWithCache(urlOrId) {
//   // Direct file bypass
//   if (typeof urlOrId === 'string' && /^https?:\/\//i.test(urlOrId) && !/youtube\.com|youtu\.be/i.test(urlOrId)) {
//     const extMatch = urlOrId.match(/\.(mp3|m4a|mp4|webm|ogg)(?:\?|$)/i);
//     const mimeType = extMatch && extMatch[1] === 'mp3' ? 'audio/mpeg' : 'application/octet-stream';
//     return { url: urlOrId, mimeType };
//   }

//   const id = extractVideoId(urlOrId) || urlOrId;
//   if (!id) throw new Error('Invalid video id/url');

//   const now = Date.now();
//   const fCached = formatCache.get(id);
//   if (fCached && fCached.expiresAt > now) return { url: fCached.url, mimeType: fCached.mimeType };

//   let info;
//   try {
//     info = await getInfoWithCache(id);
//   } catch (err) {
//     throw new Error(`yt.getInfo failed: ${err.message}`);
//   }

//   // 1) Try Audio Only
//   try {
//     if (info && typeof info.chooseFormat === 'function') {
//       const best = info.chooseFormat({ type: 'audio', quality: 'best' });
//       if (best && best.url) {
//         formatCache.set(id, { url: best.url, mimeType: best.mimeType || 'audio/mp4', expiresAt: Date.now() + FORMAT_CACHE_TTL_MS });
//         return { url: best.url, mimeType: best.mimeType || 'audio/mp4' };
//       }
//     }
//   } catch (e) {}

//   // 2) Manual Format Scan
//   const formats = info.formats || (info.streamingData && (info.streamingData.adaptiveFormats || info.streamingData.formats)) || [];
//   const candidates = [];

//   for (const f of formats) {
//     const mime = f.mimeType || '';
//     if (f.url && (/audio/i.test(mime) || f.audioCodec)) {
//       candidates.push({
//         url: f.url,
//         mimeType: f.mimeType || 'audio/mp4',
//         bitrate: f.bitrate || 0,
//         audioOnly: /audio\/|audioonly/.test(mime)
//       });
//     }
//   }

//   if (candidates.length > 0) {
//     candidates.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
//     const chosen = candidates[0];
//     formatCache.set(id, { url: chosen.url, mimeType: chosen.mimeType, expiresAt: Date.now() + FORMAT_CACHE_TTL_MS });
//     return { url: chosen.url, mimeType: chosen.mimeType };
//   }

//   throw new Error('No usable audio format found');
// }

// // ------------------ The Proxy Endpoint (Fixed) ------------------
// app.get('/stream', async (req, res) => {
//   const videoUrl = req.query.url;
//   if (!videoUrl) return res.status(400).send('No URL provided');

//   const clientIp = req.ip || req.headers['x-forwarded-for'];
//   if (!allowRequestFromIp(clientIp)) {
//     res.setHeader('Retry-After', '60');
//     return res.status(429).send('Too many requests');
//   }

//   console.log(`🔄 Stream requested: ${videoUrl}`);

//   try {
//     const { url: formatUrl, mimeType } = await getFormatWithCache(videoUrl);
    
//     // CRITICAL FIX: Real Browser Headers for the Proxy Request
//     const forwardHeaders = {
//       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//       'Referer': 'https://www.youtube.com/',
//       'Accept': '*/*'
//     };
//     if (req.headers.range) forwardHeaders.Range = req.headers.range;

//     const upstream = await axios({
//       method: 'get',
//       url: formatUrl,
//       responseType: 'stream',
//       headers: forwardHeaders,
//       timeout: 30000, // Increased timeout
//       validateStatus: status => (status >= 200 && status < 400)
//     });

//     res.status(upstream.status);
    
//     const headerWhitelist = ['content-range','accept-ranges','content-length','content-type','etag','cache-control'];
//     for (const h of headerWhitelist) {
//       if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
//     }
//     if (!res.getHeader('content-type')) res.setHeader('Content-Type', mimeType || 'audio/mp4');

//     upstream.data.pipe(res);

//     upstream.data.on('error', (err) => {
//       console.error('Stream error:', err.message);
//       res.end(); 
//     });

//     req.on('close', () => {
//       if (upstream.data && typeof upstream.data.destroy === 'function') upstream.data.destroy();
//     });

//   } catch (err) {
//     console.warn('Proxy error:', err.message);
//     if (/unavailable|410|403|restricted/i.test(err.message)) {
//       return res.status(410).send(`Content Unavailable: ${err.message}`);
//     }
//     return res.status(500).send(`Server Error: ${err.message}`);
//   }
// });

// // ------------------ Debug Info ------------------
// app.get('/debug-info', async (req, res) => {
//   const url = req.query.url;
//   if (!url) return res.status(400).send({ ok: false, error: 'No url' });
//   const id = extractVideoId(url);
//   if (!id) return res.status(400).send({ ok: false, error: 'No id' });

//   try {
//     if (!yt) await initYouTube();
//     const info = await yt.getInfo(id);
//     return res.send({
//       ok: true,
//       title: info.basic_info.title,
//       author: info.basic_info.author,
//       id: id
//     });
//   } catch (err) {
//     return res.status(500).send({ ok: false, error: err.message });
//   }
// });

// // ------------------ Socket.IO ------------------
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: { origin: "*", methods: ["GET", "POST"] }
// });

// const rooms = {};
// const socketSearchTimestamps = new Map();

// io.on('connection', (socket) => {
//   console.log(`⚡ Connected: ${socket.id}`);

//   socket.on('join_room', ({ roomCode, username }) => {
//     socket.join(roomCode);
//     if (!rooms[roomCode]) {
//       rooms[roomCode] = {
//         currentSongUrl: null, currentTitle: "No Song Playing", currentThumbnail: null,
//         queue: [], users: [], isPlaying: false, timestamp: 0, lastUpdate: Date.now()
//       };
//     }
//     const room = rooms[roomCode];
//     if (!room.users.find(u => u.id === socket.id)) {
//       room.users.push({ id: socket.id, name: username || `User ${socket.id.substr(0,4)}` });
//     }
//     io.to(roomCode).emit('update_users', room.users);
    
//     let adjustedTime = room.timestamp;
//     if (room.isPlaying) adjustedTime += (Date.now() - room.lastUpdate) / 1000;

//     socket.emit('sync_state', {
//       url: room.currentSongUrl, title: room.currentTitle, thumbnail: room.currentThumbnail,
//       isPlaying: room.isPlaying, timestamp: adjustedTime, queue: room.queue
//     });
//   });

//   socket.on('disconnect', () => {
//     for (const roomCode in rooms) {
//       const room = rooms[roomCode];
//       const idx = room.users.findIndex(u => u.id === socket.id);
//       if (idx !== -1) {
//         room.users.splice(idx, 1);
//         io.to(roomCode).emit('update_users', room.users);
//         if (room.users.length === 0) delete rooms[roomCode];
//         break;
//       }
//     }
//     socketSearchTimestamps.delete(socket.id);
//   });

//   socket.on('search_query', async (query) => {
//     const last = socketSearchTimestamps.get(socket.id) || 0;
//     if (Date.now() - last < 1500) return socket.emit('search_results', []);
//     socketSearchTimestamps.set(socket.id, Date.now());

//     try {
//       const search = await ytsr(query, { limit: 10 });
//       const results = (search.items || []).filter(i => i.type === 'video').slice(0,8)
//         .map(i => ({
//           title: i.title, id: i.id, url: i.url,
//           thumbnail: i.bestThumbnail?.url || i.thumbnails?.[0]?.url
//         }));
//       socket.emit('search_results', results);
//     } catch (e) { socket.emit('song_error', 'Search failed'); }
//   });

//   socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
//     try {
//       // Validate YT ID
//       const id = extractVideoId(youtubeUrl);
//       if (id) await getInfoWithCache(id); // This checks availability
      
//       if (!rooms[roomCode]) return;
//       const room = rooms[roomCode];
//       room.queue.push({ title, thumbnail, originalUrl: youtubeUrl });
//       io.to(roomCode).emit('queue_updated', room.queue);

//       if (!room.isPlaying) {
//         playNext(roomCode);
//       }
//     } catch (e) {
//       socket.emit('song_error', 'Could not add song: ' + e.message);
//     }
//   });

//   socket.on('skip_track', (roomCode) => playNext(roomCode));

//   socket.on('pause_track', ({ roomCode, timestamp }) => {
//     if (rooms[roomCode]) {
//       rooms[roomCode].isPlaying = false;
//       rooms[roomCode].timestamp = timestamp;
//       rooms[roomCode].lastUpdate = Date.now();
//       socket.to(roomCode).emit('receive_pause', timestamp);
//     }
//   });

//   socket.on('play_track', ({ roomCode, timestamp }) => {
//     if (rooms[roomCode]) {
//       rooms[roomCode].isPlaying = true;
//       rooms[roomCode].timestamp = timestamp;
//       rooms[roomCode].lastUpdate = Date.now();
//       socket.to(roomCode).emit('receive_play', timestamp);
//     }
//   });

//   socket.on('seek_track', ({ roomCode, timestamp }) => {
//     if (rooms[roomCode]) {
//       rooms[roomCode].timestamp = timestamp;
//       rooms[roomCode].lastUpdate = Date.now();
//       io.to(roomCode).emit('receive_seek', timestamp);
//     }
//   });
// });

// function playNext(roomCode) {
//   const room = rooms[roomCode];
//   if (!room || room.queue.length === 0) {
//     if (room) room.isPlaying = false;
//     return;
//   }
//   const next = room.queue.shift();
//   const proxyUrl = `/stream?url=${encodeURIComponent(next.originalUrl)}`;
  
//   room.currentSongUrl = proxyUrl;
//   room.currentTitle = next.title;
//   room.currentThumbnail = next.thumbnail;
//   room.isPlaying = true;
//   room.timestamp = 0;
//   room.lastUpdate = Date.now();

//   io.to(roomCode).emit('play_song', { url: proxyUrl, title: next.title, thumbnail: next.thumbnail });
//   io.to(roomCode).emit('queue_updated', room.queue);
// }

// const PORT = process.env.PORT || 3001;
// server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`)); 






// server.js (Drop-in replacement)
// Fixed: Uses WEB client to match Browser Cookies + Internal Downloader

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Innertube, UniversalCache } = require('youtubei.js');
const ytsr = require('ytsr');

const app = express();
app.use(express.json());

// ------------------ CORS ------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Accept-Encoding');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Encoding, Content-Length, ETag');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.send('Music Jam Server (Web Client Fix) 🚀'));

// ------------------ YouTube Innertube Init ------------------
let yt = null;

async function initYouTube() {
  try {
    console.log("🔄 Connecting to YouTube...");
    yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      cookie: process.env.YT_COOKIE, // Your cookie from Render Env
      // CRITICAL FIX: Match the client to where you got the cookie (Web Browser)
      client_type: 'WEB' 
    });
    console.log("✅ YouTube Client (WEB) Initialized!");
  } catch (e) {
    console.error("❌ Failed to init YouTube:", e.message);
  }
}
initYouTube();

// ------------------ Utilities ------------------
function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  if (/^[0-9A-Za-z_-]{11}$/.test(urlOrId)) return urlOrId;
  let m = urlOrId.match(/[?&]v=([0-9A-Za-z_-]{11})/);
  return m ? m[1] : null;
}

// ------------------ The Stream Endpoint (New Method) ------------------
app.get('/stream', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('No URL provided');
  
  const id = extractVideoId(videoUrl);
  if (!id) return res.status(400).send('Invalid Video ID');

  console.log(`🎧 Streaming: ${id}`);

  try {
    if (!yt) await initYouTube();

    // Use the built-in downloader. It handles signatures & headers better than Axios.
    const stream = await yt.download(id, {
      type: 'audio',       // Audio only
      quality: 'best',     // Best quality
      format: 'mp4',       // MP4 container (safest for browsers)
      client: 'WEB'        // Ensure we use the Web client
    });

    // Set standard headers
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Pipe the clean stream directly to the response
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();

  } catch (err) {
    console.error(`Stream Error for ${id}:`, err.message);
    // Don't send 410 HTML, just end response so browser doesn't show ORB error
    if (!res.headersSent) res.sendStatus(500); 
  }
});

// ------------------ Debug Endpoint ------------------
app.get('/debug-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send({ ok: false });
  const id = extractVideoId(url);
  
  try {
    if (!yt) await initYouTube();
    const info = await yt.getInfo(id);
    return res.send({ 
      ok: true, 
      title: info.basic_info.title, 
      client: 'WEB',
      cookie_present: !!process.env.YT_COOKIE 
    });
  } catch (err) {
    return res.status(500).send({ ok: false, error: err.message });
  }
});

// ------------------ Socket.IO (Standard) ------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const rooms = {};

io.on('connection', (socket) => {
  console.log(`⚡ User: ${socket.id}`);

  socket.on('join_room', ({ roomCode, username }) => {
    socket.join(roomCode);
    if (!rooms[roomCode]) {
      rooms[roomCode] = { queue: [], users: [], isPlaying: false, timestamp: 0, lastUpdate: Date.now() };
    }
    const room = rooms[roomCode];
    if (!room.users.find(u => u.id === socket.id)) room.users.push({ id: socket.id, name: username || 'User' });
    
    let time = room.timestamp;
    if (room.isPlaying) time += (Date.now() - room.lastUpdate) / 1000;
    
    socket.emit('sync_state', { 
      url: room.currentSongUrl, title: room.currentTitle, thumbnail: room.currentThumbnail,
      isPlaying: room.isPlaying, timestamp: time, queue: room.queue 
    });
  });

  socket.on('search_query', async (query) => {
    try {
      const search = await ytsr(query, { limit: 5 });
      const results = (search.items || []).filter(i => i.type === 'video').map(i => ({
        title: i.title, id: i.id, url: i.url, thumbnail: i.bestThumbnail?.url
      }));
      socket.emit('search_results', results);
    } catch (e) { socket.emit('search_results', []); }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    if (!rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.queue.push({ title, thumbnail, originalUrl: youtubeUrl });
    io.to(roomCode).emit('queue_updated', room.queue);
    if (!room.isPlaying) playNext(roomCode);
  });

  socket.on('skip_track', (roomCode) => playNext(roomCode));
  socket.on('pause_track', ({ roomCode, timestamp }) => {
    if (rooms[roomCode]) { rooms[roomCode].isPlaying = false; rooms[roomCode].timestamp = timestamp; rooms[roomCode].lastUpdate = Date.now(); socket.to(roomCode).emit('receive_pause', timestamp); }
  });
  socket.on('play_track', ({ roomCode, timestamp }) => {
    if (rooms[roomCode]) { rooms[roomCode].isPlaying = true; rooms[roomCode].timestamp = timestamp; rooms[roomCode].lastUpdate = Date.now(); socket.to(roomCode).emit('receive_play', timestamp); }
  });
  socket.on('seek_track', ({ roomCode, timestamp }) => {
    if (rooms[roomCode]) { rooms[roomCode].timestamp = timestamp; rooms[roomCode].lastUpdate = Date.now(); io.to(roomCode).emit('receive_seek', timestamp); }
  });
});

function playNext(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.queue.length) return;
  const next = room.queue.shift();
  // Simple stream URL
  const proxyUrl = `/stream?url=${encodeURIComponent(next.originalUrl)}`;
  
  room.currentSongUrl = proxyUrl;
  room.currentTitle = next.title;
  room.currentThumbnail = next.thumbnail;
  room.isPlaying = true;
  room.timestamp = 0;
  room.lastUpdate = Date.now();

  io.to(roomCode).emit('play_song', { url: proxyUrl, title: next.title, thumbnail: next.thumbnail });
  io.to(roomCode).emit('queue_updated', room.queue);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));