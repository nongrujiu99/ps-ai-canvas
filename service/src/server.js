'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const sharp = require('sharp');
const { validateJob, problem } = require('./contract');
const { decodeCapture, inspectImage, prepareExpansion, previewPng } = require('./image-inspection');
const { saneBounds, photoLikeBounds, deriveScales, rectifyExpandBounds } = require('./expand-compose');

// Origin 白名单匹配。三类规则，各有各的理由：
//   - 'null' 是浏览器 opaque origin 的字面值（部分 file:// 面板就是它），必须**精确**匹配。
//     以前用 startsWith('null')，畸形 Origin「null.evil.example」也能混进来。
//   - 以 '://' 结尾的是 scheme 前缀（plugin://、file://）。README 明确要求按前缀放行：
//     扩展 ID 会变，写死成 plugin://某ID 会让面板连不上服务。**裸前缀本身必须放行**——
//     CEP 面板（Chromium/CEF）跨域请求的 Origin 序列化就是裸 `file://`，UXP 面板是裸
//     `plugin://`；2026-11-17 曾把「前缀后必须有内容」当安全条件，结果面板全部 403
//     「不允许的请求来源」，是真实线上回归。畸形来源由 token 第二道防线兜底。
//   - 其余是精确条目（如测试里的 plugin://studio），一律精确匹配，不做前缀放宽。
function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true; // 非浏览器客户端没有 Origin，仍要过 X-STUDIO-Token 校验
  return allowedOrigins.some((allowed) => {
    if (allowed === 'null') return origin === 'null';
    // indexOf===0 允许裸前缀（origin === allowed）与带后缀的变体；不再要求 length>。
    if (/:\/\/$/.test(allowed)) return origin.indexOf(allowed) === 0;
    return origin === allowed;
  });
}

