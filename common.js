// Vexto Connect 共享模块：默认设置、校验、HTTP 请求与中文错误文案。
// 同时被 service worker（importScripts）和选项页（<script>）加载，不依赖构建。

"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  host: "127.0.0.1",
  port: 29110,
  secret: "",
});

const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost"]);
const CLIENT_HEADER = "X-Rayburst-Client";
const CLIENT_VALUE = "rayburst-connect";
const PROBE_TIMEOUT_MS = 3000;
const ADD_TIMEOUT_MS = 5000;

function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const port = Number(src.port);
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
  };
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

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    settings: {
      enabled: Boolean(input?.enabled),
      host: host || DEFAULT_SETTINGS.host,
      port: Number.isInteger(port) ? port : DEFAULT_SETTINGS.port,
      secret: String(input?.secret ?? "").trim(),
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
    default:
      return `Vexto 返回 HTTP ${status}。`;
  }
}
