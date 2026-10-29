'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TEACHERS_FILE = path.join(DATA_DIR, 'teachers.json');
const SEED_FILE = path.join(__dirname, 'seed', 'teachers.json');

const MAX_TEXT = 80;
const MAX_NAME = 24;
const LOBBY_IDLE_MS = 6 * 60 * 60 * 1000; // leere Lobbys nach 6h löschen

// ---------------------------------------------------------------------------
// Lehrer (dauerhaft in data/teachers.json gespeichert)
// ---------------------------------------------------------------------------

function loadTeachers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fs.existsSync(TEACHERS_FILE) ? TEACHERS_FILE : SEED_FILE;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

let teachers = loadTeachers();
saveTeachers();

function saveTeachers() {
  const tmp = TEACHERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(teachers, null, 2));
  fs.renameSync(tmp, TEACHERS_FILE);
}

function findTeacher(id) {
  return teachers.find((t) => t.id === id);
}

function clean(text, max = MAX_TEXT) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const newId = () => crypto.randomBytes(6).toString('hex');

// ---------------------------------------------------------------------------
// Lobbys (im Speicher)
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const lobbies = new Map();

function newLobbyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freeCenter(lobby) {
  return lobby.freeCenter && lobby.size % 2 === 1;
}

function fieldsNeeded(lobby) {
  return lobby.size * lobby.size - (freeCenter(lobby) ? 1 : 0);
}

function connectedPlayers(lobby) {
  return [...lobby.players.values()].filter((p) => p.connected);
}

/** Stimmen nötig, um ein Feld zu entfernen: Mehrheit der verbundenen Spieler. */
function votesNeeded(lobby) {
  return Math.floor(connectedPlayers(lobby).length / 2) + 1;
}

function applyVotes(lobby) {
  const needed = votesNeeded(lobby);
  const removed = lobby.fields.filter((f) => f.votes.size >= needed);
  if (removed.length) {
    lobby.fields = lobby.fields.filter((f) => f.votes.size < needed);
  }
  return removed;
}

/** Erzeugt ein Spielfeld: Liste von Feld-IDs (oder null für das freie Feld). */
function makeBoard(lobby) {
  const board = shuffle(lobby.roundFields);
  if (freeCenter(lobby)) board.splice(Math.floor(board.length / 2), 0, null);
  return board;
}

function initialMarks(lobby, board) {
  return new Set(board.map((id, i) => (id === null ? i : -1)).filter((i) => i >= 0));
}

function hasBingo(size, marked) {
  const ok = (i) => marked.has(i);
  for (let r = 0; r < size; r++) {
    if ([...Array(size).keys()].every((c) => ok(r * size + c))) return true;
  }
  for (let c = 0; c < size; c++) {
    if ([...Array(size).keys()].every((r) => ok(r * size + c))) return true;
  }
  if ([...Array(size).keys()].every((i) => ok(i * size + i))) return true;
  if ([...Array(size).keys()].every((i) => ok(i * size + (size - 1 - i)))) return true;
  return false;
}

/** Eigene Felder, die die Abstimmung überstanden haben, dauerhaft beim Lehrer speichern. */
function saveCustomFields(lobby) {
  const teacher = findTeacher(lobby.teacherId);
  if (!teacher) return;
  const known = new Set(teacher.phrases.map((p) => p.toLowerCase()));
  let changed = false;
  for (const f of lobby.fields) {
    if (!f.custom || known.has(f.text.toLowerCase())) continue;
    teacher.phrases.push(f.text);
    known.add(f.text.toLowerCase());
    changed = true;
  }
  if (changed) saveTeachers();
}

function publicLobby(lobby) {
  const counts = {};
  for (const p of lobby.players.values()) {
    if (!p.board) continue;
    for (const i of p.marked) {
      const id = p.board[i];
      if (id) counts[id] = (counts[id] || 0) + 1;
    }
  }
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    teacherId: lobby.teacherId,
    teacherName: findTeacher(lobby.teacherId)?.name ?? 'Unbekannt',
    phase: lobby.phase,
    size: lobby.size,
    freeCenter: lobby.freeCenter,
    fieldsNeeded: fieldsNeeded(lobby),
    votesNeeded: votesNeeded(lobby),
    round: lobby.round,
    fields: lobby.fields.map((f) => ({
      id: f.id,
      text: f.text,
      custom: f.custom,
      author: f.author,
      votes: [...f.votes],
    })),
    fieldText: Object.fromEntries(lobby.allFields),
    markCounts: counts,
    players: [...lobby.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      marks: p.board ? [...p.marked].filter((i) => p.board[i] !== null).length : 0,
      bingo: p.bingo,
    })),
    winners: lobby.winners,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/teachers', (_req, res) => res.json(teachers));

