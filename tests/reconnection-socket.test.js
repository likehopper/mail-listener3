const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const MailListener = require('../index');

test('real IMAP transport reconnects after socket loss and stays stopped after stop()', { timeout: 5000 }, async () => {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK synthetic IMAP server\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const [tag, command] = line.split(' ');
        switch (command.toUpperCase()) {
          case 'CAPABILITY': socket.write('* CAPABILITY IMAP4rev1 IDLE\r\n' + tag + ' OK capabilities\r\n'); break;
          case 'LOGIN': socket.write(tag + ' OK logged in\r\n'); break;
          case 'LIST': socket.write('* LIST (\\Noselect) "/" ""\r\n' + tag + ' OK list\r\n'); break;
          case 'SELECT': socket.write('* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 1] next\r\n' + tag + ' OK [READ-WRITE] selected\r\n'); break;
          case 'IDLE': socket.write('+ idling\r\n'); break;
          case 'LOGOUT': socket.end('* BYE logout\r\n' + tag + ' OK logout\r\n'); break;
          default: socket.write(tag + ' OK command\r\n');
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const listener = new MailListener({ username: 'synthetic', password: 'synthetic',
    host: '127.0.0.1', port: server.address().port, tls: false,
    reconnect: true, reconnectDelay: 10, reconnectMaxDelay: 40 });
  const errors = [];
  listener.on('error', error => errors.push(error));
  function connected() {
    return new Promise(resolve => listener.once('server:connected', resolve));
  }
  try {
    let ready = connected(); listener.start(); await ready;
    ready = connected(); for (const socket of sockets) socket.destroy(); await ready;
    assert.equal(connections, 2);
    listener.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(connections, 2);
    // Destroying sockets can emit ECONNRESET depending on platform timing.
    assert(errors.every(error => error.code === 'ECONNRESET'));
  } finally {
    listener.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
