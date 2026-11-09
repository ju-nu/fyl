// The download service worker of encrypted links (docs/E2EE.md §9.2). Served from /_dl/, so the browser confines it to
// /_dl/: it controls no fyl.at page and never sees /d/, /api/ or a key. It only relays plaintext that the page (or its
// worker) decrypted, as a download the browser saves: the page posts {type: 'download', token, name, size} with a
// MessagePort, then opens /_dl/<token> in a hidden frame, which this answers once with a streamed attachment.
'use strict';
const pending = new Map(); // token → {name, size, port}
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
// The page's producer says {type: 'alive'} every 5 s while it runs, retries included. Waiting for data this long without
// a word from it means its page was closed (§9.2): the download fails instead of hanging as a partial file.
const SILENCE = 30000;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', event => {
  const {type, token, name, size} = event.data || {};
  if (type === 'download' && TOKEN.test(token) && typeof name === 'string' && name && Number.isSafeInteger(size) && size >= 0 && event.ports[0]) {
    pending.set(token, {name, size, port: event.ports[0]});
    // A token nobody opens doesn't stay: the page gives up after 10 s.
    setTimeout(() => { pending.get(token)?.port.close(); pending.delete(token); }, 60000);
  } else if (type === 'cancel') { pending.get(token)?.port.close(); pending.delete(token); }
  // {type: 'ping'} only keeps this worker running while a download lasts (some browsers stop idle workers).
});

// Content-Disposition as the Worker writes it (downloadHeaders() in src/index.ts).
const disposition = name => 'attachment; filename="' + (name.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 160) || 'download') + '"; filename*=UTF-8\'\''
  + encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());

function stream({name, size, port}) {
  const queue = [];
  let wake = null, pulled = false, heard = Date.now(), gone = false;
  port.onmessage = ({data}) => { heard = Date.now(); if (data?.type !== 'alive') queue.push(data); wake?.(); };
  // Where browsers report it, a port whose page went away ends the wait at once.
  port.addEventListener('close', () => { gone = true; wake?.(); });
  port.postMessage({type: 'started'});
  // highWaterMark 0: nothing is asked of the page before the browser reads, so its first pull means the download was
  // accepted. At most four chunks wait here (the page sends ahead of the acks only that far).
  const body = new ReadableStream({
    async pull(controller) {
      if (!pulled) { pulled = true; heard = Date.now(); port.postMessage({type: 'pulled'}); }
      while (!queue.length) {
        if (gone || Date.now() - heard >= SILENCE) { controller.error(new Error('The page decrypting this download was closed.')); return; }
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 1000); });
      }
      const item = queue.shift();
      if (item?.type === 'chunk' && item.data instanceof ArrayBuffer) { controller.enqueue(new Uint8Array(item.data)); port.postMessage({type: 'ack'}); }
      else if (item?.type === 'end') { controller.close(); port.postMessage({type: 'closed'}); }
      else controller.error(new Error('The file could not be decrypted.'));
    },
    cancel() { port.postMessage({type: 'cancel'}); },
  }, {highWaterMark: 0});
  return new Response(body, {headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition(name), 'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'",
    'Referrer-Policy': 'no-referrer',
  }});
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/_dl/') || url.pathname === '/_dl/sw.js') return;
  // Each token works once; an unknown one is 404, like /_dl/<anything> at the Worker.
  const token = url.pathname.slice(5), entry = pending.get(token);
  pending.delete(token);
  event.respondWith(entry && event.request.method === 'GET' ? stream(entry)
    : new Response('Not found.', {status: 404, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}}));
});
