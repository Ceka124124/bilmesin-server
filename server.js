const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] }, maxHttpBufferSize: 30e6 });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

['uploads','uploads/music','uploads/images','uploads/videos'].forEach(d => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const mkStorage = (dest) => multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, dest)),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});

app.post('/api/upload/image', multer({ storage: mkStorage('uploads/images'), limits: { fileSize: 10e6 } }).single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/images/' + req.file.filename });
});

app.post('/api/upload/music', multer({ storage: mkStorage('uploads/music'), limits: { fileSize: 60e6 } }).single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const entry = {
    id: 'm_' + Date.now(), title: req.body.title || req.file.originalname.replace(/\.[^.]+$/,''),
    artist: req.body.artist || 'Naməlum', uploadedBy: req.body.uploadedBy || '',
    url: '/uploads/music/' + req.file.filename, size: req.file.size, createdAt: Date.now()
  };
  const idx = path.join(__dirname, 'uploads/music/index.json');
  let list = []; try { if (fs.existsSync(idx)) list = JSON.parse(fs.readFileSync(idx)); } catch(e){}
  list.unshift(entry); fs.writeFileSync(idx, JSON.stringify(list));
  res.json(entry);
});

app.post('/api/upload/file', multer({ storage: mkStorage('uploads'), limits: { fileSize: 20e6 } }).single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

app.get('/api/music/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const idx = path.join(__dirname, 'uploads/music/index.json');
  let list = []; try { if (fs.existsSync(idx)) list = JSON.parse(fs.readFileSync(idx)); } catch(e){}
  res.json(q ? list.filter(m => m.title.toLowerCase().includes(q) || m.artist.toLowerCase().includes(q)) : list.slice(0,100));
});

app.get('/api/music/list', (req, res) => {
  const idx = path.join(__dirname, 'uploads/music/index.json');
  let list = []; try { if (fs.existsSync(idx)) list = JSON.parse(fs.readFileSync(idx)); } catch(e){}
  res.json(list.slice(0,100));
});

app.get('/', (req, res) => res.send('AEB Server v2.0'));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const userSockets = {}, socketUsers = {}, roomState = {};

