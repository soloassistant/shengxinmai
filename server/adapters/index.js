/* ==========================================================================
   省心买 · 适配器注册表与调度
   --------------------------------------------------------------------------
   职责：把「有哪些平台」「哪些配了密钥」「并发去问」「结果归一化排序」收在一处。
   加新平台只需要写一个 adapter 文件，然后加进 ADAPTERS 数组。
   ========================================================================== */

'use strict';

const dataoke = require('./dataoke');
const jd      = require('./jd');
const pdd     = require('./pdd');

const ADAPTERS = [dataoke, jd, pdd];

/** 每个平台的配置状态，给前端和 /api/health 用 */
function status(env) {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    platform: a.platform,
    doc: a.doc,
    note: a.note,
    envKeys: a.envKeys,
    configured: a.isConfigured(env)
  }));
}

/**
 * 并发问所有已配置的平台，归一化后按最低到手价排序。
 *
 * 设计原则：单个平台挂掉绝不能拖垮整体 —— 所以每个 adapter 的异常都在这里被吃掉，
 * 变成一条 note 返回给前端，而不是 500。
 */
async function compare(keyword, env, opts = {}) {
  const keep = opts.keep || 8;
  // opts.adapters 只为测试存在：不注入就用真实注册表
  const registry = opts.adapters || ADAPTERS;
  const active = registry.filter((a) => a.isConfigured(env));
  const idle   = registry.filter((a) => !a.isConfigured(env));

  const results = await Promise.all(active.map(async (a) => {
    const started = Date.now();
    const base = { id: a.id, name: a.name, platform: a.platform };
    try {
      const r = await a.search(keyword, env, opts);
      const items = (r.items || [])
        .slice()
        .sort((x, y) => (x.final == null ? Infinity : x.final) - (y.final == null ? Infinity : y.final));
      return {
        ...base, ok: true,
        count: items.length,
        ms: Date.now() - started,
        lowest: items[0] || null,
        items: items.slice(0, keep),
        note: r.note || '',
        rawSample: r.rawSample || null
      };
    } catch (e) {
      return {
        ...base, ok: false, count: 0, lowest: null, items: [],
        ms: Date.now() - started,
        note: '适配器异常：' + String((e && e.message) || e)
      };
    }
  }));

  results.sort((a, b) => {
    const av = a.lowest && a.lowest.final != null ? a.lowest.final : Infinity;
    const bv = b.lowest && b.lowest.final != null ? b.lowest.final : Infinity;
    return av - bv;
  });

  return {
    query: keyword,
    at: Date.now(),
    platforms: results,
    unconfigured: idle.map((a) => ({ id: a.id, name: a.name, envKeys: a.envKeys, doc: a.doc })),
    disclaimer:
      '各家联盟只返回「商家已设置推广佣金」的商品，不等于平台全量商品；' +
      '不同平台搜出来的也可能是不同型号（容量 / 版本有差异）。' +
      '这是「各平台搜索最低价对照」，不是严格同款比价——下单前请自己确认型号。'
  };
}

module.exports = { ADAPTERS, status, compare };
