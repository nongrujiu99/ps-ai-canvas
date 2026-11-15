'use strict';

// 带过期回收的 Map。
//
// 本地服务是常驻进程：任务结果、同步出图的缓存都是画布尺寸的 PNG Buffer
// （常见每张 5~15 MB）。这些缓存以前只在「用户正好取走」时才 delete，
// 一旦用户取消、关掉面板或走了另一条分支，条目就永远留在内存里——
// 用一下午之后服务越来越占内存，重启才恢复，原因就是这个。
//
// 这里给每个 key 挂一个定时器，到点无条件清掉；定时器 unref()，
// 免得一堆待回收的缓存把进程退出也拖住。
function createTtlMap({ ttlMs = 10 * 60 * 1000 } = {}) {
  const items = new Map();
  const timers = new Map();

  function arm(key) {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      items.delete(key);
      timers.delete(key);
    }, ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(key, timer);
  }

  return {
    get(key) { return items.get(key); },
    has(key) { return items.has(key); },
    set(key, value) { items.set(key, value); arm(key); return value; },
    delete(key) {
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
      return items.delete(key);
    },
    get size() { return items.size; },
  };
}

module.exports = { createTtlMap };
