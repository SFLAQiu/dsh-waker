// dsh-waker avatar io helper (zero-dep Node script, run by host via subprocess).
// Usage:
//   node avatar-io.cjs list <dir>                 -> JSON [{file,size,bytes}]
//   node avatar-io.cjs write <dir> <file>         -> reads base64 png/jpg/webp from stdin, writes file
//   node avatar-io.cjs delete <dir> <file>
// Dir comes from host (AVATAR_DIR). Sanitizes file name: basename, ascii-safe optional.
'use strict';
const fs = require('fs');
const path = require('path');

const [cmd, dir, fileArg] = process.argv.slice(2);
if (!dir) { console.error('dir required'); process.exit(2); }
const EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const MAX = 3 * 1024 * 1024;

function sanitize(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-\u4e00-\u9fa5 ]/g, '');
  return base || 'avatar-' + Date.now().toString(36) + '.png';
}

async function main() {
  if (cmd === 'list') {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { files = []; }
    const out = files
      .filter((f) => EXTS.some((x) => f.toLowerCase().endsWith(x)))
      .map((f) => {
        let size = 0;
        try { size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
        return { file: f, size };
      })
      .sort((a, b) => a.file.localeCompare(b.file, 'zh'));
    process.stdout.write(JSON.stringify(out));
    return;
  }
  if (cmd === 'write') {
    const file = sanitize(fileArg);
    const target = path.join(dir, file);
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) { console.error('empty body'); process.exit(3); }
      if (buf.length > MAX) { console.error('too large'); process.exit(4); }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, buf);
      process.stdout.write(JSON.stringify({ file, size: buf.length }));
    });
    return;
  }
  if (cmd === 'delete') {
    const file = sanitize(fileArg);
    try { fs.unlinkSync(path.join(dir, file)); } catch (e) {}
    process.stdout.write(JSON.stringify({ deleted: file }));
    return;
  }
  console.error('unknown cmd ' + cmd);
  process.exit(2);
}
main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
