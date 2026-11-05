'use strict';
// Kurzer End-to-End-Test: zwei Spieler, Felder abstimmen, Spiel starten, Bingo.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-'));
process.env.ADMIN_PASSWORD = 'geheim';
const { server, hasBingo } = require('../server');
const { io } = require('socket.io-client');

const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

assert(hasBingo(3, new Set([0, 1, 2])));
assert(hasBingo(3, new Set([2, 4, 6])));
assert(!hasBingo(3, new Set([0, 1, 5])));

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  try {
    const json = (method, p, body, token) =>
      fetch(url + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
        body: body && JSON.stringify(body),
      });
    const teachers = await (await fetch(url + '/api/teachers')).json();
    assert(teachers.length > 0, 'Seed-Lehrer fehlt');
    assert(teachers[0].phrases.every((p) => p.locked), 'Am Anfang ist alles gesperrt');

    // Admin: ohne Login kein Löschen, falsches Passwort abgelehnt
    assert.equal((await json('DELETE', '/api/teachers/' + teachers[0].id)).status, 403);
    assert.equal((await json('POST', '/api/admin/login', { password: 'falsch' })).status, 401);
    await new Promise((r) => setTimeout(r, 1100));
    const { token } = await (await json('POST', '/api/admin/login', { password: 'geheim' })).json();
    assert(token, 'Kein Admin-Token');
    // Gesperrtes Wort: Hinzufügen geht für alle, aber nicht mit gesperrten Wörtern
    assert.equal((await json('POST', '/api/banned', { word: 'doof' }, token)).status, 201);
    assert.equal((await json('POST', `/api/teachers/${teachers[0].id}/phrases`, { text: 'Ist doof' })).status, 400);
    assert.equal((await json('POST', `/api/teachers/${teachers[0].id}/phrases`, { text: 'Neu von allen' })).status, 201);

    const a = io(url);
    const b = io(url);
    const created = await call(a, 'create', { name: 'Anna', playerId: 'player-aaaa', teacherId: teachers[0].id, size: 3 });
    assert(created.ok, JSON.stringify(created));
    const lobbyState = next(b, 'lobby');
    assert((await call(b, 'join', { name: 'Ben', playerId: 'player-bbbb', code: created.code })).ok);

    // Gesperrtes Lehrer-Feld kann nicht rausgewählt werden
    const lobby0 = await lobbyState;
    assert((await call(a, 'vote', { fieldId: lobby0.fields[0].id })).error);
    assert((await call(b, 'addField', { text: 'total doof' })).error);

    // eigenes Feld + Abstimmung: 2 Spieler -> 2 Stimmen nötig
    let state = next(a, 'lobby');
    assert((await call(b, 'addField', { text: 'Zeigt Kartentrick 2' })).ok);
    let lobby = await state;
    const custom = lobby.fields.find((f) => f.custom);
    assert.equal(custom.author, 'Ben');
    await call(a, 'vote', { fieldId: custom.id });
    state = next(a, 'lobby');
    await call(b, 'vote', { fieldId: custom.id });
    lobby = await state;
    assert(!lobby.fields.some((f) => f.id === custom.id), 'Feld wurde nicht entfernt');
    assert((await call(a, 'addField', { text: 'Bleibt drin' })).ok);

    // Nur Host darf starten
    assert((await call(b, 'start')).error);
    const boardA = next(a, 'board');
    const boardB = next(b, 'board');
    assert((await call(a, 'start')).ok);
    const [ba, bb] = await Promise.all([boardA, boardB]);
    const phrases = (await (await fetch(url + '/api/teachers')).json())[0].phrases.map((p) => p.text);
    assert(phrases.includes('Bleibt drin'), 'Eigenes Feld nicht beim Lehrer gespeichert');
    assert(!phrases.includes('Zeigt Kartentrick 2'), 'Rausgewähltes Feld wurde gespeichert');
    assert.equal(ba.board.length, 9);
    assert.deepEqual([...ba.board].sort(), [...bb.board].sort(), 'Nicht dieselben Felder');

    // Anna kreuzt erste Reihe an (Mitte ist frei)
    const bingo = next(b, 'bingo');
    for (const i of [0, 1, 2]) await call(a, 'mark', { index: i });
    const ev = await bingo;
    assert.equal(ev.name, 'Anna');

    // Bestenliste: Anna 1. Platz, beide eine Runde
    let board = await (await fetch(url + '/api/leaderboard')).json();
    assert.deepEqual(board.map((s) => [s.name, s.points, s.wins, s.bingos, s.rounds]), [
      ['Anna', 5, 1, 1, 1],
      ['Ben', 0, 0, 0, 1],
    ]);
    // Bingo wieder wegklicken nimmt die Punkte zurück
    await call(a, 'mark', { index: 0 });
    board = await (await fetch(url + '/api/leaderboard')).json();
    assert.equal(board[0].points, 0);
    console.log('✓ Smoke-Test bestanden');
    a.close();
    b.close();
    server.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
});
