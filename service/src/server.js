'use strict';

const http = require('node:http');
const sharp = require('sharp');
const { validateJob, problem } = require('./contract');
const { decodeCapture, inspectImage, prepareExpansion } = require('./image-inspection');

function createServer({ jobManager, credentialStore, allowedOrigins = [], maxBodyBytes = 100 * 1024 * 1024 }) {
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
    if (origin && !allowedOrigins.includes(origin)) {
      send(res, 403, { code: 'FORBIDDEN', message: '不允许的请求来源。' });
      return;
    }
    if (req.method === 'OPTIONS') {
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-PSAI-Client', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.headers['x-psai-client'] !== 'ps-ai-plugin') {
      send(res, 403, { code: 'FORBIDDEN', message: '缺少插件请求标识。' }, origin);
      return;
    }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      if (req.method === 'POST' && path === '/v1/inspect') {
        const input = await readJson(req);
        const { pngBytes, maskBytes } = await decodeCapture(input.image, input.mask);
        const inspection = await inspectImage(pngBytes, maskBytes);
        if (inspection.selectionKind === 'transparentBorder') {
          const expansion = await prepareExpansion(pngBytes, maskBytes);
          inspection.scales = { top: expansion.topScale, right: expansion.rightScale, bottom: expansion.bottomScale, left: expansion.leftScale };
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
        if (job.image) {
          const { pngBytes, maskBytes } = await decodeCapture(job.image, job.mask);
          const inspected = await inspectImage(pngBytes, maskBytes);
          if (job.operation === 'editMasked' && inspected.selectionKind !== 'inside') {
            throw problem('INVALID_SELECTION', '请选择画布内的编辑区域。');
          }
          if (job.operation === 'expand' && job.mask && inspected.selectionKind !== 'transparentBorder') {
            throw problem('INVALID_SELECTION', '请选择规则透明边缘。');
          }
        }
        send(res, 202, await jobManager.start(job), origin);
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
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Image-Width': info.width, 'X-Image-Height': info.height, 'X-Image-Components': 4 });
          res.end(data);
        } else {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(bytes);
        }
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
      send(res, status, { code, message }, origin);
    }
  });
}

module.exports = { createServer };
