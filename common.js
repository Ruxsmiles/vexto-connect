// Vexto Connect 共享模块：默认设置、校验、HTTP 请求与中文错误文案。
// 同时被 service worker（importScripts）和选项页（<script>）加载，不依赖构建。

"use strict";

const DEFAULT_SITE_RULES = Object.freeze({
  allow: Object.freeze([]),
  block: Object.freeze([]),
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  host: "127.0.0.1",
  port: 29110,
  secret: "",
  autoTakeover: false,
  forwardHeaders: true,
  forwardCookies: false,
  minimumSizeMb: 0,
  unknownSizeTakeover: true,
  duplicateWindowSeconds: 10,
  siteRules: DEFAULT_SITE_RULES,
});

const SITE_RULE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost"]);
const CLIENT_HEADER = "X-Rayburst-Client";
const CLIENT_VALUE = "rayburst-connect";
const VEXTO_CLIENT_VERSION =
  typeof chrome !== "undefined" && chrome.runtime?.getManifest
    ? chrome.runtime.getManifest().version
    : "0.4.0";
const VEXTO_CLIENT = `connect/${VEXTO_CLIENT_VERSION}`;
const PROTOCOL_MODE_KEY = "protocolMode";
const PROTOCOL_MODE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;
const ADD_TIMEOUT_MS = 5000;

function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const port = Number(src.port);
  const minSize = Number(src.minimumSizeMb);
  const dupWindow = Number(src.duplicateWindowSeconds);
  const rules =
    src.siteRules && typeof src.siteRules === "object" && !Array.isArray(src.siteRules)
      ? src.siteRules
      : {};
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SETTINGS.enabled,
    host:
      typeof src.host === "string" && src.host.trim()
        ? src.host.trim().toLowerCase()
        : DEFAULT_SETTINGS.host,
    port:
      Number.isInteger(port) && port >= 1024 && port <= 65535
        ? port
        : DEFAULT_SETTINGS.port,
    secret: typeof src.secret === "string" ? src.secret.trim() : DEFAULT_SETTINGS.secret,
    autoTakeover:
      typeof src.autoTakeover === "boolean" ? src.autoTakeover : DEFAULT_SETTINGS.autoTakeover,
    forwardHeaders:
      typeof src.forwardHeaders === "boolean"
        ? src.forwardHeaders
        : DEFAULT_SETTINGS.forwardHeaders,
    forwardCookies:
      typeof src.forwardCookies === "boolean"
        ? src.forwardCookies
        : DEFAULT_SETTINGS.forwardCookies,
    minimumSizeMb:
      Number.isFinite(minSize) && minSize >= 0 ? minSize : DEFAULT_SETTINGS.minimumSizeMb,
    unknownSizeTakeover:
      typeof src.unknownSizeTakeover === "boolean"
        ? src.unknownSizeTakeover
        : DEFAULT_SETTINGS.unknownSizeTakeover,
    duplicateWindowSeconds:
      Number.isInteger(dupWindow) && dupWindow >= 0
        ? dupWindow
        : DEFAULT_SETTINGS.duplicateWindowSeconds,
    siteRules: {
      allow: Array.isArray(rules.allow)
        ? rules.allow.filter((rule) => typeof rule === "string" && rule)
        : [],
      block: Array.isArray(rules.block)
        ? rules.block.filter((rule) => typeof rule === "string" && rule)
        : [],
    },
  };
}

// 站点规则：域名后缀匹配（example.com 同时匹配 sub.example.com）。
// 用户输入里允许带协议、路径、端口和 *. 前缀，统一归一化成域名。
function normalizeSiteRule(raw) {
  let rule = String(raw ?? "").trim().toLowerCase();
  rule = rule.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  rule = rule.split("/")[0];
  rule = rule.split(":")[0];
  rule = rule.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return rule;
}

function isValidSiteRule(rule) {
  return rule.length > 0 && rule.length <= 253 && SITE_RULE_RE.test(rule);
}

function parseSiteRules(text) {
  const rules = [];
  const invalid = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const rule = normalizeSiteRule(line);
    if (!isValidSiteRule(rule)) {
      invalid.push(line);
    } else if (!rules.includes(rule)) {
      rules.push(rule);
    }
  }
  return { rules, invalid };
}

