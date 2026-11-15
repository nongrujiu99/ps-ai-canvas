const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const canonical = path.join(root, 'shared', 'panel.js');
const copies = [path.join(root, 'cep', 'js', 'panel.js'), path.join(root, 'uxp', 'src', 'panel.js')];
const canonicalCss = path.join(root, 'shared', 'panel.css');
const cssCopies = [path.join(root, 'cep', 'css', 'panel.css'), path.join(root, 'uxp', 'css', 'panel.css')];
const canonicalView = path.join(root, 'shared', 'channel-view.js');
const viewCopies = [path.join(root, 'cep', 'js', 'channel-view.js'), path.join(root, 'uxp', 'src', 'channel-view.js')];
const canonicalTheme = path.join(root, 'shared', 'theme.js');
const themeCopies = [path.join(root, 'cep', 'js', 'theme.js'), path.join(root, 'uxp', 'src', 'theme.js')];
const canonicalCompare = path.join(root, 'shared', 'compare-view.js');
const compareCopies = [path.join(root, 'cep', 'js', 'compare-view.js'), path.join(root, 'uxp', 'src', 'compare-view.js')];

// CEP 用 <script> 加载、UXP 用 require，打包结构不同，只能各放一份。
// 但两份实现一旦各自演化，就会重新长出「同一个操作在两端结果不同」的分叉
// （UXP 曾经丢了推导比例、坐标指引和临时文件回收，而且错得静默）。
// 这个测试把「必须保持一致」变成一条会失败的断言，而不是一句口头约定。
test('both host panels are byte-identical copies of shared/panel.js', () => {
  const expected = fs.readFileSync(canonical, 'utf8');
  for (const file of copies) {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, path.relative(root, file) + ' 与 shared/panel.js 不一致，请重新复制');
  }
});

// 样式同理：两份 CSS 各自演化过一次（滚动条、预览图尺寸、倍率步长都分叉了），
// 所以用同一个断言把「只能有一份」钉住。
test('both host stylesheets are byte-identical copies of shared/panel.css', () => {
  const expected = fs.readFileSync(canonicalCss, 'utf8');
  for (const file of cssCopies) {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, path.relative(root, file) + ' 与 shared/panel.css 不一致，请重新复制');
  }
});

// 渠道设置在两端是同一套 DOM id，逻辑必须一份：否则会出现「CEP 能切渠道、UXP 切不了」
// 这类只在一边复现的问题，而 UXP 这台机器根本没法真机验证。
test('both host channel views are byte-identical copies of shared/channel-view.js', () => {
  const expected = fs.readFileSync(canonicalView, 'utf8');
  for (const file of viewCopies) {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, path.relative(root, file) + ' 与 shared/channel-view.js 不一致，请重新复制');
  }
});

// preview/live.html 是给人点的交互预览：它加载真实 CSS 和真实控制器，只把
// Photoshop 与本地服务换成模拟层。但它的 DOM 是从 index.html 抄过来的，
// 抄一份就会漏一份——面板以后加了控件而预览里没有，点不到的人会以为功能没做。
// 所以拿 id 集合做断言，而不是靠「记得同步」。
const previewFile = path.join(root, '..', 'preview', 'live.html');
const cepIndex = path.join(root, 'cep', 'index.html');

function idsOf(html) {
  const ids = new Set();
  const re = /\bid="([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) ids.add(match[1]);
  return ids;
}

test('the interactive preview carries every control the real panel has', () => {
  const panelIds = idsOf(fs.readFileSync(cepIndex, 'utf8'));
  const missing = [...panelIds].filter((id) => !idsOf(fs.readFileSync(previewFile, 'utf8')).has(id));
  assert.deepEqual(missing, [], 'preview/live.html 缺少这些 id：' + missing.join('、'));
});

test('the interactive preview loads the real stylesheet and controller', () => {
  const html = fs.readFileSync(previewFile, 'utf8');
  for (const ref of ['../hosts/cep/css/panel.css', '../hosts/cep/js/panel.js', '../hosts/cep/js/channel-view.js', '../hosts/cep/js/compare-view.js', '../hosts/cep/js/main.js']) {
    assert.ok(html.includes(ref), 'preview/live.html 没有引用 ' + ref);
    assert.ok(fs.existsSync(path.join(path.dirname(previewFile), ref)), ref + ' 不存在');
  }
});

// 大图对比视图同理：滑块对齐靠的是「两层图同宽」这一条几何约定，两端各写一份
// 迟早会出现「CEP 对得齐、UXP 压扁」这种只在一边复现的问题，而 UXP 这台机器没法真机验证。
test('both host compare views are byte-identical copies of shared/compare-view.js', () => {
  const expected = fs.readFileSync(canonicalCompare, 'utf8');
  for (const file of compareCopies) {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, path.relative(root, file) + ' 与 shared/compare-view.js 不一致，请重新复制');
  }
});

// 主题切换同理：两端各存一份是打包结构决定的，但「PS 灰在某些 PS 上不生效」这种
// 只在一边复现的问题，两边代码一旦分叉就再也查不出来。
test('both host theme scripts are byte-identical copies of shared/theme.js', () => {
  const expected = fs.readFileSync(canonicalTheme, 'utf8');
  for (const file of themeCopies) {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, path.relative(root, file) + ' 与 shared/theme.js 不一致，请重新复制');
  }
});
