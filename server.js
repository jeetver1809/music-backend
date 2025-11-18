const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ytsr = require('ytsr'); 

const app = express();

// Allow CORS for everything
app.use(cors({ origin: "*" }));

app.get('/', (req, res) => res.send('Music Jam Server Online! 🚀'));

// --- ROBUST STREAMING ENDPOINT ---
app.get('/stream', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('No URL provided');

    console.log(`🔄 Processing: ${videoUrl}`);

    try {
        // 1. Manual CORS Headers (Fixes OpaqueResponseBlocking)
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'audio/mp4');

        // 2. Get Video Info with Mobile User Agent
        // "ANDROID" client is less likely to be throttled on cloud servers
        const agent = ytdl.createAgent([{ name: "cookie", value: "" }]); 
        
        const info = await ytdl.getInfo(videoUrl, { 
            agent,
            playerClients: ["ANDROID", "WEB"] 
        });
        
        // 3. Choose best audio format
        const format = ytdl.chooseFormat(info.formats, { 
            quality: 'highestaudio',
            filter: 'audioonly' 
        });

        if (!format) {
            return res.status(500).send('No audio format found');
        }

        console.log(`🎵 Streaming format: ${format.container} / ${format.hasAudio ? 'Audio OK' : 'No Audio'}`);

        // 4. Start the Stream
        const audioStream = ytdl.downloadFromInfo(info, { 
            format: format,
            dlChunkSize: 0, // Disable chunking for smoother http piping
        });
        
        audioStream.pipe(res);

        audioStream.on('error', (err) => {
            console.error('Stream interrupted:', err.message);
            if (!res.headersSent) res.status(500).send('Stream error');
        });

    } catch (e) {
        console.error('Proxy Failed:', e.message);
        if (!res.headersSent) {
             res.status(500).send(`Server Error: ${e.message}`);
        }
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