#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sharedDir = path.join(root, 'hosts', 'shared');

const mappings = [
  {
    src: path.join(sharedDir, 'panel.js'),
    dests: [
      path.join(root, 'hosts', 'cep', 'js', 'panel.js'),
      path.join(root, 'hosts', 'uxp', 'src', 'panel.js'),
    ],
  },
  {
    src: path.join(sharedDir, 'panel.css'),
    dests: [
      path.join(root, 'hosts', 'cep', 'css', 'panel.css'),
      path.join(root, 'hosts', 'uxp', 'css', 'panel.css'),
    ],
  },
  {
    src: path.join(sharedDir, 'channel-view.js'),
    dests: [
      path.join(root, 'hosts', 'cep', 'js', 'channel-view.js'),
      path.join(root, 'hosts', 'uxp', 'src', 'channel-view.js'),
    ],
  },
  {
    src: path.join(sharedDir, 'compare-view.js'),
    dests: [
      path.join(root, 'hosts', 'cep', 'js', 'compare-view.js'),
      path.join(root, 'hosts', 'uxp', 'src', 'compare-view.js'),
    ],
  },
  {
    src: path.join(sharedDir, 'theme.js'),
    dests: [
      path.join(root, 'hosts', 'cep', 'js', 'theme.js'),
      path.join(root, 'hosts', 'uxp', 'src', 'theme.js'),
    ],
  },
];

const checkOnly = process.argv.includes('--check');
let hasMismatch = false;

for (const { src, dests } of mappings) {
  if (!fs.existsSync(src)) {
    console.error(`[ERROR] 唯一源文件不存在: ${path.relative(root, src)}`);
    process.exit(1);
  }
  const canonical = fs.readFileSync(src, 'utf8');

  for (const dest of dests) {
    const relDest = path.relative(root, dest);
    const exists = fs.existsSync(dest);
    const matches = exists && fs.readFileSync(dest, 'utf8') === canonical;

    if (!matches) {
      hasMismatch = true;
      if (checkOnly) {
        console.error(`[MISMATCH] ${relDest} 与唯一源 ${path.relative(root, src)} 不一致`);
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, canonical, 'utf8');
        console.log(`[SYNCED] ${relDest} <- ${path.relative(root, src)}`);
      }
    } else if (!checkOnly) {
      console.log(`[OK] ${relDest} 已与唯一源一致`);
    }
  }
}

if (checkOnly) {
  if (hasMismatch) {
    console.error('\n检测到副本与 shared 唯一源存在差异！请运行 `npm run sync` 进行同步。');
    process.exit(1);
  } else {
    console.log('[CHECK] 所有 hosts 副本文件均与 hosts/shared 唯一源完全一致。');
  }
} else {
  console.log('\n[DONE] 同步完成。可运行 `npm test` 或 `node --test hosts/cep/test/panel-parity.test.js` 验证一致性。');
}
