#!/usr/bin/env node
/**
 * 心情/记忆小窗 · 本地查看器
 *
 * 零依赖：只用 Node 内置模块。读一个 JSON 状态文件，用浏览器打开看。
 *
 *   node server.mjs --file ./demo-state.json --port 3310 --open
 *
 * 支持两种数据格式（自动识别）：
 *
 *  1) 通用格式（推荐，第三方直接用这个）
 *     {
 *       "conversations": {
 *         "private:123": {
 *           "mood": { "total": 72.5, "dims": { "开心": 3.1, ... } },
 *           "memory": {
 *             "importantTopics": [{ "text": "...", "keys": ["猫"], "mentions": 2, "lastMentionAt": 1700000000000 }],
 *             "activeTopics": [...],
 *             "memberImpressions": { "阿橙": { "traits": ["嘴硬"], "interactionCount": 3, "lastSeenAt": 1700000000000 } }
 *           }
 *         }
 *       }
 *     }
 *
 *  2) qq-bridge 的 state 文件（social-v2.json）——容器字段直接平铺在会话上
 *
 * 用法示例：
 *   node server.mjs --file "C:/path/to/social-v2.json"
 *   node server.mjs --file ./state.json --port 4000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const fileArg = arg('file', '');
const port = Number(arg('port', process.env.VIEWER_PORT || 3310));
const shouldOpen = argv.includes('--open');

if (!fileArg || fileArg === true) {
  console.error('');
  console.error('用法：node server.mjs --file <状态文件.json> [--port 3310] [--open]');
  console.error('');
  console.error('  例：node server.mjs --file ./demo-state.json --open');
  console.error('      node server.mjs --file "C:/.../qq-bridge/state/social-v2.json" --open');
  console.error('');
  process.exit(1);
}

const STATE_FILE = path.resolve(String(fileArg));

// ---------- 数据整形 ----------
const DIMS = ['开心', '踏实', '甜蜜', '心疼', '担心', '难过', '吃醋'];

function pickList(x) {
  return Array.isArray(x) ? x.filter((it) => it && it.text) : [];
}

/** 把任意格式整成 viewer 用的统一结构 */
function normalize(raw) {
  const convs = raw && typeof raw === 'object' ? raw.conversations || raw : {};
  const out = {};

  // 单会话兜底：顶层直接就是一条会话
  if (raw && (raw.importantTopics || raw.activeTopics || raw.mood) && !raw.conversations) {
    out['default'] = one(raw);
  } else {
    for (const [key, c] of Object.entries(convs)) {
      if (!c || typeof c !== 'object') continue;
      out[key] = one(c);
    }
  }
  return { ok: true, updatedAt: Date.now(), conversations: out };

  function one(c) {
    const mem = c.memory && typeof c.memory === 'object' ? c.memory : c; // bridge 是平铺的
    const mood = c.mood && typeof c.mood === 'object' ? c.mood : null;
    const dims = {};
    for (const d of DIMS) dims[d] = Number(mood?.dims?.[d] ?? 0);
    return {
      mood: mood ? { total: Number(mood.total) || 0, dims, updatedAt: Number(mood.updatedAt) || 0 } : null,
      importantTopics: pickList(mem.importantTopics).map(item),
      activeTopics: pickList(mem.activeTopics).map(item),
      gameSkills: pickList(mem.gameSkills).map(skill),
      memberImpressions: mem.memberImpressions && typeof mem.memberImpressions === 'object' ? Object.fromEntries(
        Object.entries(mem.memberImpressions).map(([name, im]) => [name, {
          traits: (Array.isArray(im?.traits) ? im.traits : []).map((t) => (typeof t === 'string' ? t : t?.text || '')).filter(Boolean),
          interactionCount: Number(im?.interactionCount) || 0,
          lastSeenAt: Number(im?.lastSeenAt) || 0
        }])
      ) : {}
    };
  }

  function item(x) {
    return {
      text: String(x.text || '').slice(0, 300),
      keys: Array.isArray(x.keys) ? x.keys.map(String) : [],
      mentions: Number(x.mentions) || 1,
      lastMentionAt: Number(x.lastMentionAt || x.createdAt) || 0
    };
  }

  function skill(x) {
    return {
      game: String(x.game || '').slice(0, 20),
      skill: String(x.skill || '').slice(0, 30),
      text: String(x.text || '').slice(0, 300),
      keys: Array.isArray(x.keys) ? x.keys.map(String) : [],
      action: String(x.action || '').slice(0, 20),
      uses: Number(x.uses) || 0,
      lastUsedAt: Number(x.lastUsedAt) || 0,
      createdAt: Number(x.createdAt) || 0
    };
  }
}

function loadState() {
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  return normalize(JSON.parse(raw));
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, body, type) => {
    res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  if (url.pathname === '/api/state') {
    try {
      send(200, JSON.stringify(loadState()));
    } catch (e) {
      send(500, JSON.stringify({ ok: false, error: String(e.message || e), file: STATE_FILE }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      send(200, fs.readFileSync(path.join(HERE, 'viewer.html'), 'utf8'), 'text/html; charset=utf-8');
    } catch (e) {
      send(500, 'viewer.html 缺失：' + e.message, 'text/plain; charset=utf-8');
    }
    return;
  }

  if (url.pathname === '/favicon.ico') { send(204, ''); return; }
  send(404, JSON.stringify({ ok: false, error: 'not found' }));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，换一个：node server.mjs --file ... --port 3311`);
  } else {
    console.error('启动失败：', e.message);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  心情小窗已启动');
  console.log('  数据文件：' + STATE_FILE);
  console.log('  打开地址：' + url);
  console.log('  （Ctrl+C 退出）');
  console.log('');
  if (shouldOpen) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* 忽略 */ }
  }
});
