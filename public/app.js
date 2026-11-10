'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function getPlayerId() {
  let id = store('bingo.playerId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store('bingo.playerId', id);
  }
  return id;
}

const playerId = getPlayerId();
const socket = io();

let teachers = [];
let lobby = null;
let adminToken = store('bingo.adminToken');
let isAdmin = false;
let board = null; // { round, board: [fieldId|null], marked: [index] }

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function emit(event, data = {}) {
  return new Promise((resolve) => {
    socket.emit(event, data, (res) => {
      if (res?.error) toast(res.error);
      resolve(res || {});
    });
  });
}

async function api(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  headers['x-player-id'] = playerId;
  if (adminToken) headers['x-admin-token'] = adminToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && adminToken) setAdmin(null); // Admin-Sitzung abgelaufen
  if (!res.ok) {
    toast(data.error || 'Fehler');
    return null;
  }
  return data;
}

let currentView = 'home';
function show(view) {
  currentView = view;
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  // Warnung nur dort, wo man Felder schreibt, die andere sehen
  $('#rules-banner').hidden = !['setup', 'teachers'].includes(view);
  $$('[data-goto]').forEach((b) => b.classList.toggle('active', b.dataset.goto === view));
}

function myName() {
  const name = $('#name').value.trim();
  if (!name) {
    toast('Bitte gib zuerst deinen Namen ein');
    $('#name').focus();
  }
  return name;
}

// ---------------------------------------------------------------------------
// Navigation & Startseite
// ---------------------------------------------------------------------------

$$('[data-goto]').forEach((b) =>
  b.addEventListener('click', () => {
    if (lobby && b.dataset.goto === 'home') return render(true);
    if (b.dataset.goto === 'teachers') loadTeachers();
    if (b.dataset.goto === 'leaderboard') loadLeaderboard();
    if (b.dataset.goto === 'admin') renderAdmin();
    show(b.dataset.goto);
  })
);

$('#name').value = store('bingo.name') || '';
$('#name').addEventListener('input', (e) => store('bingo.name', e.target.value.trim()));

const params = new URLSearchParams(location.search);
if (params.get('lobby')) $('#join-code').value = params.get('lobby').toUpperCase();

$('#btn-create').addEventListener('click', async () => {
  const name = myName();
  if (!name) return;
  const res = await emit('create', {
    name,
    playerId,
    teacherId: $('#create-teacher').value,
    size: Number($('#create-size').value),
    freeCenter: $('#create-free').checked,
    public: document.querySelector('[name=create-visibility]:checked').value === 'public',
  });
  if (res.ok) enteredLobby(res.code);
});

$('#btn-join').addEventListener('click', joinFromForm);
$('#join-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinFromForm());

async function joinFromForm() {
  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) return toast('Bitte gib einen Lobby-Code ein');
  joinLobby(code);
}

async function joinLobby(code) {
  const name = myName();
  if (!name) return;
  const res = await emit('join', { name, playerId, code });
  if (res.ok) enteredLobby(res.code);
}

function renderOpenLobbies(list) {
  $('#open-count').textContent = list.length;
  $('#open-empty').hidden = list.length > 0;
  $('#open-lobbies').replaceChildren(
    ...list.map((l) =>
      el(
        'li',
        {},
        el('div', { class: 'text' },
          el('b', {}, l.teacherName),
          el('span', { class: 'muted' },
            ` · ${l.size}×${l.size} · ${l.players} Spieler · Host: ${l.hostName}`),
          el('div', { class: 'muted' }, l.phase === 'playing' ? `🎲 läuft – Runde ${l.round}` : '⏳ sammelt Felder')
        ),
        el('button', { class: 'primary', onclick: () => joinLobby(l.code) }, 'Beitreten')
      )
    )
  );
}

socket.on('lobbies', renderOpenLobbies);
api('GET', '/api/lobbies').then((list) => list && renderOpenLobbies(list));

function enteredLobby(code) {
  store('bingo.lobby', code);
  history.replaceState(null, '', '?lobby=' + code);
}

function leftLobby() {
  store('bingo.lobby', null);
  lobby = null;
  board = null;
  history.replaceState(null, '', '/');
  loadTeachers(); // neue Felder aus der Runde sind jetzt beim Lehrer
  show('home');
}

$$('.leave').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!confirm('Lobby wirklich verlassen?')) return;
    await emit('leave');
    leftLobby();
  })
);

// ---------------------------------------------------------------------------
// Bestenliste
// ---------------------------------------------------------------------------

