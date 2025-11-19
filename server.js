const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ytsr = require('ytsr');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

// ✅ Health Check Endpoint for Render
app.get('/', (req, res) => {
  res.send('Music Jam Server is Online! 🚀');
});

// ✅ Debug Endpoint
app.get('/debug', (req, res) => {
  const roomCodes = Object.keys(rooms);
  const roomStats = roomCodes.map(code => ({
    code,
    users: rooms[code].users.length,
    queueLength: rooms[code].queue.length,
    isPlaying: rooms[code].isPlaying,
    currentTitle: rooms[code].currentTitle
  }));
  res.json({ totalRooms: roomCodes.length, rooms: roomStats });
});

/**
 * Fetch audio stream URL from YouTube
 * @param {string} youtubeUrl - YouTube URL or video ID
 * @returns {Promise<string|null>} - Direct audio stream URL or null
 */
async function getAudioLink(youtubeUrl) {
  try {
    console.log(`🎧 Fetching audio link for: ${youtubeUrl}`);

    // Normalize input: if it's an ID, build full URL
    let url = youtubeUrl;
    if (!/^https?:\/\//i.test(youtubeUrl)) {
      url = `https://www.youtube.com/watch?v=${youtubeUrl}`;
    }

    if (!ytdl.validateURL(url)) {
      console.warn(`⚠️ Invalid YouTube URL: ${url}`);
      return null;
    }

    const info = await ytdl.getInfo(url);
    console.log(`ℹ️ Video title: ${info.videoDetails?.title}`);

    // Prefer audio-only formats with HLS or direct URL
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    if (!audioFormats || audioFormats.length === 0) {
      console.warn('⚠️ No audio-only formats found');
      return null;
    }

    // Prefer m4a/mp4, then anything else
    const preferred =
      audioFormats.find(f => (f.mimeType || '').includes('audio/mp4')) ||
      audioFormats.find(f => (f.mimeType || '').includes('audio/webm')) ||
      audioFormats[0];

    if (!preferred || !preferred.url) {
      console.warn('⚠️ No usable audio format URL found');
      return null;
    }

    const link = preferred.url;
    console.log(`✅ Got audio link: ${link.substring(0, 80)}...`);
    return link;
  } catch (err) {
    console.error('❌ Link Fetch Error:', err);
    return null;
  }
}

/**
 * Play the next song in the queue
 * @param {string} roomCode - Room identifier
 */
function playNext(roomCode) {
  const room = rooms[roomCode];
  if (!room) {
    console.warn(`⚠️ Room ${roomCode} not found`);
    return;
  }

  if (room.queue.length === 0) {
    console.log(`⚠️ Queue empty in ${roomCode}`);
    room.isPlaying = false;
    room.currentSongUrl = null;
    room.currentTitle = "No Song Playing";
    room.currentThumbnail = null;
    io.to(roomCode).emit('play_song', { 
      url: null, 
      title: "Queue Empty", 
      thumbnail: null 
    });
    return;
  }

  const nextSong = room.queue.shift();
  room.currentSongUrl = nextSong.audioUrl;
  room.currentTitle = nextSong.title;
  room.currentThumbnail = nextSong.thumbnail;
  room.isPlaying = true;
  room.timestamp = 0;
  room.lastUpdate = Date.now();

  console.log(`▶️ Now Playing: ${nextSong.title}`);

  io.to(roomCode).emit('play_song', {
    url: nextSong.audioUrl,
    title: nextSong.title,
    thumbnail: nextSong.thumbnail
  });
  io.to(roomCode).emit('queue_updated', room.queue);
}

/**
 * Initialize a new room
 * @param {string} roomCode - Room identifier
 */
