/** Trusted constant code, executed inside the namespace. User input is JSON data on stdin. */
export const IO_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
let chunks = [], size = 0;
process.stdin.on('data', chunk => {
  size += chunk.length;
  if (size > 96 * 1024 * 1024) { process.stderr.write('Input limit exceeded'); process.exit(2); }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof input.path !== 'string' || input.path.includes('\0') || !input.path.startsWith('/')) throw new Error('Invalid path');
    let value;
    switch (input.operation) {
      case 'prefix': {
        if (!Number.isSafeInteger(input.prefixBytes) || input.prefixBytes < 1 || input.prefixBytes > 8192) throw new Error('Invalid prefix limit');
        const fd = fs.openSync(input.path, 'r');
        try { const buffer = Buffer.alloc(input.prefixBytes); const count = fs.readSync(fd, buffer, 0, input.prefixBytes, 0); value = buffer.subarray(0, count).toString('base64'); }
        finally { fs.closeSync(fd); } break;
      }
      case 'read': {
        const stat = fs.statSync(input.path);
        if (!stat.isFile() || stat.size > input.maxFileBytes) throw new Error('File exceeds read resource limit');
        value = fs.readFileSync(input.path).toString('base64'); break;
      }
      case 'access': fs.accessSync(input.path, input.writable ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK); value = true; break;
      case 'exists': value = fs.existsSync(input.path); break;
      case 'stat': value = { directory: fs.statSync(input.path).isDirectory() }; break;
      case 'readdir': value = fs.readdirSync(input.path); if (value.length > 20000) throw new Error('Directory listing exceeds limit'); break;
      case 'mkdir': fs.mkdirSync(input.path, { recursive: true }); value = true; break;
      case 'write': {
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > input.maxFileBytes) throw new Error('Write exceeds resource limit');
        fs.writeFileSync(input.path, input.content); value = true; break;
      }
      default: throw new Error('Unknown file operation');
    }
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: typeof error.code === 'string' ? error.code : 'IO_ERROR', message: error.code ? 'File operation denied or unavailable in this workspace' : error.message }));
  }
});
`
