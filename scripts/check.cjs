const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
for (const dir of ['src', 'test', 'scripts']) {
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (/\.(cjs|mjs|js)$/.test(entry)) execFileSync(process.execPath, ['--check', join(dir, entry)], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax checks passed.');
