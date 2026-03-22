const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');

// ════════════════════════════════
//  FIREBASE ADMIN (optional)
// ════════════════════════════════
let firebaseReady = false;
try {
  const admin = require('firebase-admin');
  const sa    = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  if (sa) {
    admin.initializeApp({
      credential:  admin.credential.cert(sa),
      databaseURL: 'https://prstars-fb9b5-default-rtdb.firebaseio.com',
    });
    firebaseReady = true;
    console.log('[Firebase] Admin SDK bağlandı');
  } else {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT yoxdur — yalnız socket işləyir');
  }
} catch (e) {
  console.warn('[Firebase] Yüklənmədi:', e.message);
}

// ════════════════════════════════
//  APP SETUP
// ════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:          { origin: '*', methods: ['GET','POST','DELETE'] },
  transports:    ['websocket','polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ════════════════════════════════
//  UPLOAD DIRS
// ════════════════════════════════
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MUSIC_DIR  = path.join(UPLOAD_DIR, 'music');
const IMAGE_DIR  = path.join(UPLOAD_DIR, 'images');
[UPLOAD_DIR, MUSIC_DIR, IMAGE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, req.params.type === 'music' ? MUSIC_DIR : IMAGE_DIR);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = Date.now() + '_' + Math.random().toString(36).slice(2) + ext;
    cb(null, name);
  },
});
const ALLOWED_MIME = {
  image: ['image/jpeg','image/png','image/gif','image/webp'],
  music: ['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav',
          'audio/flac','audio/x-m4a','audio/m4a'],
};
const upload = multer({
  storage,
  limits: { fileSize: 65 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = req.params.type || 'image';
    const list = ALLOWED_MIME[type] || ALLOWED_MIME.image;
    if (list.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Destəklənməyən fayl növü: ' + file.mimetype));
  },
});

// ════════════════════════════════
//  IN-MEMORY STATE
// ════════════════════════════════
const socketUsers  = new Map(); // socketId  → userId
const userSockets  = new Map(); // userId    → socketId
const roomMembers  = new Map(); // roomId    → Set<userId>
const roomOnline   = new Map(); // roomId    → Set<userId>
const roomVideoSt  = new Map(); // roomId    → videoState obj

let musicCache     = null;
let musicCacheTime = 0;
const CACHE_TTL    = 60_000;

// ════════════════════════════════
//  HELPERS
// ════════════════════════════════
function getSet(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}
function getUserSocket(userId) {
  const sid = userSockets.get(userId);
  return sid ? io.sockets.sockets.get(sid) : null;
}
function emitToUser(userId, event, data) {
  const sock = getUserSocket(userId);
  if (sock) sock.emit(event, data);
}
function readMusicList() {
  const now = Date.now();
  if (musicCache && now - musicCacheTime < CACHE_TTL) return musicCache;
  try {
    const files = fs.readdirSync(MUSIC_DIR)
      .filter(f => /\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(f));
    musicCache = files.map(f => {
      const metaFile = path.join(MUSIC_DIR, f + '.json');
      if (fs.existsSync(metaFile)) {
        try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch(_) {}
      }
      const stat = fs.statSync(path.join(MUSIC_DIR, f));
      return {
        id:     f,
        title:  f.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
        artist: 'Bilinməyən',
        url:    `/uploads/music/${f}`,
        size:   stat.size,
        ts:     stat.mtimeMs,
      };
    }).sort((a, b) => b.ts - a.ts);
    musicCacheTime = now;
    return musicCache;
  } catch(_) { return []; }
}

// ════════════════════════════════
//  REST — Health
// ════════════════════════════════
app.get('/',       (_, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ════════════════════════════════
//  REST — Upload
// ════════════════════════════════
app.post('/api/upload/:type', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Fayl yoxdur' });

    const type = req.params.type;
    const url  = `/uploads/${type === 'music' ? 'music' : 'images'}/${req.file.filename}`;

    if (type === 'music') {
      const meta = {
        id:         req.file.filename,
        title:      req.body.title  || req.file.originalname.replace(/\.[^.]+$/, ''),
        artist:     req.body.artist || 'Bilinməyən',
        uploadedBy: req.body.uploadedBy || 'unknown',
        url,
        size: req.file.size,
        ts:   Date.now(),
      };
      try { fs.writeFileSync(path.join(MUSIC_DIR, req.file.filename + '.json'), JSON.stringify(meta)); } catch(_) {}
      musicCache = null;
      return res.json(meta);
    }
    res.json({ url, filename: req.file.filename });
  });
});