function createServer({ jobManager, credentialStore, channelStore, channelTester, allowedOrigins = [], clientToken, maxBodyBytes = 160 * 1024 * 1024 }) {
  if (!clientToken || typeof clientToken !== 'string') throw new Error('Local connection token is required');
  const expectedToken = Buffer.from(clientToken);
  function send(res, status, body, origin) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      const error = problem('CONTENT_TYPE', '请求类型必须为 JSON。');
      error.httpStatus = 415;
      throw error;
    }
    if (Number(req.headers['content-length']) > maxBodyBytes) {
      const error = problem('BODY_TOO_LARGE', '请求数据过大。');
      error.httpStatus = 413;
      throw error;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > maxBodyBytes) {
        const error = problem('BODY_TOO_LARGE', '请求数据过大。');
        error.httpStatus = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw problem('INVALID_JSON', '请求内容不是有效 JSON。'); }
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.url === '/health' && req.method === 'GET') {
      send(res, 200, { status: 'ok' });
      return;
    }
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
      send(res, 403, { code: 'FORBIDDEN', message: '不允许的请求来源。' });
      return;
    }
    if (req.method === 'OPTIONS') {
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-STUDIO-Client, X-STUDIO-Token', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const suppliedToken = Buffer.from(String(req.headers['x-studio-token'] || ''));
    if (req.headers['x-studio-client'] !== 'studio-plugin' || suppliedToken.length !== expectedToken.length || !timingSafeEqual(suppliedToken, expectedToken)) {
      send(res, 403, { code: 'FORBIDDEN', message: '本地连接码无效，请在插件设置中重新填写。' }, origin);
      return;
    }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      process.stderr.write('[req] ' + req.method + ' ' + path + '\n');
      if (req.method === 'POST' && path === '/v1/inspect') {
        const input = await readJson(req);
        const { pngBytes, maskBytes } = await decodeCapture(input.image, input.mask);
        const inspection = await inspectImage(pngBytes, maskBytes);
        process.stderr.write('[inspect] result=' + JSON.stringify(inspection) + '\n');
        if (input.context) process.stderr.write('[inspect] ps-context=' + JSON.stringify(input.context) + '\n');
        if (inspection.selectionKind === 'transparentBorder') {
          const expansion = await prepareExpansion(pngBytes, maskBytes, inspection);
          inspection.scales = { top: expansion.topScale, right: expansion.rightScale, bottom: expansion.bottomScale, left: expansion.leftScale };
          process.stderr.write('[inspect] expansion scales=' + JSON.stringify(inspection.scales) + '\n');
        } else {
          // 画布已有透明边时，扩图比例完全可以从「照片包围盒 vs 画布」推导，
          // 没必要依赖用户的选区。这样即使选区没框准，扩宽模式也能正常工作。
          // 范围优先用 Photoshop 给的 layerBounds：它不受照片边缘半透明的影响，
          // 而 alpha 反推一旦偏大，推导出的比例就会离谱（面板上出现「右 1398」这种值，
          // 就是因为推导失败后退回了用户手填的数字）。
          // 有 layerBounds 时也不再用「alpha 是否规则」当门槛——那是反推的前提，不是事实的前提。
          const canvas = { width: inspection.width, height: inspection.height };
          const psBounds = saneBounds(input.context && input.context.layerBounds, canvas);
          // 但 layerBounds 只是「活动图层的范围」，用户把活动层停在透明带、或者停在画面里
          // 某个小物件上时，它就不是原照片。photoLikeBounds 会把这层筛掉（判据：盖不住画面
          // 的不透明区就不是照片本体），筛掉后下面的候选会退回 alpha 包围盒。
          const trustedBounds = photoLikeBounds(psBounds, inspection.opaqueBounds);
          if (inspection.transparentBounds && (inspection.regularTransparency || trustedBounds)) {
            // 两套范围都试：先信 Photoshop 报的范围（它不受半透明描边影响），
            // 推不出合理比例时再退回逐像素反推的包围盒。只试一套的话，选出错误范围
            // 那一刻就只剩「放弃推导」一条路，面板会静静显示一个手填的默认值。
            //
            // 选定之后要把**这个范围本身**一起回给面板（expandBounds）。倍率和范围
            // 分头走完整个流程：倍率决定遮罩与贴回位置，范围决定「哪块是原图」。
            // 只回倍率时，面板仍会拿活动图层的范围去提交，两者一旦不一致，模型就会
            // 在错误的那一侧作画——呈现出来是一排竖条，而倍率看着完全正确。
            let picked = null;
            for (const candidate of [trustedBounds, inspection.opaqueBounds]) {
              const scales = deriveScales(candidate, canvas);
              if (scales) { picked = { scales, bounds: candidate }; break; }
            }
            if (picked) {
              inspection.expandScales = picked.scales;
              inspection.expandBounds = picked.bounds;
              process.stderr.write('[inspect] derived expandScales=' + JSON.stringify(picked.scales)
                + ' bounds=' + JSON.stringify(picked.bounds)
                + (picked.bounds === trustedBounds ? '（范围来自图层）' : '（范围来自透明区反推）') + '\n');
            } else {
              process.stderr.write('[inspect] no expandScales: lb=' + JSON.stringify(psBounds)
                + ' trusted=' + !!trustedBounds + ' opaque=' + JSON.stringify(inspection.opaqueBounds)
                + ' canvas=' + canvas.width + 'x' + canvas.height + '\n');
            }
          }
        }
        send(res, 200, inspection, origin);
        return;
      }
      if (req.method === 'POST' && path === '/v1/jobs') {
        const input = await readJson(req);
        const job = validateJob(input);
        const settings = await credentialStore.read();
        if (!settings || !settings.apiKey || !settings.workspaceId) {
          const error = problem('NOT_CONFIGURED', '请先设置百炼 API Key 和业务空间。');
          error.httpStatus = 409;
          throw error;
        }
        // 原图缩小版：面板要和生成结果叠放做前后对比。在这里留一张，是因为抓图
        // 已经解码过了；等结果出来再回头找原图，那时原始 data URL 早就随 capture 释放了。
        let originPreview = null;
        if (job.image) {
          const { pngBytes, maskBytes } = await decodeCapture(job.image, job.mask);
          originPreview = await previewPng(pngBytes);
          const inspected = await inspectImage(pngBytes, maskBytes);
          // 扩图提交的范围要在计费之前核一遍。活动图层停在画布底部那条透明带上时，
          // 这个范围同样「在画布内、够大、确实有新增区」，但它是画面的一角，不是原照片。
          // 拿它做遮罩和提示词，模型会在整块画面上作画，贴回来就是一条竖条纹。
          // 面板修好只覆盖新装的扩展；这里挡住旧面板，代价只有一次 alpha 反推。
          if (job.operation === 'expand' && !job.mask && job.canvasBounds) {
            const corrected = rectifyExpandBounds(job.canvasBounds, job.scales, { width: inspected.width, height: inspected.height }, inspected.opaqueBounds);
            if (corrected.left !== job.canvasBounds.left || corrected.top !== job.canvasBounds.top
              || corrected.right !== job.canvasBounds.right || corrected.bottom !== job.canvasBounds.bottom) {
              process.stderr.write('[jobs] 提交的照片范围 ' + JSON.stringify(job.canvasBounds)
                + ' 盖不住画面，已按倍率/透明区改为 ' + JSON.stringify(corrected) + '\n');
              job.canvasBounds = corrected;
            }
          }
          // 扩图带着 Photoshop 给的图层范围时，不必再拿「透明区是否规则」当门槛：
          // 范围是几何真值，「规则」只是 alpha 反推的前提条件。否则照片边缘带一圈描边
          // 就会被拦成「当前画面有不规则透明区域」，而用户其实什么都没做错。
          const trustBounds = job.operation === 'expand' && !!job.canvasBounds;
          if ((job.operation === 'editWhole' || (job.operation === 'expand' && !job.mask && !trustBounds)) && !inspected.regularTransparency) {
            throw problem('IRREGULAR_TRANSPARENCY', '当前画面有不规则透明区域，请先整理画布。');
          }
          if (job.operation === 'editMasked' && inspected.selectionKind !== 'inside') {
            throw problem('INVALID_SELECTION', '请选择画布内的编辑区域。');
          }
          if (job.operation === 'expand' && job.mask && inspected.selectionKind !== 'transparentBorder') {
            throw problem('INVALID_SELECTION', '请选择规则透明边缘。');
          }
        }
        send(res, 202, await jobManager.start(job, { origin: originPreview }), origin);
        return;
      }
      if (req.method === 'GET' && path === '/v1/channel' && channelStore) {
        send(res, 200, await channelStore.describe(), origin);
        return;
      }
      if (req.method === 'PUT' && path === '/v1/channel' && channelStore) {
        send(res, 200, await channelStore.save(await readJson(req)), origin);
        return;
      }
      // 只测不存：用户在设置页填完想先确认「这几项对不对」，不该逼他先保存。
      if (req.method === 'POST' && path === '/v1/channel/test' && channelStore && channelTester) {
        const draft = await channelStore.resolveDraft(await readJson(req));
        send(res, 200, await channelTester(draft), origin);
        return;
      }
      if (req.method === 'GET' && path === '/v1/settings/status') {
        const settings = await credentialStore.read();
        send(res, 200, { configured: !!(settings && settings.apiKey && settings.workspaceId), workspaceId: settings && settings.workspaceId || null }, origin);
        return;
      }
      if (req.method === 'PUT' && path === '/v1/settings/key') {
        const settings = await readJson(req);
        if (!settings || typeof settings.apiKey !== 'string' || !settings.apiKey.trim() || typeof settings.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(settings.workspaceId)) {
          throw problem('INVALID_SETTINGS', 'API Key 或业务空间 ID 无效。');
        }
        await credentialStore.save({ apiKey: settings.apiKey.trim(), workspaceId: settings.workspaceId });
        send(res, 200, { configured: true, workspaceId: settings.workspaceId }, origin);
        return;
      }
      const result = /^\/v1\/results\/([0-9a-f-]+)\/(\d+)(\/raw)?$/.exec(path);
      if (req.method === 'GET' && result) {
        const bytes = jobManager.getResult(result[1], Number(result[2]));
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Cache-Control', 'no-store');
        if (result[3]) {
          const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Expose-Headers': 'X-Image-Width, X-Image-Height, X-Image-Components', 'X-Image-Width': info.width, 'X-Image-Height': info.height, 'X-Image-Components': 4 });
          res.end(data);
        } else {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(bytes);
        }
        return;
      }
      // 「原图」对照图。和 /v1/results 一样是 PNG 二进制，只是不参与计费、
      // 也不随任务失败消失——图生成失败时，用户反而更想看看底稿长什么样。
      const originPath = /^\/v1\/jobs\/([0-9a-f-]+)\/origin$/.exec(path);
      if (req.method === 'GET' && originPath) {
        const bytes = jobManager.getOrigin(originPath[1]);
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(bytes);
        return;
      }
      const recoverPath = /^\/v1\/jobs\/([0-9a-f-]+)\/recover$/.exec(path);
      if (recoverPath && req.method === 'POST') {
        send(res, 200, await jobManager.recover(recoverPath[1]), origin);
        return;
      }
      const jobPath = /^\/v1\/jobs\/([0-9a-f-]+)$/.exec(path);
      if (jobPath && req.method === 'GET') {
        send(res, 200, jobManager.get(jobPath[1]), origin);
        return;
      }
      if (jobPath && req.method === 'DELETE') {
        send(res, 200, jobManager.cancelWait(jobPath[1]), origin);
        return;
      }
      send(res, 404, { code: 'NOT_FOUND', message: '找不到接口。' }, origin);
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error && error.code || '') ? error.code : 'INTERNAL_ERROR';
      const message = code === 'INTERNAL_ERROR' ? '本地服务处理失败。' : error.message;
      const status = error.httpStatus || (code === 'BODY_TOO_LARGE' ? 413 : code === 'CONTENT_TYPE' ? 415 : 400);
      process.stderr.write('[error] ' + req.method + ' ' + path + ' -> ' + code + ': ' + message + '\n');
      send(res, status, { code, message }, origin);
    }
  });
}

module.exports = { createServer, isAllowedOrigin };