function matchesSiteRule(hostname, rule) {
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 表单校验：返回 { ok, errors, settings }。errors 按字段给出中文原因。
function validateSettings(input) {
  const errors = {};
  const host = String(input?.host ?? "").trim().toLowerCase();
  if (!host) {
    errors.host = "请填写主机地址。";
  } else if (!LOOPBACK_HOSTS.includes(host)) {
    errors.host = "只允许本机回环地址：127.0.0.1 或 localhost。";
  }

  const portRaw = String(input?.port ?? "").trim();
  const port = Number(portRaw);
  if (!portRaw) {
    errors.port = "请填写端口。";
  } else if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    errors.port = "端口必须是 1024–65535 之间的整数。";
  }

  const minRaw = String(input?.minimumSizeMb ?? "").trim();
  const minSize = minRaw === "" ? 0 : Number(minRaw);
  if (!Number.isFinite(minSize) || minSize < 0) {
    errors.minimumSizeMb = "最小文件大小必须是不小于 0 的数字（MB）。";
  }

  const dupRaw = String(input?.duplicateWindowSeconds ?? "").trim();
  const dupWindow = dupRaw === "" ? 0 : Number(dupRaw);
  if (!Number.isInteger(dupWindow) || dupWindow < 0) {
    errors.duplicateWindowSeconds = "重复保护窗口必须是不小于 0 的整数（秒）。";
  }

  const allow = parseSiteRules(input?.allowSitesText ?? "");
  const block = parseSiteRules(input?.blockSitesText ?? "");
  if (allow.invalid.length) {
    errors.allowSites = `无法识别的域名：${allow.invalid.slice(0, 3).join("、")}`;
  }
  if (block.invalid.length) {
    errors.blockSites = `无法识别的域名：${block.invalid.slice(0, 3).join("、")}`;
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    settings: {
      enabled: Boolean(input?.enabled),
      host: host || DEFAULT_SETTINGS.host,
      port: Number.isInteger(port) ? port : DEFAULT_SETTINGS.port,
      secret: String(input?.secret ?? "").trim(),
      autoTakeover: Boolean(input?.autoTakeover),
      forwardHeaders: input?.forwardHeaders !== false,
      forwardCookies: Boolean(input?.forwardCookies),
      minimumSizeMb: Number.isFinite(minSize) && minSize >= 0 ? minSize : DEFAULT_SETTINGS.minimumSizeMb,
      unknownSizeTakeover: input?.unknownSizeTakeover !== false,
      duplicateWindowSeconds:
        Number.isInteger(dupWindow) && dupWindow >= 0
          ? dupWindow
          : DEFAULT_SETTINGS.duplicateWindowSeconds,
      siteRules: { allow: allow.rules, block: block.rules },
    },
  };
}

function buildBaseUrl(settings) {
  return `http://${settings.host}:${settings.port}`;
}

function vextoHeaders(settings, withJson = false) {
  const headers = { [CLIENT_HEADER]: CLIENT_VALUE };
  if (withJson) headers["Content-Type"] = "application/json";
  if (settings.secret) headers.Authorization = `Bearer ${settings.secret}`;
  return headers;
}

function v1Headers(settings, withJson = false) {
  const headers = { "X-Vexto-Client": VEXTO_CLIENT };
  if (withJson) headers["Content-Type"] = "application/json";
  if (settings.secret) headers.Authorization = `Bearer ${settings.secret}`;
  return headers;
}

async function vextoFetch(settings, path, options = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = PROBE_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${buildBaseUrl(settings)}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 协议模式缓存：有 /v1 时优先，否则回落兼容接口。缓存 5 分钟。
async function readProtocolMode() {
  try {
    const stored = await chrome.storage.session.get(PROTOCOL_MODE_KEY);
    const mode = stored[PROTOCOL_MODE_KEY];
    if (mode && Date.now() - mode.at < PROTOCOL_MODE_TTL_MS) return mode;
  } catch {
    // 没有缓存就按兼容接口
  }
  return null;
}

async function writeProtocolMode(mode, protocol) {
  const entry = { mode, protocol, at: Date.now() };
  try {
    await chrome.storage.session.set({ [PROTOCOL_MODE_KEY]: entry });
  } catch {
    // 缓存失败不影响交接
  }
  return entry;
}

async function detectV1(settings, timeoutMs = 1500) {
  try {
    const response = await vextoFetch(settings, "/v1/ping", {
      headers: { "X-Vexto-Client": VEXTO_CLIENT },
      timeoutMs,
    });
    if (!response.ok) return null;
    const body = await readJson(response);
    if (body && typeof body.protocol === "number" && body.protocol >= 1) return body;
    return null;
  } catch {
    return null;
  }
}

function describeNetworkError(error, settings, timeoutMs = PROBE_TIMEOUT_MS) {
  const target = `${settings.host}:${settings.port}`;
  if (error && error.name === "AbortError") {
    return `连接超时：${target} 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应。Vexto 可能卡住，或端口被其他程序占用。`;
  }
  if (error instanceof TypeError) {
    return `无法连接 ${target}：Vexto 未运行，或端口未监听（连接被拒绝）。请确认 Vexto 在托盘运行、插件接管已开启。`;
  }
  return `请求失败：${error?.message || String(error)}`;
}

function describeHttpError(status) {
  switch (status) {
    case 401:
      return "密钥不一致（401）：请确认扩展与 Vexto「插件密钥」完全相同；两边都为空也算一致。";
    case 403:
      return "请求被拒绝（403）：Vexto 不接受该请求来源或客户端标识。";
    case 404:
      return "接口不存在（404）：端口上的服务可能不是 Vexto，或 Vexto 版本过旧。";
    case 426:
      return "协议不兼容（426）：请升级 Vexto 或扩展。";
    default:
      return `Vexto 返回 HTTP ${status}。`;
  }
}
