const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Innertube, UniversalCache } = require('youtubei.js'); // ✅ NEW: The anti-block library
const ytsr = require('ytsr'); 
const axios = require('axios'); // To pipe the stream

const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('Music Jam Server Online! 🚀'));

// --- GLOBAL YOUTUBE SESSION ---
let yt = null;

async function initYouTube() {
    try {
        yt = await Innertube.create({
            cache: new UniversalCache(false),
            generate_session_locally: true // This mimics a real Android device
        });
        console.log("✅ YouTube InnerTube Initialized!");
    } catch (e) {
        console.error("❌ Failed to init YouTube:", e);
    }
}
initYouTube();

// --- 1. ROBUST STREAMING ENDPOINT ---
app.get('/stream', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('No URL provided');
    
    // Extract Video ID from URL
    const videoId = videoUrl.split('v=')[1];
    if (!videoId) return res.status(400).send('Invalid Video ID');

    console.log(`🔄 Streaming ID: ${videoId}`);

    try {
        if (!yt) await initYouTube();

        // 1. Get Info using Android Client
        const info = await yt.getInfo(videoId);
        
        // 2. Find best audio format (m4a)
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });

        if (!format || !format.url) {
            return res.status(500).send('No audio format found');
        }

        // 3. Proxy the stream
        // We use axios to fetch the raw Google stream and pipe it to the phone
        // This keeps the IP connection between Server <-> Google, not Phone <-> Google
        const response = await axios({
            method: 'get',
            url: format.url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        // Set Headers for the phone
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Pipe data
        response.data.pipe(res);

        response.data.on('error', (err) => {
             console.error('Stream Interrupted:', err.message);
             res.end();
        });

    } catch (e) {
        console.error('Proxy Error:', e.message);
        if (!res.headersSent) res.status(500).send(`Server Error: ${e.message}`);
    }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

io.on('connection', (socket) => {
  console.log(`⚡ User: ${socket.id}`);

  const playNext = (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.queue.length === 0) {
        if(room) room.isPlaying = false;
        return;
    };

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
  });

  socket.on('search_query', async (query) => {
    try {
      const searchResults = await ytsr(query, { limit: 10 });
      const results = searchResults.items
        .filter(item => item.type === 'video')
        .slice(0, 5) 
        .map(item => ({
          title: item.title,
          id: item.id,
          url: item.url,
          thumbnail: item.bestThumbnail.url
        }));
      socket.emit('search_results', results);
    } catch (e) {
      socket.emit('song_error', "Search failed.");
    }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
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