// Shows a running session (scripts/session.ts) in the browser and sends it the keys typed there.
// node scripts/watch.mjs win98   then open http://127.0.0.1:8098/
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const name = process.argv[2] ?? 'win98';
const port = Number(process.argv[3] ?? 8098);
const dir = join('.profile', name);
const commandsPath = join(dir, 'commands.txt');

/** Keys waiting to go to the session, which deletes the commands file once it has read it. */
const queue = [];
setInterval(() => {
  if (queue.length && !existsSync(commandsPath)) writeFileSync(commandsPath, `${queue.splice(0).join('\n')}\n`);
}, 100);

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${name} session</title>
    <style>
      body { margin: 0; background: #111; color: #ccc; font: 14px system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
      img { width: min(96vw, 1280px); aspect-ratio: 4 / 3; image-rendering: pixelated; background: #000; outline: 2px solid #333; }
      body.typing img { outline-color: #4a8; }
      pre { margin: 8px 0 0; white-space: pre-wrap; max-width: min(96vw, 1280px); }
    </style>
  </head>
  <body tabindex="0">
    <div>
      <img id="screen" alt="The emulated PC's screen" />
      <pre id="status">Waiting for the session...</pre>
      <pre id="sent">Click here and type: keys go to the PC (a green frame means it's listening).</pre>
    </div>
    <script>
      const screen = document.getElementById('screen');
      const status = document.getElementById('status');
      const sent = document.getElementById('sent');
      async function refresh() {
        try {
          const response = await fetch('screen.png?t=' + Date.now(), { cache: 'no-store' });
          if (response.ok) {
            const url = URL.createObjectURL(await response.blob());
            const old = screen.src;
            screen.src = url;
            if (old.startsWith('blob:')) URL.revokeObjectURL(old);
          }
          const text = await (await fetch('status.txt?t=' + Date.now(), { cache: 'no-store' })).text();
          status.textContent = text.split('\\n').slice(0, 2).join('\\n');
        } catch {
          status.textContent = 'The session is not running.';
        }
        setTimeout(refresh, 1000);
      }
      refresh();
      const MODIFIERS = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
      document.body.addEventListener('focus', () => document.body.classList.add('typing'));
      document.body.addEventListener('blur', () => document.body.classList.remove('typing'));
      document.body.addEventListener('keydown', (event) => {
        if (event.metaKey || MODIFIERS.includes(event.code)) return;
        event.preventDefault();
        const key = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.code].filter(Boolean).join('+');
        fetch('keys', { method: 'POST', body: key });
        sent.textContent = 'Sent ' + key + ' (it can take a few seconds to show)';
      });
    </script>
  </body>
</html>`;

createServer((request, response) => {
  const path = request.url.split('?')[0];
  if (request.method === 'POST' && path === '/keys') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (/^[A-Za-z0-9+]+$/.test(body)) queue.push(`keys ${body}`);
      response.end('ok');
    });
    return;
  }
  if (path === '/' || path === '/index.html') {
    response.setHeader('content-type', 'text/html');
    response.end(PAGE);
    return;
  }
  const file = path === '/screen.png' ? 'screen.png' : path === '/status.txt' ? 'status.txt' : null;
  if (!file || !existsSync(join(dir, file))) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('content-type', file.endsWith('.png') ? 'image/png' : 'text/plain');
  response.setHeader('cache-control', 'no-store');
  response.end(readFileSync(join(dir, file)));
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
