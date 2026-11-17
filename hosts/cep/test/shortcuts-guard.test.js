'use strict';

// 全局快捷键的「焦点门控」没有可注入的 DOM，main.js 又依赖 CSInterface 无法直接跑。
// 这里把源码里的判定表达式原样抽出来执行：判定写错（比如漏掉 BUTTON）会立刻失败，
// 而不只是靠注释提醒。两端表达式还要求语义一致，避免 CEP 修了 UXP 没修。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILES = {
  cep: path.join(ROOT, 'hosts', 'cep', 'js', 'main.js'),
  uxp: path.join(ROOT, 'hosts', 'uxp', 'src', 'main.js')
};

// 取 `isControlFocused = <表达式>;` 这一整段，保留原始代码执行。
function predicateOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const match = /(?:var|const)\s+isControlFocused\s*=\s*([\s\S]*?\n\s*\));/.exec(src);
  assert.ok(match, file + ': 找不到 isControlFocused 判定表达式');
  const fn = new Function('active', 'activeTag', 'return (' + match[1] + ');');
  return { fn, source: match[1].replace(/\s+/g, ' ') };
}

function element(tag, extra) {
  return Object.assign({ tagName: tag, getAttribute: () => null }, extra || {});
}

for (const [side, file] of Object.entries(FILES)) {
  test(side + ': Enter/空格在按钮聚焦时不被全局快捷键劫持', () => {
    const { fn } = predicateOf(file);
    for (const tag of ['BUTTON', 'A', 'SUMMARY', 'INPUT', 'TEXTAREA', 'SELECT']) {
      assert.equal(fn(element(tag), tag), true, tag + ' 聚焦时应交给控件原生处理');
    }
  });

  test(side + ': contenteditable 与空焦点判定正确', () => {
    const { fn } = predicateOf(file);
    assert.equal(fn(element('DIV', { isContentEditable: true }), 'DIV'), true);
    assert.equal(fn(element('DIV', { getAttribute: () => 'true' }), 'DIV'), true);
    assert.equal(fn(element('DIV'), 'DIV'), false, '面板空白处仍要响应盲操快捷键');
    assert.equal(fn(null, ''), false);
  });

  test(side + ': 应用分支位于焦点门控之内', () => {
    const src = fs.readFileSync(file, 'utf8');
    const gate = src.indexOf('!isControlFocused && lastState');
    const apply = src.indexOf(".use.click()");
    assert.ok(gate > 0 && apply > gate, '应用结果的调用必须受焦点门控保护');
    assert.ok(src.indexOf('isInputActive') === -1, '旧的只挡输入框的判定不应残留');
  });
}

test('CEP 与 UXP 的焦点判定语义一致', () => {
  assert.equal(predicateOf(FILES.cep).source, predicateOf(FILES.uxp).source);
});
