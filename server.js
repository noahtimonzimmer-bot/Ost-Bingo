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
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');

const MAX_TEXT = 80;
const MAX_NAME = 24;
const LOBBY_IDLE_MS = 6 * 60 * 60 * 1000; // leere Lobbys nach 6h löschen
const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** So viele Stimmen löschen ein Feld dauerhaft beim Lehrer – egal ob gesperrt. */
const DELETE_VOTES = Number(process.env.DELETE_VOTES) || 5;

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

const newId = () => crypto.randomBytes(6).toString('hex');

// Früher waren Felder einfache Texte – in Objekte umwandeln. Alles ist anfangs gesperrt.
let teachers = loadTeachers().map((t) => ({
  ...t,
  phrases: t.phrases.map((p) => (typeof p === 'string' ? { id: newId(), text: p, locked: true } : p)),
}));
saveTeachers();

function saveTeachers() {
  writeJson(TEACHERS_FILE, teachers);
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// All-Time-Bestenliste (dauerhaft in data/leaderboard.json, nach Name)
// ---------------------------------------------------------------------------

/** Punkte je Platzierung; jedes weitere Bingo zählt 1 Punkt. */
const PLACE_POINTS = [5, 3, 2];
const pointsFor = (place) => PLACE_POINTS[place - 1] ?? 1;

let leaderboard = {};
try {
  leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
} catch {
  leaderboard = {};
}

function statsFor(name) {
  const key = name.toLowerCase();
  leaderboard[key] ??= { name, points: 0, wins: 0, bingos: 0, rounds: 0 };
  leaderboard[key].name = name;
  return leaderboard[key];
}

function recordRound(name) {
  statsFor(name).rounds += 1;
  writeJson(LEADERBOARD_FILE, leaderboard);
}

/** sign = +1 bei Bingo, -1 wenn das Bingo wieder weggeklickt wurde */
function recordBingo(name, place, sign) {
  const s = statsFor(name);
  s.bingos = Math.max(0, s.bingos + sign);
  s.points = Math.max(0, s.points + sign * pointsFor(place));
  if (place === 1) s.wins = Math.max(0, s.wins + sign);
  writeJson(LEADERBOARD_FILE, leaderboard);
}

function rankedLeaderboard() {
  return Object.values(leaderboard)
    .filter((s) => s.rounds > 0 || s.bingos > 0)
    .sort((a, b) => b.points - a.points || b.wins - a.wins || b.bingos - a.bingos || a.rounds - b.rounds);
}

function findTeacher(id) {
  return teachers.find((t) => t.id === id);
}

function clean(text, max = MAX_TEXT) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function newPhrase(text, addedBy) {
  return { id: newId(), text, locked: true, addedBy: addedBy || null, addedAt: new Date().toISOString(), deleteVotes: [] };
}

/**
 * Lehrer für die Ausgabe: Stimmen nur als Anzahl (Spieler-IDs bleiben geheim),
 * wer etwas hinzugefügt hat, sieht nur der Admin.
 */
function teacherView(teacher, { playerId, admin }) {
  return {
    id: teacher.id,
    name: teacher.name,
    phrases: teacher.phrases.map((p) => ({
      id: p.id,
      text: p.text,
      locked: p.locked,
      votes: p.deleteVotes?.length ?? 0,
      voted: !!playerId && !!p.deleteVotes?.includes(playerId),
      votesNeeded: DELETE_VOTES,
      ...(admin ? { addedBy: p.addedBy ?? null, addedAt: p.addedAt ?? null } : {}),
    })),
  };
}

function findPhrase(teacher, phraseId) {
  return teacher?.phrases.find((p) => p.id === phraseId);
}

// ---------------------------------------------------------------------------
// Admin & gesperrte Wörter (data/settings.json)
// ---------------------------------------------------------------------------

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  settings = {};
}
settings.bannedWords ??= [];
if (!process.env.ADMIN_PASSWORD && !settings.adminPassword) {
  settings.adminPassword = crypto.randomBytes(6).toString('base64url');
}
writeJson(SETTINGS_FILE, settings);

