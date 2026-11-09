// Hashes the parts of a file that is about to be resumed (verify() in api.js): gets a Blob, answers {read} after
// each 4 MiB chunk and {hash} (lowercase hex MD5, or null if the file couldn't be read) at the end. Reading in chunks
// keeps a 50 MiB part from sitting in memory twice.
'use strict';
importScripts('vendor/spark-md5-3.0.2.js');
self.onmessage = async ({ data: blob }) => {
  const CHUNK = 4 * 1024 * 1024;
  try {
    const md5 = new self.SparkMD5.ArrayBuffer();
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      md5.append(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      self.postMessage({ read: Math.min(blob.size, offset + CHUNK) });
    }
    self.postMessage({ hash: md5.end() });
  } catch { self.postMessage({ hash: null }); }
};
