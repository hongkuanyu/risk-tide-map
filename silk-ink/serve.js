'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const os = require('os');

const root = __dirname;
const port = Number(process.env.PORT) || 8080;
const url = 'http://localhost:' + port + '/';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp'
};

function getLanUrls() {
  const urls = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach(function (name) {
    (interfaces[name] || []).forEach(function (address) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push('http://' + address.address + ':' + port + '/');
      }
    });
  });
  return urls;
}

function openBrowser() {
  if (process.env.RISK_TIDE_NO_OPEN === '1') return;
  let command;
  if (process.platform === 'win32') {
    command = 'start "" "' + url + '"';
  } else if (process.platform === 'darwin') {
    command = 'open "' + url + '"';
  } else {
    command = 'xdg-open "' + url + '"';
  }
  try {
    const child = childProcess.spawn(command, {
      detached: true,
      shell: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    console.log('Open this URL manually: ' + url);
  }
}

const server = http.createServer(function (request, response) {
  let pathname = decodeURIComponent((request.url || '/').split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(root, '.' + pathname);
  if (!target.startsWith(root + path.sep) && target !== path.join(root, 'index.html')) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.stat(target, function (error, stat) {
    if (error || !stat.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const extension = path.extname(target).toLowerCase();
    response.writeHead(200, {
      'Content-Type': mime[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(target).pipe(response);
  });
});

server.on('error', function (error) {
  if (error.code === 'EADDRINUSE') {
    console.log('Port ' + port + ' is already in use. Opening the existing server...');
    openBrowser();
    setTimeout(function () { process.exit(0); }, 500);
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(port, function () {
  const lanUrls = getLanUrls();
  console.log('Risk Tide Map: ' + url);
  lanUrls.forEach(function (lanUrl) { console.log('Mobile on same Wi-Fi: ' + lanUrl); });
  fs.writeFileSync(path.join(root, 'MOBILE_URL.txt'), [url].concat(lanUrls).join('\r\n') + '\\r\\n', 'utf8');
  console.log('Keep this terminal open. Press Ctrl+C to stop.');
  openBrowser();
});


