const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ytdl = require('ytdl-core'); // Node-only streaming
const ytsr = require('ytsr'); 

const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('Music Jam Server Online! 🚀'));

// --- 1. STREAMING PROXY (FINAL VERSION) ---
app.get('/stream', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('No URL provided');

    // ✅ CRITICAL: Set headers immediately to avoid mobile player timeouts
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
        // ✅ FIX: Force lowest audio quality for fastest possible stream start
        const audioStream = ytdl(videoUrl, {
            filter: 'audioonly',
            quality: 'lowestaudio', 
            // We use the 'lowestaudio' quality tag to ensure the smallest header size.
            // This is the key to fixing the mobile player timeout.
        });

        // Pipe audio stream directly to the response
        audioStream.pipe(res);

        // Handle errors gracefully without crashing the server or hanging the request
        audioStream.on('error', (err) => {
            console.error('YTDL Stream Error:', err.message);
            // Only send error status if headers haven't already been sent
            if (!res.headersSent) {
                res.status(500).send('Stream initialization failed.');
            }
            audioStream.destroy();
        });
        
        // Handle client disconnection (prevents memory leak)
        req.on('close', () => {
            audioStream.destroy();
            console.log("Client disconnected, stream destroyed.");
        });

    } catch (e) {
        console.error('Proxy Catch Error:', e.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error during stream init.');
        }
    }
});
// --- End STREAMING PROXY ---

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

io.on('connection', (socket) => {
  console.log(`⚡ User: ${socket.id}`);

  // --- HELPER: Play Next ---
  const playNext = (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.queue.length === 0) {
        if(room) room.isPlaying = false;
        return;
    };

    const nextSong = room.queue.shift(); 
    // Proxy URL remains the same, pointing to our server: /stream?url=...
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

  // --- SEARCH (ytsr) ---
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
        audioUrl: null // No need to fetch audio URL upfront anymore
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