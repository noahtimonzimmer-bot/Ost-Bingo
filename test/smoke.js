'use strict';
// Kurzer End-to-End-Test: zwei Spieler, Felder abstimmen, Spiel starten, Bingo.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-'));
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
    const teachers = await (await fetch(url + '/api/teachers')).json();
    assert(teachers.length > 0, 'Seed-Lehrer fehlt');

    const a = io(url);
    const b = io(url);
    const created = await call(a, 'create', { name: 'Anna', playerId: 'player-aaaa', teacherId: teachers[0].id, size: 3 });
    assert(created.ok, JSON.stringify(created));
    assert((await call(b, 'join', { name: 'Ben', playerId: 'player-bbbb', code: created.code })).ok);

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

    // Nur Host darf starten
    assert((await call(b, 'start')).error);
    const boardA = next(a, 'board');
    const boardB = next(b, 'board');
    assert((await call(a, 'start')).ok);
    const [ba, bb] = await Promise.all([boardA, boardB]);
    assert.equal(ba.board.length, 9);
    assert.deepEqual([...ba.board].sort(), [...bb.board].sort(), 'Nicht dieselben Felder');

    // Anna kreuzt erste Reihe an (Mitte ist frei)
    const bingo = next(b, 'bingo');
    for (const i of [0, 1, 2]) await call(a, 'mark', { index: i });
    const ev = await bingo;
    assert.equal(ev.name, 'Anna');
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