async function loadLeaderboard() {
  const rows = (await api('GET', '/api/leaderboard')) || [];
  const me = ($('#name').value.trim() || '').toLowerCase();
  $('#leaderboard-body').replaceChildren(
    ...rows.map((s, i) =>
      el(
        'tr',
        { class: s.name.toLowerCase() === me ? 'me' : '' },
        el('td', {}, (s.points > 0 && ['🥇', '🥈', '🥉'][i]) || i + 1),
        el('td', {}, s.name),
        el('td', { class: 'num' }, s.points),
        el('td', { class: 'num' }, s.wins),
        el('td', { class: 'num' }, s.bingos),
        el('td', { class: 'num' }, s.rounds),
        isAdmin
          ? el('td', {}, el('button', {
              class: 'small danger',
              title: 'Eintrag löschen (Admin)',
              onclick: async () => {
                if (!confirm(`${s.name} aus der Bestenliste löschen?`)) return;
                if (await api('DELETE', `/api/leaderboard/${encodeURIComponent(s.name)}`)) loadLeaderboard();
              },
            }, '✕'))
          : null
      )
    )
  );
  $('#leaderboard-empty').hidden = rows.length > 0;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function setAdmin(token) {
  adminToken = token;
  store('bingo.adminToken', token);
  isAdmin = !!token;
  document.body.classList.toggle('is-admin', isAdmin);
  $('#nav-admin').textContent = isAdmin ? '🛡️ Admin' : 'Admin';
  renderAdmin();
  renderTeachers();
  if (lobby) render();
  if (currentView === 'leaderboard') loadLeaderboard();
}

async function checkAdmin() {
  if (!adminToken) return setAdmin(null);
  const res = await api('GET', '/api/admin/me');
  setAdmin(res?.admin ? adminToken : null);
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api('POST', '/api/admin/login', { password: $('#admin-password').value });
  if (res?.token) {
    $('#admin-password').value = '';
    setAdmin(res.token);
    toast('Als Admin angemeldet');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout');
  setAdmin(null);
});

$('#form-banned').addEventListener('submit', async (e) => {
  e.preventDefault();
  const word = $('#banned-word').value.trim();
  if (!word) return;
  if (await api('POST', '/api/banned', { word })) {
    $('#banned-word').value = '';
    renderAdmin();
  }
});

$('#form-feedback').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#feedback-text').value.trim();
  if (!text) return;
  const name = $('#feedback-anon').checked ? '' : $('#name').value.trim();
  if (await api('POST', '/api/feedback', { text, name })) {
    $('#feedback-text').value = '';
    toast('Danke! Dein Feedback ist beim Admin angekommen.');
  }
});

function renderInbox(items) {
  const unread = items.filter((f) => !f.read).length;
  $('#inbox-count').textContent = unread ? `${unread} neu` : items.length;
  $('#nav-admin').textContent = '🛡️ Admin' + (unread ? ` (${unread})` : '');
  $('#inbox-empty').hidden = items.length > 0;
  $('#inbox').replaceChildren(
    ...items.map((f) =>
      el(
        'li',
        { class: f.read ? 'read' : 'unread' },
        el('div', { class: 'inbox-meta muted' },
          `${f.name || 'Anonym'} · ${new Date(f.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`),
        el('div', { class: 'inbox-text' }, f.text),
        el('div', { class: 'head-actions' },
          el('button', {
            class: 'small',
            onclick: async () => {
              const res = await api('PATCH', `/api/feedback/${f.id}`, { read: !f.read });
              if (res) renderInbox(res);
            },
          }, f.read ? 'Als ungelesen markieren' : '✓ Gelesen'),
          el('button', {
            class: 'small danger',
            onclick: async () => {
              if (!confirm('Feedback löschen?')) return;
              const res = await api('DELETE', `/api/feedback/${f.id}`);
              if (res) renderInbox(res);
            },
          }, 'Löschen'))
      )
    )
  );
}

async function renderAdmin() {
  $('#admin-login').hidden = isAdmin;
  $('#admin-panel').hidden = !isAdmin;
  if (!isAdmin) return;
  renderInbox((await api('GET', '/api/feedback')) || []);
  const words = (await api('GET', '/api/banned')) || [];
  $('#banned-list').replaceChildren(
    ...words.map((w) =>
      el('li', {}, el('span', { class: 'text' }, w), el('button', {
        class: 'small',
        title: 'Wieder erlauben',
        onclick: async () => (await api('DELETE', `/api/banned/${encodeURIComponent(w)}`)) && renderAdmin(),
      }, '✕'))
    )
  );
  if (!words.length) $('#banned-list').append(el('li', { class: 'muted' }, 'Keine gesperrten Wörter.'));
}

