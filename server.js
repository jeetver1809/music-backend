const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');

const app = express();
app.use(cors());

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

  // --- HELPER: Play Next Song ---
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

      console.log(`▶️ Playing Next: ${nextSong.title}`);

      io.to(roomCode).emit('play_song', { 
        url: nextSong.audioUrl,
        title: nextSong.title,
        thumbnail: nextSong.thumbnail
      });
      io.to(roomCode).emit('queue_updated', room.queue);
    } else {
      console.log("⚠️ Queue empty.");
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
    
    // Add User
    const newUser = { id: socket.id, name: username || `User ${socket.id.substr(0,4)}` };
    // Avoid duplicates
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

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const index = room.users.findIndex(user => user.id === socket.id);
      if (index !== -1) {
        room.users.splice(index, 1);
        io.to(roomCode).emit('update_users', room.users);
        break;
      }
    }
  });

  socket.on('search_query', async (query) => {
    console.log(`🔎 Searching: "${query}"`);
    try {
      const output = await youtubedl(query, {
        dumpSingleJson: true,
        defaultSearch: 'ytsearch5',
        noWarnings: true,
        flatPlaylist: true, 
      });
      
      const entries = output.entries || [];
      if (entries.length > 0) {
        const results = entries.map(entry => ({
          title: entry.title,
          id: entry.id,
          url: `https://www.youtube.com/watch?v=${entry.id}`,
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
        }));
        socket.emit('search_results', results);
      } else {
        socket.emit('song_error', "No songs found.");
      }
    } catch (e) {
      console.error("Search Failed:", e.message);
      socket.emit('song_error', "Search failed.");
    }
  });

  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    // --- CRASH FIX: Check if room exists, if not, recreate it ---
    if (!rooms[roomCode]) {
        console.log(`⚠️ Room ${roomCode} not found (server restarted?). Re-creating...`);
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

      // Play immediately if idle
      if (!room.isPlaying && !room.currentSongUrl) {
          playNext(roomCode);
      }
    } else {
      socket.emit('song_error', 'Could not load song.');
    }
  });

  socket.on('skip_track', (roomCode) => {
      const room = rooms[roomCode];
      // Safety check
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

server.listen(3001, () => {
  console.log('🚀 SERVER RUNNING ON PORT 3001');
});