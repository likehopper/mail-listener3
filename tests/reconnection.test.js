const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function setup(options = {}) {
  const timers = new Map();
  let timerId = 0;
  class Imap extends EventEmitter {
    constructor() { super(); this.connects = 0; this.ends = 0; this.searches = 0; }
    connect() { this.connects++; }
    end() { this.ends++; }
    openBox(box, readonly, callback) { this.openCallback = callback; if (!this.deferOpen) callback(this.openError); }
    search(filter, callback) { this.searches++; callback(null, []); }
  }
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === 'imap') return Imap;
      if (name === './mail-parser') return function () {};
      if (name === 'async') return {};
      return require(name);
    },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), context);
  const listener = new context.module.exports(options);
  const errors = [];
  listener.on('error', error => errors.push(error));
  function tick() {
    assert.equal(timers.size, 1);
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.fn(); return timer.delay;
  }
  return { listener, imap: listener.imap, timers, tick, errors, create: opts => new context.module.exports(opts) };
}

test('reconnect is opt-in', () => {
  const s = setup(); s.listener.start(); s.imap.emit('close');
  assert.equal(s.timers.size, 0);
  s.listener.start(); assert.equal(s.imap.connects, 2);
});
test('retries repeated failures with a bounded exponential delay', () => {
  const s = setup({ reconnect: true, reconnectDelay: 10, reconnectMaxDelay: 40 });
  s.listener.start();
  for (const delay of [10, 20, 40, 40]) {
    s.imap.emit('error', new Error('synthetic connection failure'));
    s.imap.emit('close'); s.imap.emit('close');
    assert.equal(s.tick(), delay);
  }
  assert.equal(s.imap.connects, 5);
  assert.equal(s.errors.length, 4);
});
test('successful mailbox open resets delay and resumes unread fetching without duplicate handlers', () => {
  const s = setup({ reconnect: true, reconnectDelay: 10, reconnectMaxDelay: 40, fetchUnreadOnStart: true });
  let connected = 0; s.listener.on('server:connected', () => connected++);
  s.listener.start();
  for (let i = 0; i < 4; i++) {
    s.imap.emit('ready'); s.imap.emit('mail'); s.imap.emit('close');
    assert.equal(s.tick(), 10);
  }
  assert.equal(connected, 4); assert.equal(s.imap.searches, 8);
  assert.equal(s.imap.listenerCount('ready'), 1);
  assert.equal(s.imap.listenerCount('close'), 1);
  assert.equal(s.imap.listenerCount('mail'), 1);
});
test('stop cancels a pending retry and explicit restart works', () => {
  const s = setup({ reconnect: true });
  s.listener.start(); s.imap.emit('close'); s.listener.stop();
  assert.equal(s.timers.size, 0);
  s.imap.emit('close'); s.imap.emit('ready'); s.imap.emit('mail');
  assert.equal(s.timers.size, 0); assert.equal(s.imap.searches, 0);
  s.listener.start(); s.listener.start();
  assert.equal(s.imap.connects, 2);
});
test('stop from a reconnect notification cancels the scheduled attempt', () => {
  const s = setup({ reconnect: true });
  s.listener.on('server:reconnecting', () => s.listener.stop());
  s.listener.start(); s.imap.emit('close'); assert.equal(s.timers.size, 0);
});
test('stop during mailbox open ignores late completion', () => {
  const s = setup({ reconnect: true, fetchUnreadOnStart: true });
  s.imap.deferOpen = true;
  let connected = 0; s.listener.on('server:connected', () => connected++);
  s.listener.start(); s.imap.emit('ready'); s.listener.stop(); s.imap.openCallback(null);
  assert.equal(connected, 0); assert.equal(s.imap.searches, 0);
});
test('mailbox open failure closes the session before retry', () => {
  const s = setup({ reconnect: true }); s.imap.openError = new Error('synthetic mailbox failure');
  s.listener.start(); s.imap.emit('ready');
  assert.equal(s.imap.ends, 1); assert.equal(s.errors.length, 1);
  s.imap.emit('close'); s.tick(); assert.equal(s.imap.connects, 2);
});
test('invalid delays are rejected', () => {
  const s = setup();
  for (const opts of [{ reconnectDelay: 0 }, { reconnectDelay: -1 }, { reconnectDelay: '10' },
    { reconnectMaxDelay: Infinity }, { reconnectDelay: 20, reconnectMaxDelay: 10 }, { reconnectMaxDelay: 2147483648 }]) {
    assert.throws(() => s.create(opts), { name: 'RangeError' });
  }
});

test('a successful connection resets backoff after consecutive failures', () => {
  const s = setup({ reconnect: true, reconnectDelay: 10, reconnectMaxDelay: 40 });
  s.listener.start();
  s.imap.emit('close'); assert.equal(s.tick(), 10);
  s.imap.emit('close'); assert.equal(s.tick(), 20);
  s.imap.emit('ready');
  s.imap.emit('close'); assert.equal(s.tick(), 10);
});