// ---------------------------------------------------------------------------
// Lehrer verwalten
// ---------------------------------------------------------------------------

async function loadTeachers() {
  teachers = (await api('GET', '/api/teachers')) || [];
  const select = $('#create-teacher');
  const prev = select.value || store('bingo.teacher');
  select.replaceChildren(
    ...teachers.map((t) => el('option', { value: t.id }, `${t.name} (${t.phrases.length} Felder)`))
  );
  if (teachers.some((t) => t.id === prev)) select.value = prev;
  renderTeachers();
}

$('#create-teacher').addEventListener('change', (e) => store('bingo.teacher', e.target.value));

function renderTeachers() {
  const list = $('#teacher-list');
  if (!teachers.length) {
    list.replaceChildren(el('div', { class: 'card muted' }, 'Noch keine Lehrer angelegt.'));
    return;
  }
  list.replaceChildren(
    ...teachers.map((t) => {
      const input = el('input', { maxlength: 80, placeholder: 'Neues Standard-Feld, z. B. „Sagt sozusagen“' });
      return el(
        'div',
        { class: 'card teacher' },
        el(
          'div',
          { class: 'teacher-head' },
          el('h2', {}, t.name, el('span', { class: 'badge' }, t.phrases.length)),
          isAdmin
            ? el('div', { class: 'head-actions' },
                el('button', {
                  class: 'small',
                  onclick: async () => (await api('POST', `/api/teachers/${t.id}/lock`, { locked: true })) && loadTeachers(),
                }, '🔒 Alle sperren'),
                el('button', {
                  class: 'small',
                  onclick: async () => (await api('POST', `/api/teachers/${t.id}/lock`, { locked: false })) && loadTeachers(),
                }, '🔓 Alle entsperren'),
                el('button', {
                  class: 'small danger',
                  onclick: async () => {
                    if (!confirm(`„${t.name}“ mit allen Feldern löschen?`)) return;
                    if (await api('DELETE', `/api/teachers/${t.id}`)) loadTeachers();
                  },
                }, 'Lehrer löschen'))
            : null
        ),
        el(
          'ul',
          { class: 'phrases' },
          t.phrases.map((p) =>
            el('li', {},
              el('span', { class: 'text' },
                el('span', { class: 'lock', title: p.locked ? 'Gesperrt: kann in der Lobby nicht rausgewählt werden' : 'Kann in der Lobby rausgewählt werden' }, p.locked ? '🔒' : '🔓'),
                ' ', p.text,
                isAdmin && p.addedBy
                  ? el('span', { class: 'author' }, `von ${p.addedBy}${p.addedAt ? ', ' + new Date(p.addedAt).toLocaleDateString('de-DE') : ''}`)
                  : null),
              el('button', {
                class: 'small vote' + (p.voted ? ' on' : ''),
                title: p.voted
                  ? 'Stimme zurückziehen'
                  : `Für dauerhaftes Löschen stimmen – bei ${p.votesNeeded} Stimmen ist das Feld weg`,
                onclick: async () => {
                  const res = await api('POST', `/api/teachers/${t.id}/phrases/${p.id}/vote`);
                  if (res?.deleted) toast(`„${p.text}“ wurde per Abstimmung gelöscht`);
                  if (res) loadTeachers();
                },
              }, `👎 ${p.votes}/${p.votesNeeded}`),
              isAdmin
                ? el('span', { class: 'head-actions' },
                    el('button', {
                      class: 'small',
                      title: p.locked ? 'Entsperren' : 'Sperren',
                      onclick: async () =>
                        (await api('PATCH', `/api/teachers/${t.id}/phrases/${p.id}`, { locked: !p.locked })) && loadTeachers(),
                    }, p.locked ? 'Entsperren' : 'Sperren'),
                    el('button', {
                      class: 'small danger',
                      title: 'Löschen',
                      onclick: async () => (await api('DELETE', `/api/teachers/${t.id}/phrases/${p.id}`)) && loadTeachers(),
                    }, '✕'))
                : null
            )
          )
        ),
        el(
          'form',
          {
            class: 'row',
            onsubmit: async (e) => {
              e.preventDefault();
              const text = input.value.trim();
              if (!text) return;
              if (await api('POST', `/api/teachers/${t.id}/phrases`, { text, name: $('#name').value.trim() })) {
                await loadTeachers();
                $$('#teacher-list .teacher input')[teachers.findIndex((x) => x.id === t.id)]?.focus();
              }
            },
          },
          input,
          el('button', { class: 'primary' }, 'Hinzufügen')
        )
      );
    })
  );
}

