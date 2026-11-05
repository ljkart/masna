// Serves the project's files on PORT, for looking at pages locally.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const root = resolve(process.cwd());

createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  let file = resolve(join(root, decodeURIComponent(pathname)));
  if (file !== root && !file.startsWith(root + sep)) file = null;
  else if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');

  if (!file || !existsSync(file)) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(Number(process.env.PORT), '127.0.0.1');