io.on('connection', (socket) => {
  socket.on('register', ({ userId }) => {
    userSockets[userId] = socket.id; socketUsers[socket.id] = userId; socket.userId = userId;
  });

  socket.on('room:join', ({ roomId, userId }) => {
    socket.join('room:' + roomId);
    if (!roomState[roomId]) roomState[roomId] = { seats:{}, locked:{}, muted:{}, currentMusic:null };
    socket.emit('room:full_state', { roomId, state: roomState[roomId] });
    socket.to('room:' + roomId).emit('room:user_joined', { userId });
    io.to('room:' + roomId).emit('room:online_count', { count: io.sockets.adapter.rooms.get('room:'+roomId)?.size||0 });
  });

  socket.on('room:leave', ({ roomId, userId }) => {
    socket.leave('room:' + roomId);
    if (roomState[roomId]) {
      Object.keys(roomState[roomId].seats).forEach(k => { if (roomState[roomId].seats[k]===userId) delete roomState[roomId].seats[k]; });
      io.to('room:'+roomId).emit('room:full_state', { roomId, state: roomState[roomId] });
    }
    socket.to('room:'+roomId).emit('room:user_left', { userId });
    io.to('room:'+roomId).emit('room:online_count', { count: io.sockets.adapter.rooms.get('room:'+roomId)?.size||0 });
  });

  socket.on('room:take_seat', ({ roomId, userId, seatIndex }) => {
    if (!roomState[roomId]) roomState[roomId] = { seats:{}, locked:{}, muted:{}, currentMusic:null };
    const rs = roomState[roomId];
    if (rs.locked[seatIndex]) return;
    Object.keys(rs.seats).forEach(k=>{ if(rs.seats[k]===userId) delete rs.seats[k]; });
    rs.seats[seatIndex] = userId;
    io.to('room:'+roomId).emit('room:full_state', { roomId, state: rs });
  });

  socket.on('room:leave_seat', ({ roomId, userId }) => {
    if (!roomState[roomId]) return;
    const rs = roomState[roomId];
    Object.keys(rs.seats).forEach(k=>{ if(rs.seats[k]===userId) delete rs.seats[k]; });
    io.to('room:'+roomId).emit('room:full_state', { roomId, state: rs });
  });

  socket.on('room:kick_seat', ({ roomId, seatIndex }) => {
    if (!roomState[roomId]) return;
    const target = roomState[roomId].seats[seatIndex];
    if (target) {
      delete roomState[roomId].seats[seatIndex];
      io.to('room:'+roomId).emit('room:full_state', { roomId, state: roomState[roomId] });
      const ts = userSockets[target]; if(ts) io.to(ts).emit('room:kicked', { roomId });
    }
  });

  socket.on('room:mute', ({ roomId, targetUserId, muted }) => {
    if (!roomState[roomId]) return;
    roomState[roomId].muted[targetUserId] = muted;
    io.to('room:'+roomId).emit('room:mute_update', { targetUserId, muted });
    const ts = userSockets[targetUserId]; if(ts) io.to(ts).emit('room:force_mute', { muted });
  });

  socket.on('room:lock_seat', ({ roomId, seatIndex, locked }) => {
    if (!roomState[roomId]) roomState[roomId] = { seats:{}, locked:{}, muted:{}, currentMusic:null };
    roomState[roomId].locked[seatIndex] = locked;
    io.to('room:'+roomId).emit('room:full_state', { roomId, state: roomState[roomId] });
  });

  socket.on('room:chat', ({ roomId, data }) => { io.to('room:'+roomId).emit('room:chat', data); });
  socket.on('room:gift', ({ roomId, data }) => { io.to('room:'+roomId).emit('room:gift', data); });

  socket.on('room:music_play', ({ roomId, music }) => {
    if (!roomState[roomId]) roomState[roomId] = { seats:{}, locked:{}, muted:{}, currentMusic:null };
    roomState[roomId].currentMusic = music;
    io.to('room:'+roomId).emit('room:music_play', { music });
  });
  socket.on('room:music_stop', ({ roomId }) => {
    if(roomState[roomId]) roomState[roomId].currentMusic = null;
    io.to('room:'+roomId).emit('room:music_stop');
  });

  // WebRTC room
  socket.on('rtc:offer', ({ to, from, offer, roomId }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('rtc:offer',{from,offer,roomId}); });
  socket.on('rtc:answer', ({ to, from, answer }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('rtc:answer',{from,answer}); });
  socket.on('rtc:ice', ({ to, from, candidate }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('rtc:ice',{from,candidate}); });

  // Video/Voice call
  socket.on('call:invite', ({ to, from, type, nick, avatar }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:invite',{from,type,nick,avatar}); });
  socket.on('call:accept', ({ to, from }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:accepted',{from}); });
  socket.on('call:reject', ({ to, from }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:rejected',{from}); });
  socket.on('call:end', ({ to }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:ended'); });
  socket.on('call:offer', ({ to, from, offer, type }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:offer',{from,offer,type}); });
  socket.on('call:answer', ({ to, from, answer }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:answer',{from,answer}); });
  socket.on('call:ice', ({ to, from, candidate }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('call:ice',{from,candidate}); });

  // Chat
  socket.on('chat:msg', ({ to, data }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('chat:msg',data); });
  socket.on('chat:typing', ({ to, from }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('chat:typing',{from}); });

  // Social
  socket.on('friend:req', ({ to, from, nick }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('friend:req',{from,nick}); });
  socket.on('icon:send', ({ to, from, iconType, nick }) => { const ts=userSockets[to]; if(ts) io.to(ts).emit('icon:recv',{from,iconType,nick}); });
  socket.on('admin:broadcast', ({ message }) => { io.emit('sys:notify',{message,ts:Date.now()}); });

  socket.on('disconnect', () => {
    const userId = socketUsers[socket.id];
    if (userId) {
      delete userSockets[userId]; delete socketUsers[socket.id];
      Object.keys(roomState).forEach(rid => {
        const rs = roomState[rid]; if(!rs) return;
        let chg=false; Object.keys(rs.seats).forEach(k=>{ if(rs.seats[k]===userId){delete rs.seats[k];chg=true;} });
        if(chg) io.to('room:'+rid).emit('room:full_state',{roomId:rid,state:rs});
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('AEB Server v2 port', PORT));