$('#form-teacher').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#teacher-name').value.trim();
  if (!name) return;
  if (await api('POST', '/api/teachers', { name })) {
    $('#teacher-name').value = '';
    loadTeachers();
  }
});

// ---------------------------------------------------------------------------
// Lobby: Felder & Abstimmung
// ---------------------------------------------------------------------------

$('#form-field').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#field-text').value.trim();
  if (!text) return;
  const res = await emit('addField', { text });
  if (res.ok) $('#field-text').value = '';
});

$('#set-size').addEventListener('change', (e) => emit('settings', { size: Number(e.target.value) }));
$('#set-free').addEventListener('change', (e) => emit('settings', { freeCenter: e.target.checked }));
$('#set-public').addEventListener('change', (e) => emit('settings', { public: e.target.checked }));
$('#btn-start').addEventListener('click', () => emit('start'));
$('#btn-reset').addEventListener('click', () => {
  if (confirm('Neue Runde starten? Alle Felder werden zurückgesetzt.')) emit('reset');
});

$('#btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}/?lobby=${lobby.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link kopiert!');
  } catch {
    prompt('Link zum Teilen:', link);
  }
});

function renderPlayers(target) {
  const isHost = lobby.hostId === playerId;
  target.replaceChildren(
    ...lobby.players.map((p) =>
      el(
        'li',
        { class: p.connected ? '' : 'offline' },
        el('span', {},
          p.id === lobby.hostId ? '👑 ' : '',
          p.name,
          p.id === playerId ? ' (du)' : '',
          p.bingo ? ' 🎉' : ''
        ),
        el('span', {},
          lobby.phase === 'playing' ? el('span', { class: 'muted' }, `${p.marks} ✓ `) : null,
          isHost && p.id !== playerId
            ? el('button', {
                class: 'small',
                title: 'Rauswerfen',
                onclick: () => confirm(`${p.name} rauswerfen?`) && emit('kick', { playerId: p.id }),
              }, '✕')
            : null
        )
      )
    )
  );
}

function renderSetup() {
  const isHost = lobby.hostId === playerId;
  $('#setup-code').textContent = lobby.code;
  $('#setup-teacher').textContent = 'Lehrer: ' + lobby.teacherName;
  $('#setup-visibility').textContent = lobby.public
    ? '🌍 Öffentlich – steht auf der Startseite'
    : '🔑 Privat – nur mit Code';
  $('#field-count').textContent = lobby.fields.length;
  $('#votes-needed').textContent = lobby.votesNeeded;

  $('#field-list').replaceChildren(
    ...lobby.fields.map((f) => {
      const mine = f.votes.includes(playerId);
      return el(
        'li',
        {},
        el('span', { class: 'text' },
          f.text,
          f.custom ? el('span', { class: 'author' }, `eigenes Feld von ${f.author}`) : null
        ),
        isAdmin
          ? el('button', {
              class: 'small',
              title: f.locked ? 'Entsperren (Admin)' : 'Sperren (Admin)',
              onclick: () => emit('adminField', { token: adminToken, fieldId: f.id, action: 'lock' }),
            }, f.locked ? '🔓' : '🔒')
          : null,
        isAdmin
          ? el('button', {
              class: 'small danger',
              title: 'Sofort entfernen (Admin)',
              onclick: () => emit('adminField', { token: adminToken, fieldId: f.id, action: 'remove' }),
            }, '✕')
          : null,
        f.locked
          ? el('span', { class: 'locked', title: 'Vom Admin gesperrt – kann nicht rausgewählt werden' }, '🔒 gesperrt')
          : el('button', {
              class: 'small vote' + (mine ? ' on' : ''),
              title: mine ? 'Stimme zurückziehen' : 'Für Entfernen stimmen',
              onclick: () => emit('vote', { fieldId: f.id }),
            }, `👎 ${f.votes.length}/${lobby.votesNeeded}`)
      );
    })
  );
  if (!lobby.fields.length) $('#field-list').append(el('li', { class: 'muted' }, 'Noch keine Felder – füge welche hinzu!'));

  renderPlayers($('#setup-players'));

  const enough = lobby.fields.length >= lobby.fieldsNeeded;
  const hint = enough
    ? `${lobby.fields.length} Felder vorhanden, ${lobby.fieldsNeeded} werden pro Spielfeld genutzt.`
    : `Noch ${lobby.fieldsNeeded - lobby.fields.length} Feld(er) fehlen (${lobby.fieldsNeeded} nötig).`;
  $('#host-settings').hidden = !isHost;
  $('#wait-host').hidden = isHost;
  $('#need-hint').textContent = hint;
  $('#need-hint-guest').textContent = hint;
  $('#btn-start').disabled = !enough;
  $('#set-size').value = lobby.size;
  $('#set-free').checked = lobby.freeCenter;
  $('#set-public').checked = lobby.public;
  $('#set-free').disabled = lobby.size % 2 === 0;
}