app.post('/api/teachers', (req, res) => {
  const name = clean(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  if (teachers.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Diesen Lehrer gibt es schon' });
  }
  const teacher = { id: newId(), name, phrases: [] };
  teachers.push(teacher);
  saveTeachers();
  res.status(201).json(teacher);
});

app.delete('/api/teachers/:id', (req, res) => {
  const before = teachers.length;
  teachers = teachers.filter((t) => t.id !== req.params.id);
  if (teachers.length === before) return res.status(404).json({ error: 'Nicht gefunden' });
  saveTeachers();
  res.status(204).end();
});

app.post('/api/teachers/:id/phrases', (req, res) => {
  const teacher = findTeacher(req.params.id);
  if (!teacher) return res.status(404).json({ error: 'Nicht gefunden' });
  const text = clean(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Text fehlt' });
  if (teacher.phrases.some((p) => p.toLowerCase() === text.toLowerCase())) {
    return res.status(409).json({ error: 'Gibt es schon' });
  }
  teacher.phrases.push(text);
  saveTeachers();
  res.status(201).json(teacher);
});

app.delete('/api/teachers/:id/phrases/:index', (req, res) => {
  const teacher = findTeacher(req.params.id);
  const index = Number(req.params.index);
  if (!teacher || !(index >= 0 && index < teacher.phrases.length)) {
    return res.status(404).json({ error: 'Nicht gefunden' });
  }
  teacher.phrases.splice(index, 1);
  saveTeachers();
  res.json(teacher);
});

app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);

// ---------------------------------------------------------------------------
// Echtzeit
// ---------------------------------------------------------------------------

function broadcast(lobby) {
  lobby.touched = Date.now();
  io.to(lobby.code).emit('lobby', publicLobby(lobby));
}

function sendBoard(lobby, player) {
  if (!player.socketId) return;
  io.to(player.socketId).emit('board', {
    round: lobby.round,
    board: player.board,
    marked: player.board ? [...player.marked] : [],
  });
}

io.on('connection', (socket) => {
  let lobby = null;
  let player = null;

  const fail = (cb, error) => typeof cb === 'function' && cb({ error });
  const done = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data });
  const isHost = () => lobby && player && lobby.hostId === player.id;

  function join(target, playerId, name) {
    lobby = target;
    player = lobby.players.get(playerId);
    if (player) {
      player.name = name || player.name;
    } else {
      player = { id: playerId, name, board: null, marked: new Set(), bingo: false };
      lobby.players.set(playerId, player);
      if (lobby.phase === 'playing') {
        player.board = makeBoard(lobby);
        player.marked = initialMarks(lobby, player.board);
      }
    }
    player.connected = true;
    player.socketId = socket.id;
    socket.join(lobby.code);
    broadcast(lobby);
    sendBoard(lobby, player);
  }

  function checkPlayerId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
  }

  socket.on('create', (data, cb) => {
    const name = clean(data?.name, MAX_NAME);
    const teacher = findTeacher(data?.teacherId);
    if (!name) return fail(cb, 'Bitte gib einen Namen ein');
    if (!checkPlayerId(data?.playerId)) return fail(cb, 'Ungültige Spieler-ID');
    if (!teacher) return fail(cb, 'Bitte wähle einen Lehrer');
    const size = [3, 4, 5].includes(Number(data?.size)) ? Number(data.size) : 5;

    const fields = teacher.phrases.map((text) => ({
      id: newId(),
      text,
      custom: false,
      author: null,
      votes: new Set(),
    }));
    const code = newLobbyCode();
    const created = {
      code,
      hostId: data.playerId,
      teacherId: teacher.id,
      phase: 'setup',
      size,
      freeCenter: data?.freeCenter !== false,
      fields,
      allFields: new Map(fields.map((f) => [f.id, f.text])),
      roundFields: [],
      round: 0,
      players: new Map(),
      winners: [],
      touched: Date.now(),
    };
    lobbies.set(code, created);
    join(created, data.playerId, name);
    done(cb, { code });
  });

  socket.on('join', (data, cb) => {
    const code = clean(data?.code, 10).toUpperCase();
    const name = clean(data?.name, MAX_NAME);
    const target = lobbies.get(code);
    if (!target) return fail(cb, 'Lobby nicht gefunden');
    if (!name) return fail(cb, 'Bitte gib einen Namen ein');
    if (!checkPlayerId(data?.playerId)) return fail(cb, 'Ungültige Spieler-ID');
    if (lobby && lobby !== target) leave();
    join(target, data.playerId, name);
    done(cb, { code });
  });

  socket.on('addField', (data, cb) => {
    if (!lobby || lobby.phase !== 'setup') return fail(cb, 'Nur vor dem Start möglich');
    const text = clean(data?.text);
    if (!text) return fail(cb, 'Text fehlt');
    if (lobby.fields.some((f) => f.text.toLowerCase() === text.toLowerCase())) {
      return fail(cb, 'Dieses Feld gibt es schon');
    }
    const field = { id: newId(), text, custom: true, author: player.name, votes: new Set() };
    lobby.fields.push(field);
    lobby.allFields.set(field.id, text);
    broadcast(lobby);
    done(cb);
  });

  socket.on('vote', (data, cb) => {
    if (!lobby || lobby.phase !== 'setup') return fail(cb, 'Nur vor dem Start möglich');
    const field = lobby.fields.find((f) => f.id === data?.fieldId);
    if (!field) return fail(cb, 'Feld nicht gefunden');
    if (field.votes.has(player.id)) field.votes.delete(player.id);
    else field.votes.add(player.id);
    applyVotes(lobby);
    broadcast(lobby);
    done(cb);
  });

  socket.on('settings', (data, cb) => {
    if (!isHost()) return fail(cb, 'Nur der Host kann das');
    if (lobby.phase !== 'setup') return fail(cb, 'Nur vor dem Start möglich');
    if ([3, 4, 5].includes(Number(data?.size))) lobby.size = Number(data.size);
    if (typeof data?.freeCenter === 'boolean') lobby.freeCenter = data.freeCenter;
    broadcast(lobby);
    done(cb);
  });

  socket.on('start', (_data, cb) => {
    if (!isHost()) return fail(cb, 'Nur der Host kann starten');
    if (lobby.phase !== 'setup') return fail(cb, 'Läuft bereits');
    const needed = fieldsNeeded(lobby);
    if (lobby.fields.length < needed) {
      return fail(cb, `Es werden mindestens ${needed} Felder gebraucht (aktuell ${lobby.fields.length})`);
    }
    saveCustomFields(lobby);
    // Alle spielen mit denselben Feldern – nur in unterschiedlicher Anordnung.
    lobby.roundFields = shuffle(lobby.fields.map((f) => f.id)).slice(0, needed);
    lobby.phase = 'playing';
    lobby.round += 1;
    lobby.winners = [];
    for (const p of lobby.players.values()) {
      p.board = makeBoard(lobby);
      p.marked = initialMarks(lobby, p.board);
      p.bingo = false;
    }
    broadcast(lobby);
    for (const p of lobby.players.values()) sendBoard(lobby, p);
    done(cb);
  });

  socket.on('mark', (data, cb) => {
    if (!lobby || lobby.phase !== 'playing' || !player.board) return fail(cb, 'Kein laufendes Spiel');
    const index = Number(data?.index);
    if (!Number.isInteger(index) || index < 0 || index >= player.board.length) return fail(cb, 'Ungültig');
    if (player.board[index] === null) return done(cb);
    if (player.marked.has(index)) player.marked.delete(index);
    else player.marked.add(index);

    const bingoNow = hasBingo(lobby.size, player.marked);
    if (bingoNow && !player.bingo) {
      player.bingo = true;
      lobby.winners.push({ id: player.id, name: player.name, at: Date.now() });
      io.to(lobby.code).emit('bingo', { id: player.id, name: player.name, place: lobby.winners.length });
    } else if (!bingoNow && player.bingo) {
      player.bingo = false;
      lobby.winners = lobby.winners.filter((w) => w.id !== player.id);
    }
    broadcast(lobby);
    done(cb, { marked: [...player.marked] });
  });

  socket.on('reset', (_data, cb) => {
    if (!isHost()) return fail(cb, 'Nur der Host kann das');
    lobby.phase = 'setup';
    lobby.winners = [];
    for (const p of lobby.players.values()) {
      p.board = null;
      p.marked = new Set();
      p.bingo = false;
    }
    for (const f of lobby.fields) f.votes.clear();
    broadcast(lobby);
    for (const p of lobby.players.values()) sendBoard(lobby, p);
    done(cb);
  });

  socket.on('kick', (data, cb) => {
    if (!isHost()) return fail(cb, 'Nur der Host kann das');
    const target = lobby.players.get(data?.playerId);
    if (!target || target.id === player.id) return fail(cb, 'Nicht möglich');
    lobby.players.delete(target.id);
    for (const f of lobby.fields) f.votes.delete(target.id);
    if (target.socketId) {
      io.to(target.socketId).emit('kicked');
      io.sockets.sockets.get(target.socketId)?.leave(lobby.code);
    }
    applyVotes(lobby);
    broadcast(lobby);
    done(cb);
  });

  function leave() {
    if (!lobby || !player) return;
    if (player.socketId === socket.id) {
      player.connected = false;
      player.socketId = null;
    }
    socket.leave(lobby.code);
    // Host weitergeben, falls der Host weg ist
    if (lobby.hostId === player.id) {
      const next = connectedPlayers(lobby)[0];
      if (next) lobby.hostId = next.id;
    }
    broadcast(lobby);
    lobby = null;
    player = null;
  }

  socket.on('leave', (_data, cb) => {
    if (lobby && player) {
      const l = lobby;
      const p = player;
      leave();
      l.players.delete(p.id);
      for (const f of l.fields) f.votes.delete(p.id);
      applyVotes(l);
      broadcast(l);
    }
    done(cb);
  });

  socket.on('disconnect', leave);
});

// Alte, leere Lobbys aufräumen
setInterval(() => {
  const now = Date.now();
  for (const [code, lobby] of lobbies) {
    if (connectedPlayers(lobby).length === 0 && now - lobby.touched > LOBBY_IDLE_MS) {
      lobbies.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bingo läuft auf http://localhost:${PORT}`);
    // Adressen anzeigen, unter denen andere im WLAN/LAN mitspielen können
    for (const addrs of Object.values(require('os').networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`Im Netzwerk:  http://${a.address}:${PORT}`);
      }
    }
  });
}

module.exports = { server, hasBingo };