const adminPassword = () => process.env.ADMIN_PASSWORD || settings.adminPassword;

/** token -> Ablaufzeit */
const adminSessions = new Map();

function checkPassword(given) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(adminPassword()).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAdminToken(token) {
  const expires = typeof token === 'string' && adminSessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

/** Liefert das gesperrte Wort, falls der Text eines enthält. */
function bannedWordIn(text) {
  const lower = String(text).toLowerCase();
  return settings.bannedWords.find((w) => lower.includes(w.toLowerCase()));
}

const bannedMessage = 'Enthält ein gesperrtes Wort';

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

/** Gesperrte Felder können nicht rausgewählt werden. Lehrer-Felder folgen live dem Lehrer. */
function isLocked(lobby, field) {
  if (field.phraseId) return !!findPhrase(findTeacher(lobby.teacherId), field.phraseId)?.locked;
  return !!field.locked;
}

function applyVotes(lobby) {
  const needed = votesNeeded(lobby);
  const out = (f) => f.votes.size >= needed && !isLocked(lobby, f);
  const removed = lobby.fields.filter(out);
  if (removed.length) {
    lobby.fields = lobby.fields.filter((f) => !out(f));
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
  const known = new Set(teacher.phrases.map((p) => p.text.toLowerCase()));
  let changed = false;
  for (const f of lobby.fields) {
    if (!f.custom || known.has(f.text.toLowerCase())) continue;
    const phrase = newPhrase(f.text, f.author);
    teacher.phrases.push(phrase);
    known.add(f.text.toLowerCase());
    // ab jetzt ist es ein normales Lehrer-Feld
    f.custom = false;
    f.phraseId = phrase.id;
    changed = true;
  }
  if (changed) saveTeachers();
}

function publicLobby(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    teacherId: lobby.teacherId,
    teacherName: findTeacher(lobby.teacherId)?.name ?? 'Unbekannt',
    phase: lobby.phase,
    size: lobby.size,
    freeCenter: lobby.freeCenter,
    public: lobby.public,
    fieldsNeeded: fieldsNeeded(lobby),
    votesNeeded: votesNeeded(lobby),
    round: lobby.round,
    fields: lobby.fields.map((f) => ({
      id: f.id,
      text: f.text,
      custom: f.custom,
      author: f.author,
      locked: isLocked(lobby, f),
      votes: [...f.votes],
    })),
    fieldText: Object.fromEntries(lobby.allFields),
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
// hinter Caddy/nginx auf demselben Rechner die echte Absender-IP verwenden
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function adminToken(req) {
  return req.get('x-admin-token');
}

function requireAdmin(req, res, next) {
  if (isAdminToken(adminToken(req))) return next();
  res.status(403).json({ error: 'Nur für Admins' });
}

let lastFailedLogin = 0;
app.post('/api/admin/login', (req, res) => {
  // einfache Bremse gegen Durchprobieren
  if (Date.now() - lastFailedLogin < 1000) return res.status(429).json({ error: 'Kurz warten …' });
  if (!checkPassword(req.body?.password)) {
    lastFailedLogin = Date.now();
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
  adminSessions.delete(adminToken(req));
  res.status(204).end();
});

app.get('/api/admin/me', (req, res) => res.json({ admin: isAdminToken(adminToken(req)) }));

app.get('/api/banned', requireAdmin, (_req, res) => res.json(settings.bannedWords));

app.post('/api/banned', requireAdmin, (req, res) => {
  const word = clean(req.body?.word, 40);
  if (!word) return res.status(400).json({ error: 'Wort fehlt' });
  if (!settings.bannedWords.some((w) => w.toLowerCase() === word.toLowerCase())) {
    settings.bannedWords.push(word);
    writeJson(SETTINGS_FILE, settings);
  }
  res.status(201).json(settings.bannedWords);
});

app.delete('/api/banned/:word', requireAdmin, (req, res) => {
  settings.bannedWords = settings.bannedWords.filter((w) => w !== req.params.word);
  writeJson(SETTINGS_FILE, settings);
  res.json(settings.bannedWords);
});

function viewer(req) {
  return { playerId: req.get('x-player-id'), admin: isAdminToken(adminToken(req)) };
}

app.get('/api/teachers', (req, res) => res.json(teachers.map((t) => teacherView(t, viewer(req)))));

app.post('/api/teachers', (req, res) => {
  const name = clean(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  if (bannedWordIn(name)) return res.status(400).json({ error: bannedMessage });
  if (teachers.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Diesen Lehrer gibt es schon' });
  }
  const teacher = { id: newId(), name, phrases: [] };
  teachers.push(teacher);
  saveTeachers();
  res.status(201).json(teacherView(teacher, viewer(req)));
});

app.delete('/api/teachers/:id', requireAdmin, (req, res) => {
  const before = teachers.length;
  teachers = teachers.filter((t) => t.id !== req.params.id);
  if (teachers.length === before) return res.status(404).json({ error: 'Nicht gefunden' });
  saveTeachers();
  res.status(204).end();
});

// Begriffe hinzufügen darf immer jeder.
app.post('/api/teachers/:id/phrases', (req, res) => {
  const teacher = findTeacher(req.params.id);
  if (!teacher) return res.status(404).json({ error: 'Nicht gefunden' });
  const text = clean(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Text fehlt' });
  if (bannedWordIn(text)) return res.status(400).json({ error: bannedMessage });
  if (teacher.phrases.some((p) => p.text.toLowerCase() === text.toLowerCase())) {
    return res.status(409).json({ error: 'Gibt es schon' });
  }
  teacher.phrases.push(newPhrase(text, clean(req.body?.name, MAX_NAME)));
  saveTeachers();
  res.status(201).json(teacherView(teacher, viewer(req)));
});

// Abstimmen, ob ein Feld beim Lehrer dauerhaft verschwindet – darf jeder, auch bei gesperrten Feldern.
app.post('/api/teachers/:id/phrases/:pid/vote', (req, res) => {
  const teacher = findTeacher(req.params.id);
  const phrase = findPhrase(teacher, req.params.pid);
  const { playerId } = viewer(req);
  if (!phrase) return res.status(404).json({ error: 'Nicht gefunden' });
  if (typeof playerId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(playerId)) {
    return res.status(400).json({ error: 'Ungültige Spieler-ID' });
  }
  phrase.deleteVotes ??= [];
  if (phrase.deleteVotes.includes(playerId)) {
    phrase.deleteVotes = phrase.deleteVotes.filter((id) => id !== playerId);
  } else {
    phrase.deleteVotes.push(playerId);
  }
  const deleted = phrase.deleteVotes.length >= DELETE_VOTES;
  if (deleted) teacher.phrases = teacher.phrases.filter((p) => p !== phrase);
  saveTeachers();
  res.json({ deleted, teacher: teacherView(teacher, viewer(req)) });
});

/** Lobbys mit diesem Lehrer neu senden, damit Schlösser sofort überall stimmen. */
function refreshLobbies(teacherId) {
  for (const lobby of lobbies.values()) {
    if (lobby.teacherId !== teacherId) continue;
    for (const f of lobby.fields) if (isLocked(lobby, f)) f.votes.clear();
    broadcast(lobby);
  }
}

app.patch('/api/teachers/:id/phrases/:pid', requireAdmin, (req, res) => {
  const teacher = findTeacher(req.params.id);
  const phrase = findPhrase(teacher, req.params.pid);
  if (!phrase) return res.status(404).json({ error: 'Nicht gefunden' });
  if (typeof req.body?.locked === 'boolean') phrase.locked = req.body.locked;
  saveTeachers();
  refreshLobbies(teacher.id);
  res.json(teacherView(teacher, viewer(req)));
});

app.post('/api/teachers/:id/lock', requireAdmin, (req, res) => {
  const teacher = findTeacher(req.params.id);
  if (!teacher) return res.status(404).json({ error: 'Nicht gefunden' });
  const locked = req.body?.locked !== false;
  for (const p of teacher.phrases) p.locked = locked;
  saveTeachers();
  refreshLobbies(teacher.id);
  res.json(teacherView(teacher, viewer(req)));
});

app.delete('/api/teachers/:id/phrases/:pid', requireAdmin, (req, res) => {
  const teacher = findTeacher(req.params.id);
  if (!findPhrase(teacher, req.params.pid)) return res.status(404).json({ error: 'Nicht gefunden' });
  teacher.phrases = teacher.phrases.filter((p) => p.id !== req.params.pid);
  saveTeachers();
  res.json(teacherView(teacher, viewer(req)));
});

app.get('/api/leaderboard', (_req, res) => res.json(rankedLeaderboard()));

app.get('/api/lobbies', (_req, res) => res.json(openLobbies()));

// ---------------------------------------------------------------------------
// Feedback: jeder kann senden, nur der Admin liest (data/feedback.json)
// ---------------------------------------------------------------------------

let feedback = [];
try {
  feedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
} catch {
  feedback = [];
}
const saveFeedback = () => writeJson(FEEDBACK_FILE, feedback);

// höchstens 5 Nachrichten pro Absender in 10 Minuten
const FEEDBACK_LIMIT = 5;
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const feedbackSent = new Map();

app.post('/api/feedback', (req, res) => {
  const text = String(req.body?.text ?? '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Nachricht fehlt' });
  const sender = req.ip;
  const now = Date.now();
  const recent = (feedbackSent.get(sender) || []).filter((t) => now - t < FEEDBACK_WINDOW_MS);
  if (recent.length >= FEEDBACK_LIMIT) {
    return res.status(429).json({ error: 'Zu viele Nachrichten – bitte später nochmal' });
  }
  feedbackSent.set(sender, [...recent, now]);
  feedback.unshift({
    id: newId(),
    text,
    name: clean(req.body?.name, MAX_NAME) || null,
    at: new Date().toISOString(),
    read: false,
  });
  saveFeedback();
  res.status(201).json({ ok: true });
});

app.get('/api/feedback', requireAdmin, (_req, res) => res.json(feedback));

app.patch('/api/feedback/:id', requireAdmin, (req, res) => {
  const item = feedback.find((f) => f.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Nicht gefunden' });
  if (typeof req.body?.read === 'boolean') item.read = req.body.read;
  saveFeedback();
  res.json(feedback);
});

app.delete('/api/feedback/:id', requireAdmin, (req, res) => {
  feedback = feedback.filter((f) => f.id !== req.params.id);
  saveFeedback();
  res.json(feedback);
});

app.delete('/api/leaderboard/:name', requireAdmin, (req, res) => {
  delete leaderboard[req.params.name.toLowerCase()];
  writeJson(LEADERBOARD_FILE, leaderboard);
  res.json(rankedLeaderboard());
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
  announceLobbies();
}

/** Öffentliche Lobbys mit mindestens einem verbundenen Spieler – für die Startseite. */
function openLobbies() {
  return [...lobbies.values()]
    .filter((l) => l.public && connectedPlayers(l).length > 0)
    .map((l) => ({
      code: l.code,
      teacherName: findTeacher(l.teacherId)?.name ?? 'Unbekannt',
      hostName: l.players.get(l.hostId)?.name ?? '',
      players: connectedPlayers(l).length,
      phase: l.phase,
      round: l.round,
      size: l.size,
    }))
    .sort((a, b) => b.players - a.players);
}

// Liste an alle schicken, aber höchstens zweimal pro Sekunde
let announceTimer = null;
function announceLobbies() {
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announceTimer = null;
    io.emit('lobbies', openLobbies());
  }, 500);
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
        recordRound(player.name);
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
    if (bannedWordIn(name)) return fail(cb, 'Dein Name ' + bannedMessage.toLowerCase());
    if (!checkPlayerId(data?.playerId)) return fail(cb, 'Ungültige Spieler-ID');
    if (!teacher) return fail(cb, 'Bitte wähle einen Lehrer');
    const size = [3, 4, 5].includes(Number(data?.size)) ? Number(data.size) : 5;

    const fields = teacher.phrases.map((p) => ({
      id: newId(),
      text: p.text,
      phraseId: p.id,
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
      public: data?.public === true,
      fields,
      allFields: new Map(fields.map((f) => [f.id, f.text])),
      roundFields: [],
      recorded: new Map(),
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
    if (bannedWordIn(name)) return fail(cb, 'Dein Name ' + bannedMessage.toLowerCase());
    if (!checkPlayerId(data?.playerId)) return fail(cb, 'Ungültige Spieler-ID');
    if (lobby && lobby !== target) leave();
    join(target, data.playerId, name);
    done(cb, { code });
  });

  socket.on('addField', (data, cb) => {
    if (!lobby || lobby.phase !== 'setup') return fail(cb, 'Nur vor dem Start möglich');
    const text = clean(data?.text);
    if (!text) return fail(cb, 'Text fehlt');
    if (bannedWordIn(text)) return fail(cb, bannedMessage);
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
    if (isLocked(lobby, field)) return fail(cb, 'Dieses Feld ist gesperrt');
    if (field.votes.has(player.id)) field.votes.delete(player.id);
    else field.votes.add(player.id);
    applyVotes(lobby);
    broadcast(lobby);
    done(cb);
  });

  // Admin: Feld in der Lobby sperren/entsperren oder direkt entfernen
  socket.on('adminField', (data, cb) => {
    if (!isAdminToken(data?.token)) return fail(cb, 'Nur für Admins');
    if (!lobby || lobby.phase !== 'setup') return fail(cb, 'Nur vor dem Start möglich');
    const field = lobby.fields.find((f) => f.id === data?.fieldId);
    if (!field) return fail(cb, 'Feld nicht gefunden');
    if (data.action === 'remove') {
      lobby.fields = lobby.fields.filter((f) => f !== field);
      broadcast(lobby);
      return done(cb);
    }
    const locked = !isLocked(lobby, field);
    const phrase = field.phraseId && findPhrase(findTeacher(lobby.teacherId), field.phraseId);
    if (phrase) {
      // Lehrer-Feld: gilt dauerhaft und für alle Lobbys dieses Lehrers
      phrase.locked = locked;
      saveTeachers();
      refreshLobbies(lobby.teacherId);
    } else {
      field.locked = locked;
      if (locked) field.votes.clear();
      broadcast(lobby);
    }
    done(cb);
  });

  socket.on('settings', (data, cb) => {
    if (!isHost()) return fail(cb, 'Nur der Host kann das');
    if (lobby.phase !== 'setup') return fail(cb, 'Nur vor dem Start möglich');
    if ([3, 4, 5].includes(Number(data?.size))) lobby.size = Number(data.size);
    if (typeof data?.freeCenter === 'boolean') lobby.freeCenter = data.freeCenter;
    if (typeof data?.public === 'boolean') lobby.public = data.public;
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
    lobby.recorded = new Map();
    for (const p of lobby.players.values()) {
      p.board = makeBoard(lobby);
      p.marked = initialMarks(lobby, p.board);
      p.bingo = false;
      recordRound(p.name);
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
      const place = lobby.winners.length;
      lobby.recorded.set(player.id, { name: player.name, place });
      recordBingo(player.name, place, +1);
      io.to(lobby.code).emit('bingo', { id: player.id, name: player.name, place });
    } else if (!bingoNow && player.bingo) {
      player.bingo = false;
      lobby.winners = lobby.winners.filter((w) => w.id !== player.id);
      const rec = lobby.recorded.get(player.id);
      if (rec) recordBingo(rec.name, rec.place, -1);
      lobby.recorded.delete(player.id);
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
      announceLobbies();
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
    console.log(
      process.env.ADMIN_PASSWORD
        ? 'Admin-Passwort: aus ADMIN_PASSWORD'
        : `Admin-Passwort: ${settings.adminPassword}  (ändern in ${SETTINGS_FILE} oder per ADMIN_PASSWORD)`
    );
  });
}

module.exports = { server, hasBingo };
