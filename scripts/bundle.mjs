// Build dist/worker.js: the Worker with /public embedded, for deploying through the Cloudflare API without the assets upload.
import fs from 'node:fs';
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const files = {};
for (const f of fs.readdirSync('public')) files['/' + f] = { type: types[f.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync('public/' + f, 'utf8') };
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/worker.js', `globalThis.__STATIC = ${JSON.stringify(files)};\n` + fs.readFileSync('src/worker.js', 'utf8'));
console.log('dist/worker.js', fs.statSync('dist/worker.js').size);
