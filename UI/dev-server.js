// Local stand-in for Vercel: run `node dev-server.js` in this folder, then open http://localhost:4173.
// Serves the site the way vercel.json does and runs the api/ functions with keys from .env.local.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const apiDir = path.join(root, 'api');
const port = Number(process.env.PORT) || 4173;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

try {
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && match[2] && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  console.warn('No .env.local found: copy .env.example to .env.local to run the api/ functions.');
}

function notFound(res) {
  res.statusCode = 404;
  res.end('Not found');
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return notFound(res);
  }
  // Never serve dotfiles (.env.local holds secret keys) or step outside this folder.
  if (pathname.split('/').some((part) => part.startsWith('.'))) return notFound(res);

  // Local stand-in for the AI call: the browser can't reach Prism's AI function directly until it allows browser requests (CORS),
  // so on localhost the app posts here and this server forwards the request, headers and all.
  if (pathname === '/gateway' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const forwarded = {};
    for (const name of ['authorization', 'apikey', 'content-type', 'x-prism-video', 'x-prism-minutes', 'x-prism-day', 'x-prism-run'])
      if (req.headers[name]) forwarded[name] = req.headers[name];
    try {
      const upstream = await fetch('https://isdplhahgggundbohmlr.supabase.co/functions/v1/gemini', { method: 'POST', headers: forwarded, body: Buffer.concat(chunks) });
      res.statusCode = upstream.status;
      for (const name of ['content-type', 'retry-after']) if (upstream.headers.get(name)) res.setHeader(name, upstream.headers.get(name));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: { message: `The local server could not reach Prism AI: ${error.message}` } }));
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length);
    const file = path.join(apiDir, `${name}.js`);
    // Like Vercel: files starting with "_" are shared code, not endpoints.
    if (!/^[a-z-]+$/.test(name) || !fs.existsSync(file)) return notFound(res);
    // Reload the functions on every request, so edits apply without a restart.
    for (const key of Object.keys(require.cache)) if (key.startsWith(apiDir)) delete require.cache[key];
    try {
      await require(file)(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
    return;
  }

  // Mirrors vercel.json: clean URLs, plus /dashboard_<user id> served by dashboard.html.
  let file = pathname === '/' ? '/index' : /^\/dashboard_[^/]+$/.test(pathname) ? '/dashboard' : pathname;
  // Vercel serves its analytics scripts only on deployments; locally they are empty.
  if (pathname.startsWith('/_vercel/')) { res.setHeader('Content-Type', 'application/javascript'); return res.end(''); }
  // Prices are switched off for now: the pricing page sends people to the app, as vercel.json does.
  if (pathname === '/pricing' || pathname === '/pricing.html') { res.statusCode = 307; res.setHeader('Location', '/app'); return res.end(); }
  // The web app has an address per screen (/app/settings/usage, /app/project/...): any of them without a file extension is the app.
  if (pathname === '/app' || (pathname.startsWith('/app/') && !path.extname(pathname))) file = '/app/index.html';
  // Like Vercel, a folder serves its index.html (/app/ → app/index.html).
  if (!path.extname(file) && fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isDirectory()) file = path.join(file, 'index');
  if (!path.extname(file)) file += '.html';
  const full = path.join(root, file);
  if (!full.startsWith(root + path.sep)) return notFound(res);
  fs.readFile(full, (error, data) => {
    if (error) {
      res.statusCode = 404;
      res.setHeader('Content-Type', types['.html']);
      return fs.createReadStream(path.join(root, '404.html')).pipe(res);
    }
    res.setHeader('Content-Type', types[path.extname(full)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  });
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Stop the other server or set PORT.` : error);
  process.exit(1);
});
// Only this Mac can connect: the api/ functions run with the secret keys from .env.local.
server.listen(port, '127.0.0.1', () => console.log(`Prism site: http://localhost:${port}`));