function initializeRoom(roomCode) {
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
    console.log(`🏠 Room created: ${roomCode}`);
  }
}

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
  console.log(`⚡ User Connected: ${socket.id}`);

  // ========== JOIN ROOM ==========
  socket.on('join_room', ({ roomCode, username }) => {
    try {
      if (!roomCode) {
        console.warn(`⚠️ No room code provided by ${socket.id}`);
        socket.emit('song_error', 'Room code is required');
        return;
      }

      socket.join(roomCode);
      initializeRoom(roomCode);

      const room = rooms[roomCode];
      const newUser = {
        id: socket.id,
        name: username || `User ${socket.id.substring(0, 4)}`
      };

      // Avoid duplicate users
      if (!room.users.find(u => u.id === socket.id)) {
        room.users.push(newUser);
      }

      console.log(`👤 ${newUser.name} joined ${roomCode} (${room.users.length} users)`);
      io.to(roomCode).emit('update_users', room.users);

      // Calculate adjusted time for sync
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
    } catch (err) {
      console.error('❌ join_room error:', err.message);
      socket.emit('song_error', 'Failed to join room');
    }
  });

  // ========== DISCONNECT ==========
  socket.on('disconnect', () => {
    try {
      console.log(`👋 User Disconnected: ${socket.id}`);
      
      for (const roomCode in rooms) {
        const room = rooms[roomCode];
        const userIndex = room.users.findIndex(u => u.id === socket.id);
        
        if (userIndex !== -1) {
          const userName = room.users[userIndex].name;
          room.users.splice(userIndex, 1);
          console.log(`👤 ${userName} left ${roomCode} (${room.users.length} users remaining)`);
          
          io.to(roomCode).emit('update_users', room.users);

          // Clean up empty rooms
          if (room.users.length === 0) {
            delete rooms[roomCode];
            console.log(`🗑️ Room ${roomCode} deleted (empty)`);
          }
          break;
        }
      }
    } catch (err) {
      console.error('❌ disconnect error:', err.message);
    }
  });

  // ========== SEARCH QUERY ==========
  socket.on('search_query', async (query) => {
    try {
      if (!query || query.trim().length === 0) {
        socket.emit('search_results', []);
        return;
      }

      console.log(`🔎 Searching: "${query}"`);
      const search = await ytsr(query, { limit: 10 });
      const entries = search.items.filter(item => item.type === 'video').slice(0, 5);
      if (entries.length > 0) {
        const results = entries.map(item => ({
          title: item.title || 'Unknown',
          id: item.id,
          url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
          thumbnail: (item.bestThumbnail && item.bestThumbnail.url) ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`
        }));
        console.log(`✅ Found ${results.length} results`);
        socket.emit('search_results', results);
      } else {
        console.log(`⚠️ No results for "${query}"`);
        socket.emit('search_results', []);
      }
    } catch (err) {
      console.error('❌ search_query error:', err.message);
      socket.emit('song_error', `Search failed: ${err.message}`);
    }
  });

  // ========== REQUEST SONG ==========
  socket.on('request_song', async ({ roomCode, youtubeUrl, title, thumbnail }) => {
    try {
      if (!roomCode || !youtubeUrl) {
        socket.emit('song_error', 'Room code and URL are required');
        return;
      }

      initializeRoom(roomCode);
      const room = rooms[roomCode];

      console.log(`📥 Adding to queue: ${title || youtubeUrl}`);
      const streamUrl = await getAudioLink(youtubeUrl);

      if (!streamUrl || !streamUrl.startsWith('http')) {
        console.warn(`⚠️ Failed to get stream URL for ${youtubeUrl}`);
        socket.emit('song_error', 'Could not get playable link for this song');
        return;
      }

      room.queue.push({
        title: title || "Unknown Track",
        thumbnail: thumbnail || "",
        audioUrl: streamUrl,
        originalUrl: youtubeUrl
      });

      console.log(`✅ Song added to queue (${room.queue.length} in queue)`);
      io.to(roomCode).emit('queue_updated', room.queue);

      // Auto-play if nothing is playing
      if (!room.isPlaying && !room.currentSongUrl) {
        playNext(roomCode);
      }
    } catch (err) {
      console.error('❌ request_song error:', err.message);
      socket.emit('song_error', `Failed to add song: ${err.message}`);
    }
  });

  // ========== SKIP TRACK ==========
  socket.on('skip_track', (roomCode) => {
    try {
      if (!roomCode) {
        socket.emit('song_error', 'Room code is required');
        return;
      }

      if (!rooms[roomCode]) {
        socket.emit('song_error', 'Room not found');
        return;
      }

      console.log(`⏭️ Skipping track in ${roomCode}`);
      playNext(roomCode);
    } catch (err) {
      console.error('❌ skip_track error:', err.message);
      socket.emit('song_error', 'Failed to skip track');
    }
  });

  // ========== PAUSE TRACK ==========
  socket.on('pause_track', ({ roomCode, timestamp }) => {
    try {
      if (!roomCode || rooms[roomCode] === undefined) {
        return;
      }

      const room = rooms[roomCode];
      room.isPlaying = false;
      room.timestamp = timestamp || 0;
      room.lastUpdate = Date.now();

      console.log(`⏸️ Paused at ${timestamp}s in ${roomCode}`);
      socket.to(roomCode).emit('receive_pause', timestamp);
    } catch (err) {
      console.error('❌ pause_track error:', err.message);
    }
  });

  // ========== PLAY TRACK ==========
  socket.on('play_track', ({ roomCode, timestamp }) => {
    try {
      if (!roomCode || rooms[roomCode] === undefined) {
        return;
      }

      const room = rooms[roomCode];
      room.isPlaying = true;
      room.timestamp = timestamp || 0;
      room.lastUpdate = Date.now();

      console.log(`▶️ Playing from ${timestamp}s in ${roomCode}`);
      socket.to(roomCode).emit('receive_play', timestamp);
    } catch (err) {
      console.error('❌ play_track error:', err.message);
    }
  });

  // ========== SEEK TRACK ==========
  socket.on('seek_track', ({ roomCode, timestamp }) => {
    try {
      if (!roomCode || rooms[roomCode] === undefined) {
        return;
      }

      const room = rooms[roomCode];
      room.timestamp = timestamp || 0;
      room.lastUpdate = Date.now();

      console.log(`⏩ Seeked to ${timestamp}s in ${roomCode}`);
      io.to(roomCode).emit('receive_seek', timestamp);
    } catch (err) {
      console.error('❌ seek_track error:', err.message);
    }
  });
});

// ==================== SERVER STARTUP ====================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🎵 Music Jam Server Started! 🎵     ║
║   Port: ${PORT}                          ║
║   Status: Ready for connections        ║
╚════════════════════════════════════════╝
  `);
});

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGTERM', () => {
  console.log('📛 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📛 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// ==================== ERROR HANDLING ====================

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
