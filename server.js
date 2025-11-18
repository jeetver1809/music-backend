const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ytsr = require('ytsr'); 

const app = express();
app.use(cors());

app.get('/', (req, res) => {
  res.send('Music Jam Server is Online! 🚀');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

async function getAudioLink(youtubeUrl) {
  try {
    console.log(`🎧 Fetching link for: ${youtubeUrl}`);
    const output = await youtubedl(youtubeUrl, {
      getUrl: true,
      format: 'bestaudio[ext=m4a]',
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
    });
    return output.trim();
  } catch (err) {
    console.error("❌ Link Fetch Error:", err.message);
    return null;
  }
}

io.on('connection', (socket) => {
  console.log(`⚡ User Connected: ${socket.id}`);

  const playNext = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.queue.length > 0) {
      const nextSong = room.queue.shift(); 
      room.currentSongUrl = nextSong.audioUrl;
      room.currentTitle = nextSong.title;
      room.currentThumbnail = nextSong.thumbnail;
      room.isPlaying = true;
      room.timestamp = 0;
      room.lastUpdate = Date.now();

      io.to(roomCode).emit('play_song', { 
        url: nextSong.audioUrl,
        title: nextSong.title,
        thumbnail: nextSong.thumbnail
      });
      io.to(roomCode).emit('queue_updated', room.queue);
    } else {
      room.isPlaying = false;
    }
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
    
    if (!room.users.find(u => u.id === socket.id)) {
        room.users.push(newUser);
    }

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

  // --- MEMORY FIX: CLEANUP USERS & ROOMS ---
  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const index = room.users.findIndex(user => user.id === socket.id);
      
      if (index !== -1) {
        console.log(`👋 ${room.users[index].name} left ${roomCode}`);
        room.users.splice(index, 1);
        io.to(roomCode).emit('update_users', room.users);
        
        // ✅ FIX: Delete room if empty to free up RAM
        if (room.users.length === 0) {
            console.log(`🗑️ Deleting empty room: ${roomCode}`);
            delete rooms[roomCode];
        }
        break;
      }
    }
  });

  // --- MEMORY FIX: LIGHTWEIGHT SEARCH ---
  socket.on('search_query', async (query) => {
    console.log(`🔎 Searching: "${query}"`);
    try {
      // ✅ FIX: Fetch 15 items directly (No getFilters call = 50% less RAM)
      const searchResults = await ytsr(query, { limit: 15 });
      
      // Filter for videos only in memory
      const results = searchResults.items
        .filter(item => item.type === 'video')
        .slice(0, 5) // Take top 5
        .map(item => ({
          title: item.title,
          id: item.id,
          url: item.url,
          thumbnail: item.bestThumbnail.url
        }));

      console.log(`✅ Found ${results.length} results`);
      socket.emit('search_results', results);
      
    } catch (e) {
      console.error("Search Error:", e.message);
      socket.emit('song_error', "Search failed. Try again.");
    }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    if (!rooms[roomCode]) {
        // Auto-recreate room if missing
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

    const streamUrl = await getAudioLink(youtubeUrl);
    
    if (streamUrl && streamUrl.startsWith('http')) {
      const room = rooms[roomCode];
      room.queue.push({
          title: title || "Unknown Track",
          thumbnail: thumbnail || "",
          audioUrl: streamUrl,
          originalUrl: youtubeUrl
      });
      io.to(roomCode).emit('queue_updated', room.queue);

      if (!room.isPlaying && !room.currentSongUrl) {
          playNext(roomCode);
      }
    } else {
      socket.emit('song_error', 'Could not load song.');
    }
  });

  socket.on('skip_track', (roomCode) => {
      const room = rooms[roomCode];
      if (room && room.queue.length > 0) {
         playNext(roomCode);
      }
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
});