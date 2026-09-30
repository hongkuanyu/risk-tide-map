'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const version = process.env.MAPLIBRE_VERSION || '4.7.1';
const root = path.resolve(__dirname, '..');
const downloads = [
  {
    url: 'https://unpkg.com/maplibre-gl@' + version + '/dist/maplibre-gl.js',
    target: path.join(root, 'vendor', 'maplibre-gl.js')
  },
  {
    url: 'https://unpkg.com/maplibre-gl@' + version + '/dist/maplibre-gl.css',
    target: path.join(root, 'vendor', 'maplibre-gl.css')
  }
];

function download(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (response) {
      if (response.statusCode !== 200) {
        reject(new Error(url + ' -> HTTP ' + response.statusCode));
        response.resume();
        return;
      }
      const chunks = [];
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () { resolve(Buffer.concat(chunks)); });
    }).on('error', reject);
  });
}

(async function main() {
  for (const item of downloads) {
    const data = await download(item.url);
    const temporary = item.target + '.tmp';
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, item.target);
    console.log('Updated ' + path.relative(root, item.target) + ' (' + data.length + ' bytes)');
  }
  console.log('MapLibre ' + version + ' vendored successfully.');
})().catch(function (error) {
  console.error(error.message);
  process.exitCode = 1;
});