// ════════════════════════════════
//  REST — Music
// ════════════════════════════════
app.get('/api/music/list', (_, res) => {
  res.json(readMusicList());
});

app.get('/api/music/search', (req, res) => {
  const q    = (req.query.q || '').toLowerCase().trim();
  const list = readMusicList();
  if (!q) return res.json(list);
  res.json(list.filter(m =>
    m.title.toLowerCase().includes(q) ||
    (m.artist || '').toLowerCase().includes(q)
  ));
});

app.delete('/api/music/:id', (req, res) => {
  const id       = req.params.id;
  const filePath = path.join(MUSIC_DIR, id);
  const metaPath = filePath + '.json';
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  musicCache = null;
  res.json({ ok: true });
});

// ════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ─── Register ───
  socket.on('register', ({ userId }) => {
    if (!userId) return;
    socketUsers.set(socket.id, userId);
    userSockets.set(userId, socket.id);
  });

  // ─── Room: join ───
  socket.on('room:join', ({ roomId, userId, nick, avatarUrl, vip }) => {
    if (!roomId || !userId) return;
    socket.join(roomId);
    socketUsers.set(socket.id, userId);
    userSockets.set(userId, socket.id);

    getSet(roomMembers, roomId).add(userId);
    getSet(roomOnline,  roomId).add(userId);

    const count = getSet(roomOnline, roomId).size;
    io.to(roomId).emit('room:online_count', { count });
    socket.to(roomId).emit('room:user_joined', { userId, nick, avatarUrl, vip });

    // Video state sync for newcomer
    const vs = roomVideoSt.get(roomId);
    if (vs && !vs.stopped) socket.emit('room:video_state', vs);

    console.log(`[Join] ${nick || userId} → ${roomId} (${count})`);
  });

  // ─── Room: leave ───
  socket.on('room:leave', ({ roomId, userId, nick, avatarUrl }) => {
    if (!roomId) return;
    socket.leave(roomId);
    _removeFromRoom(roomId, userId);
    const count = getSet(roomOnline, roomId).size;
    io.to(roomId).emit('room:online_count', { count });
    socket.to(roomId).emit('room:user_left', { userId, nick, avatarUrl });
    console.log(`[Leave] ${nick || userId} ← ${roomId} (${count})`);
  });

  socket.on('room:leave_seat', ({ roomId, userId, seatIndex }) => {
    if (roomId) socket.to(roomId).emit('room:seat_left', { userId, seatIndex });
  });

  socket.on('room:take_seat', ({ roomId, userId, seatIndex }) => {
    if (roomId) socket.to(roomId).emit('room:seat_taken', { userId, seatIndex });
  });

  socket.on('room:add_seat', ({ roomId, seatCount }) => {
    if (roomId) io.to(roomId).emit('room:seat_count', { seatCount });
  });

  socket.on('room:kick_seat', ({ roomId, seatIndex }) => {
    if (roomId) io.to(roomId).emit('room:seat_kicked', { seatIndex });
  });

  socket.on('room:lock_seat', ({ roomId, seatIndex, locked }) => {
    if (roomId) io.to(roomId).emit('room:seat_locked', { seatIndex, locked });
  });

  socket.on('room:mute', ({ roomId, targetUserId, muted }) => {
    emitToUser(targetUserId, 'room:force_mute', { muted });
    if (roomId) io.to(roomId).emit('room:muted_update', { userId: targetUserId, muted });
  });

  socket.on('room:kick', ({ roomId, targetUserId }) => {
    emitToUser(targetUserId, 'room:kicked', { roomId });
    if (roomId) io.to(roomId).emit('room:user_kicked', { userId: targetUserId });
  });

  // ─── Chat ───
  socket.on('room:chat', ({ roomId, data }) => {
    if (!roomId || !data) return;
    socket.to(roomId).emit('room:chat', data);
  });

  // ─── Gift ───
  socket.on('room:gift', ({ roomId, gift, from, fromNick }) => {
    if (!roomId) return;
    io.to(roomId).emit('room:gift', { gift, from, fromNick });
  });

  // ─── Music ───
  socket.on('room:music_play', ({ roomId, music }) => {
    if (roomId && music) socket.to(roomId).emit('room:music_play', { music });
  });
  socket.on('room:music_stop', ({ roomId }) => {
    if (roomId) socket.to(roomId).emit('room:music_stop', {});
  });

  // ─── Video ───
  socket.on('room:video_state', ({ roomId, videoId, startAt, title, stopped }) => {
    if (!roomId) return;
    const state = { roomId, videoId, startAt, title, stopped: !!stopped };
    roomVideoSt.set(roomId, state);
    socket.to(roomId).emit('room:video_state', state);
  });

  // ─── Karaoke ───
  socket.on('karaoke:vol_update', ({ roomId, musicVol }) => {
    if (roomId) socket.to(roomId).emit('karaoke:vol_update', { musicVol });
  });
  socket.on('karaoke:state_update', ({ roomId, state }) => {
    if (roomId) socket.to(roomId).emit('karaoke:state_update', { state });
  });
  socket.on('karaoke:next', ({ roomId }) => {
    if (roomId) io.to(roomId).emit('karaoke:next', {});
  });

  // ─── VIP ───
  socket.on('vip:up', ({ nick, vip, roomId }) => {
    const target = roomId ? io.to(roomId) : socket.broadcast;
    target.emit('vip:up', { nick, vip });
  });

  // ─── DM ───
  socket.on('dm:send', ({ to, from, fromNick, text }) => {
    if (to && text) emitToUser(to, 'dm:receive', { from, fromNick, text });
  });

  // ─── Friends / Icons ───
  socket.on('friend:req', ({ to, from, nick }) => {
    if (to) emitToUser(to, 'friend:req', { from, nick });
  });
  socket.on('icon:send', ({ to, from, iconType, nick }) => {
    if (to) emitToUser(to, 'icon:receive', { from, iconType, nick });
  });

  // ─── Sys notify (admin broadcast) ───
  socket.on('sys:notify', ({ roomId, message }) => {
    if (!message) return;
    if (roomId) io.to(roomId).emit('sys:notify', { message });
    else        io.emit('sys:notify', { message });
  });

  // ─── WebRTC signaling ───
  socket.on('rtc:offer',  ({ to, from, offer, roomId })  => emitToUser(to, 'rtc:offer',  { from, offer, roomId }));
  socket.on('rtc:answer', ({ to, from, answer })         => emitToUser(to, 'rtc:answer', { from, answer }));
  socket.on('rtc:ice',    ({ to, from, candidate })      => emitToUser(to, 'rtc:ice',    { from, candidate }));

  // ─── Disconnect ───
  socket.on('disconnect', reason => {
    const userId = socketUsers.get(socket.id);
    socketUsers.delete(socket.id);
    if (userId && userSockets.get(userId) === socket.id) {
      userSockets.delete(userId);
      // Tüm odalarda temizle
      roomMembers.forEach((members, roomId) => {
        if (!members.has(userId)) return;
        _removeFromRoom(roomId, userId);
        const count = getSet(roomOnline, roomId).size;
        io.to(roomId).emit('room:online_count', { count });
        io.to(roomId).emit('room:user_left', { userId, nick: userId, avatarUrl: '' });
      });
    }
    console.log(`[-] ${socket.id} (${userId || '?'}) — ${reason}`);
  });

  socket.on('error', err => console.error(`[Err] ${socket.id}:`, err.message));
});

// ════════════════════════════════
//  INTERNAL HELPERS
// ════════════════════════════════
function _removeFromRoom(roomId, userId) {
  if (!userId) return;
  getSet(roomMembers, roomId).delete(userId);
  getSet(roomOnline,  roomId).delete(userId);
}

// ════════════════════════════════
//  ERROR HANDLERS
// ════════════════════════════════
app.use((err, req, res, _next) => {
  console.error('[Express]', err.message);
  res.status(500).json({ error: err.message });
});
process.on('uncaughtException',   err => console.error('[Uncaught]',  err.message));
process.on('unhandledRejection',  err => console.error('[Rejection]', err?.message || err));

// ════════════════════════════════
//  START
// ════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  Bilmesin Server — port ${PORT}`);
  console.log(`    Uploads : ${UPLOAD_DIR}`);
  console.log(`    Firebase: ${firebaseReady ? '✅' : '⚠️  yoxdur'}\n`);
});