// ---------------------------------------------------------------------------
// Spiel
// ---------------------------------------------------------------------------

function renderGame() {
  $('#game-code').textContent = lobby.code;
  $('#game-teacher').textContent = lobby.teacherName;
  $('#game-round').textContent = lobby.round;
  $('#btn-reset').hidden = lobby.hostId !== playerId;

  const grid = $('#board');
  if (board?.board) {
    const marked = new Set(board.marked);
    grid.style.gridTemplateColumns = `repeat(${lobby.size}, minmax(0, 1fr))`;
    grid.replaceChildren(
      ...board.board.map((id, i) => {
        if (id === null) return el('div', { class: 'cell free' }, '⭐ FREI');
        return el(
          'button',
          {
            class: 'cell' + (marked.has(i) ? ' marked' : ''),
            'aria-pressed': marked.has(i) ? 'true' : 'false',
            onclick: () => toggle(i),
          },
          lobby.fieldText[id] ?? '?'
        );
      })
    );
  } else {
    grid.replaceChildren(el('p', { class: 'muted' }, 'Spielfeld wird geladen …'));
  }

  $('#winners').replaceChildren(
    ...lobby.winners.map((w, i) => el('li', {}, `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${w.name}`))
  );
  $('#no-winners').hidden = lobby.winners.length > 0;
  renderPlayers($('#game-players'));
}

async function toggle(index) {
  // sofort anzeigen, Server bestätigt (bei Fehler zurücksetzen)
  const before = board.marked;
  const marked = new Set(before);
  marked.has(index) ? marked.delete(index) : marked.add(index);
  board.marked = [...marked];
  renderGame();
  const res = await emit('mark', { index });
  board.marked = res.marked || before;
  renderGame();
}

function render(force = false) {
  // Bestenliste/Lehrer nicht wegreißen, wenn im Hintergrund die Lobby aktualisiert wird
  if (!force && ['teachers', 'leaderboard', 'admin'].includes(currentView)) return;
  if (!lobby) return show('home');
  if (lobby.phase === 'setup') {
    show('setup');
    renderSetup();
  } else {
    show('game');
    renderGame();
  }
}

// ---------------------------------------------------------------------------
// Socket-Ereignisse
// ---------------------------------------------------------------------------

socket.on('lobby', (data) => {
  lobby = data;
  render();
});

socket.on('board', (data) => {
  board = data;
  render();
});

let overlayTimer;
socket.on('bingo', ({ id, name, place }) => {
  $('#bingo-text').textContent = id === playerId
    ? `Du hast Bingo! (Platz ${place}) 🎉`
    : `${name} hat Bingo! (Platz ${place})`;
  $('#bingo-overlay').hidden = false;
  if (currentView === 'leaderboard') loadLeaderboard();
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => ($('#bingo-overlay').hidden = true), 3500);
});
$('#bingo-overlay').addEventListener('click', () => ($('#bingo-overlay').hidden = true));

socket.on('kicked', () => {
  toast('Du wurdest aus der Lobby entfernt');
  leftLobby();
});

socket.on('connect', async () => {
  const code = store('bingo.lobby');
  const name = store('bingo.name');
  if (code && name) {
    const res = await emit('join', { code, name, playerId });
    if (!res.ok) leftLobby();
  } else if (params.get('lobby') && name) {
    const res = await emit('join', { code: params.get('lobby'), name, playerId });
    if (res.ok) enteredLobby(res.code);
  }
});

// Regeln einmal bestätigen lassen
if (store('bingo.rulesAccepted') !== '1') $('#rules-overlay').hidden = false;
$('#btn-rules').addEventListener('click', () => {
  store('bingo.rulesAccepted', '1');
  $('#rules-overlay').hidden = true;
});

loadTeachers();
checkAdmin();
show('home');
