// Vexto Connect 选项页：读取 / 校验 / 保存设置，测试与 Vexto 的连接。

"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  enabled: $("enabled"),
  autoTakeover: $("autoTakeover"),
  host: $("host"),
  port: $("port"),
  secret: $("secret"),
  forwardHeaders: $("forwardHeaders"),
  forwardCookies: $("forwardCookies"),
  cookieHint: $("cookie-hint"),
  grantCookies: $("grantCookies"),
  hideDownloadUi: $("hideDownloadUi"),
  hideDownloadUiRow: $("hideDownloadUiRow"),
  downloadUiHint: $("download-ui-hint"),
  grantDownloadUi: $("grantDownloadUi"),
  minimumSizeMb: $("minimumSizeMb"),
  unknownSizeTakeover: $("unknownSizeTakeover"),
  duplicateWindowSeconds: $("duplicateWindowSeconds"),
  allowSites: $("allowSites"),
  blockSites: $("blockSites"),
  save: $("save"),
  test: $("test"),
  status: $("status"),
  diagRefresh: $("diag-refresh"),
  diagClear: $("diag-clear"),
  diagnostics: $("diagnostics"),
  nav: $("nav"),
  paneTitle: $("pane-title"),
  paneDesc: $("pane-desc"),
  appVersion: $("app-version"),
  liveDot: $("live-dot"),
  liveLabel: $("live-label"),
  liveReason: $("live-reason"),
  liveVersion: $("live-version"),
  liveEngine: $("live-engine"),
  liveProtocol: $("live-protocol"),
  liveEndpoint: $("live-endpoint"),
  liveChecked: $("live-checked"),
  liveRefresh: $("live-refresh"),
  miniStatus: $("mini-status"),
  miniDot: $("mini-dot"),
  miniLabel: $("mini-label"),
  miniEndpoint: $("mini-endpoint"),
  actionbar: $("actionbar"),
};

const ERROR_FIELDS = [
  "host",
  "port",
  "minimumSizeMb",
  "duplicateWindowSeconds",
  "allowSites",
  "blockSites",
];
const COOKIE_ORIGINS = ["*://*/*"];
const DOWNLOAD_UI_PERMISSION = { permissions: ["downloads.ui"] };

let busy = false;
let cookieHostGranted = false;
let downloadUiGranted = false;
let downloadUiSupported = true;
let savedSnapshot = null;
let dirty = false;

function readForm() {
  return {
    enabled: els.enabled.checked,
    autoTakeover: els.autoTakeover.checked,
    host: els.host.value,
    port: els.port.value,
    secret: els.secret.value,
    forwardHeaders: els.forwardHeaders.checked,
    forwardCookies: els.forwardCookies.checked,
    minimumSizeMb: els.minimumSizeMb.value,
    unknownSizeTakeover: els.unknownSizeTakeover.checked,
    duplicateWindowSeconds: els.duplicateWindowSeconds.value,
    hideDownloadUi: els.hideDownloadUi.checked,
    allowSitesText: els.allowSites.value,
    blockSitesText: els.blockSites.value,
  };
}

function render(settings) {
  els.enabled.checked = settings.enabled;
  els.autoTakeover.checked = settings.autoTakeover;
  els.host.value = settings.host;
  els.port.value = String(settings.port);
  els.secret.value = settings.secret;
  els.forwardHeaders.checked = settings.forwardHeaders;
  els.forwardCookies.checked = settings.forwardCookies;
  els.minimumSizeMb.value = String(settings.minimumSizeMb);
  els.unknownSizeTakeover.checked = settings.unknownSizeTakeover;
  els.duplicateWindowSeconds.value = String(settings.duplicateWindowSeconds);
  els.hideDownloadUi.checked = settings.hideDownloadUi;
  els.allowSites.value = settings.siteRules.allow.join("\n");
  els.blockSites.value = settings.siteRules.block.join("\n");
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function formSnapshot() {
  return JSON.stringify(readForm());
}

function refreshSaveState() {
  els.save.disabled = busy || !dirty;
}

function updateDirtyState() {
  const next = savedSnapshot !== null && formSnapshot() !== savedSnapshot;
  if (next === dirty) return;
  dirty = next;
  refreshSaveState();
}

function setBusy(value) {
  busy = value;
  refreshSaveState();
  els.test.disabled = value;
  els.test.textContent = value ? "测试中…" : "测试连接";
}

function clearFieldError(field) {
  const input = els[field];
  input.classList.remove("invalid");
  input.removeAttribute("aria-invalid");
  const errorEl = $(`${field}-error`);
  errorEl.textContent = "";
  errorEl.hidden = true;
}

function showFieldErrors(errors) {
  for (const field of ERROR_FIELDS) {
    const input = els[field];
    const errorEl = $(`${field}-error`);
    const message = errors[field];
    if (message) {
      input.classList.add("invalid");
      input.setAttribute("aria-invalid", "true");
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      clearFieldError(field);
    }
  }
}

function refreshCookieHint() {
  if (!els.forwardCookies.checked) {
    els.cookieHint.textContent =
      "默认关闭；开启后会把登录态交给本机 Vexto，首次开启需要授权全站 Cookie。";
  } else if (cookieHostGranted) {
    els.cookieHint.textContent =
      "已授权全站 Cookie（仅在开启时读取，并只发送给本机 Vexto）。";
  } else {
    els.cookieHint.textContent =
      "尚未授权全站 Cookie：保存时会请求权限；未授权时 Cookie 转发会保持关闭。";
  }
  els.grantCookies.hidden = !els.forwardCookies.checked || cookieHostGranted;
}

async function loadCookiePermission() {
  try {
    cookieHostGranted = await ext.permissions.contains({ origins: COOKIE_ORIGINS });
  } catch (error) {
    cookieHostGranted = false;
    console.warn("检查 Cookie 权限失败：", error);
  }
  refreshCookieHint();
}

function refreshDownloadUiHint() {
  if (!els.hideDownloadUi.checked) {
    els.downloadUiHint.textContent =
      "开启后仅在接管尝试期间隐藏下载列表/气泡；回落到浏览器下载时会恢复显示。首次开启需要授权「下载 UI」权限。";
  } else if (downloadUiGranted) {
    els.downloadUiHint.textContent = "已授权：接管尝试期间隐藏下载列表，结束后恢复。";
  } else {
    els.downloadUiHint.textContent =
      "尚未授权「下载 UI」权限：保存时会请求权限；未授权时不会隐藏下载列表。";
  }
  els.grantDownloadUi.hidden = !els.hideDownloadUi.checked || downloadUiGranted;
}

async function loadDownloadUiPermission() {
  const supported = typeof chrome.downloads?.setUiOptions === "function";
  downloadUiSupported = supported;
  els.hideDownloadUiRow.hidden = !supported;
  els.downloadUiHint.hidden = !supported;
  if (!supported) {
    downloadUiGranted = false;
    els.grantDownloadUi.hidden = true;
    return;
  }
  try {
    downloadUiGranted = await ext.permissions.contains(DOWNLOAD_UI_PERMISSION);
  } catch (error) {
    downloadUiGranted = false;
    console.warn("检查下载 UI 权限失败：", error);
  }
  refreshDownloadUiHint();
}

const DIAG_SOURCE_LABELS = { auto: "自动", manual: "手动" };
const DIAG_OUTCOME_LABELS = {
  accepted: "已接管",
  fallback: "已回落",
  skipped: "已跳过",
  error: "失败",
  recovered: "已恢复",
};
const DIAG_REASON_LABELS = {
  "site-block": "站点排除",
  "site-allow": "不在允许列表",
  size: "小于最小大小",
  "size-unknown": "大小未知",
  duplicate: "重复下载",
  network: "网络失败",
  rejected: "Vexto 拒绝",
};
const DIAG_BROWSER_LABELS = {
  canceled: "浏览器已取消",
  removed: "浏览器文件已删除",
  "cancel-failed": "浏览器取消失败",
  "remove-failed": "浏览器删除失败",
  "already-gone": "浏览器已无记录",
  "search-failed": "浏览器查询失败",
};

function renderDiagnostics(list) {
  if (!Array.isArray(list) || !list.length) {
    els.diagnostics.textContent = "暂无诊断事件。开启自动接管并下载一次后，这里会出现记录。";
    return;
  }
  const lines = list.map((event) => {
    const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    const parts = [
      time,
      DIAG_SOURCE_LABELS[event.source] || event.source || "-",
      DIAG_OUTCOME_LABELS[event.outcome] || event.outcome || "-",
    ];
    if (event.host) parts.push(event.host);
    if (event.reason) parts.push(DIAG_REASON_LABELS[event.reason] || event.reason);
    if (event.browser) parts.push(DIAG_BROWSER_LABELS[event.browser] || event.browser);
    if (event.protocol) parts.push(event.protocol === "v1" ? "协议 v1" : "协议 兼容");
    if (typeof event.count === "number") parts.push(`${event.count} 条`);
    return parts.join(" · ");
  });
  els.diagnostics.textContent = lines.join("\n");
}

async function loadDiagnostics() {
  try {
    const stored = await ext.storage.session.get("diagnostics");
    renderDiagnostics(stored.diagnostics);
  } catch (error) {
    els.diagnostics.textContent = `读取诊断失败：${error?.message || error}`;
  }
}

async function clearDiagnostics() {
  try {
    await ext.storage.session.remove("diagnostics");
    renderDiagnostics([]);
    setStatus("诊断已清空。", "");
  } catch (error) {
    setStatus(`清空诊断失败：${error?.message || error}`, "bad");
  }
}

// ── 分区导航 ────────────────────────────────────────────

const PANES = {
  connection: { title: "连接", desc: "配置 Vexto 本机接口，并查看实时连接状态。" },
  auto: { title: "自动接管", desc: "把浏览器下载交给 Vexto，失败时恢复浏览器下载。" },
  transfer: { title: "转发与过滤", desc: "控制交接时附带的信息，以及自动接管的过滤规则。" },
  sites: { title: "站点规则", desc: "按域名决定哪些下载交给 Vexto。" },
  diagnostics: { title: "诊断", desc: "查看最近的交接结果，排查失败原因。" },
};

function paneFromHash() {
  const name = location.hash.replace(/^#/, "");
  return PANES[name] ? name : "connection";
}

function showPane(name, { updateHash = true, focus = false } = {}) {
  if (!PANES[name]) name = "connection";

  for (const item of document.querySelectorAll(".nav-item")) {
    const active = item.dataset.pane === name;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
    if (active && focus) item.focus();
  }
  for (const pane of document.querySelectorAll(".pane")) {
    pane.hidden = pane.id !== `pane-${name}`;
  }

  els.paneTitle.textContent = PANES[name].title;
  els.paneDesc.textContent = PANES[name].desc;
  els.actionbar.hidden = name === "diagnostics";
  if (updateHash && location.hash !== `#${name}`) {
    history.replaceState(null, "", `#${name}`);
  }
  if (name === "diagnostics") void loadDiagnostics();
}

// ── 实时连接状态 ────────────────────────────────────────

const LIVE_INTERVAL_MS = 8000;
const LIVE_TIMEOUT_MS = 3000;
let liveBusy = false;
let liveTimer = null;

function setDot(el, state) {
  el.classList.remove("ok", "bad", "warn", "checking");
  if (state) el.classList.add(state);
}

function setLiveState(state, detail = {}) {
  const dotClass =
    { connected: "ok", disconnected: "bad", warning: "warn", checking: "checking" }[state] || "";
  setDot(els.liveDot, dotClass);
  setDot(els.miniDot, dotClass);

  const label = detail.label || "未知";
  els.liveLabel.textContent = label;
  els.miniLabel.textContent = label;
  els.liveReason.textContent = detail.reason || "";

  if ("version" in detail) els.liveVersion.textContent = detail.version || "—";
  if ("engine" in detail) {
    els.liveEngine.textContent =
      detail.engine === "running" ? "就绪" : detail.engine ? "未启用" : "—";
  }
  if ("protocol" in detail) els.liveProtocol.textContent = detail.protocol || "—";
  if ("endpoint" in detail) {
    els.liveEndpoint.textContent = detail.endpoint || "—";
    els.miniEndpoint.textContent = detail.endpoint || "";
  }
}

async function readSavedSettings() {
  const stored = await ext.storage.local.get("settings");
  return normalizeSettings(stored.settings);
}

async function checkLiveStatus() {
  if (liveBusy) return;
  liveBusy = true;

  const settings = await readSavedSettings();
  const endpoint = `${settings.host}:${settings.port}`;
  setLiveState("checking", {
    label: "检查中…",
    reason: "正在读取已保存的设置",
    endpoint,
  });
  els.liveChecked.textContent = "正在检查…";

  try {
    const pingResponse = await vextoFetch(settings, "/ping", { timeoutMs: LIVE_TIMEOUT_MS });
    if (!pingResponse.ok) {
      setLiveState("disconnected", {
        label: "服务异常",
        reason: describeHttpError(pingResponse.status),
        version: null,
        engine: null,
        protocol: null,
        endpoint,
      });
      return;
    }
    const ping = await readJson(pingResponse);
    if (!ping || typeof ping.version !== "string") {
      setLiveState("disconnected", {
        label: "不是 Vexto",
        reason: "端口上的服务没有返回 Vexto 版本。",
        version: null,
        engine: null,
        protocol: null,
        endpoint,
      });
      return;
    }

    const versionResponse = await vextoFetch(settings, "/version", { timeoutMs: LIVE_TIMEOUT_MS });
    const version = await readJson(versionResponse);
    if (!versionResponse.ok || !version || typeof version.engine !== "string") {
      setLiveState("disconnected", {
        label: "服务异常",
        reason: "Vexto 的 /version 响应无法识别。",
        version: ping.version,
        engine: null,
        protocol: null,
        endpoint,
      });
      return;
    }

    const capabilitiesResponse = await vextoFetch(settings, "/downloads/capabilities", {
      headers: vextoHeaders(settings),
      timeoutMs: LIVE_TIMEOUT_MS,
    });
    if (capabilitiesResponse.status === 401) {
      setLiveState("disconnected", {
        label: "密钥不一致",
        reason: describeHttpError(401),
        version: ping.version,
        engine: version.engine,
        protocol: null,
        endpoint,
      });
      return;
    }
    if (!capabilitiesResponse.ok) {
      setLiveState("disconnected", {
        label: "服务异常",
        reason: describeHttpError(capabilitiesResponse.status),
        version: ping.version,
        engine: version.engine,
        protocol: null,
        endpoint,
      });
      return;
    }

    const capabilities = await readJson(capabilitiesResponse);
    const v1 = await detectV1(settings, 1500);
    const protocol = v1
      ? "v1"
      : capabilities && Number.isInteger(capabilities.protocolVersion)
        ? `兼容 v${capabilities.protocolVersion}`
        : "兼容";

    if (version.engine === "running") {
      setLiveState("connected", {
        label: "已连接",
        reason: `Vexto ${ping.version} · 引擎就绪 · ${v1 ? "协议 v1" : "兼容接口"}`,
        version: ping.version,
        engine: version.engine,
        protocol,
        endpoint,
      });
    } else {
      setLiveState("warning", {
        label: "引擎未启用",
        reason: "Vexto 已连接，但下载引擎未启用；交接会回落到浏览器下载。",
        version: ping.version,
        engine: version.engine,
        protocol,
        endpoint,
      });
    }
  } catch (error) {
    setLiveState("disconnected", {
      label: "未连接",
      reason: describeNetworkError(error, settings, LIVE_TIMEOUT_MS),
      version: null,
      engine: null,
      protocol: null,
      endpoint,
    });
  } finally {
    liveBusy = false;
    els.liveChecked.textContent = `最近检查 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  }
}

function startLivePolling() {
  if (liveTimer) return;
  void checkLiveStatus();
  liveTimer = setInterval(() => {
    if (document.visibilityState === "visible") void checkLiveStatus();
  }, LIVE_INTERVAL_MS);
}

async function loadSettings() {
  const stored = await ext.storage.local.get("settings");
  if (stored.settings) {
    const settings = normalizeSettings(stored.settings);
    render(settings);
    setStatus(`已保存 · ${settings.host}:${settings.port}`, "");
  } else {
    render(DEFAULT_SETTINGS);
    setStatus("默认设置 · 尚未保存", "");
  }
  savedSnapshot = formSnapshot();
  dirty = false;
  refreshSaveState();
  await loadCookiePermission();
  await loadDownloadUiPermission();
  void loadDiagnostics();
}

async function saveSettings() {
  if (busy || !dirty) return;
  const { ok, errors, settings } = validateSettings(readForm());
  showFieldErrors(errors);
  if (!ok) {
    setStatus("设置未保存：请修正标红的字段。", "bad");
    return;
  }

  let notice = "";
  if (!downloadUiSupported) settings.hideDownloadUi = false;
  const needCookie = settings.forwardCookies && !cookieHostGranted;
  const needDownloadUi = downloadUiSupported && settings.hideDownloadUi && !downloadUiGranted;

  // 权限申请必须在用户手势里发起：这里之前只有同步代码。
  if (needCookie || needDownloadUi) {
    const request = {};
    if (needCookie) request.origins = COOKIE_ORIGINS;
    if (needDownloadUi) request.permissions = ["downloads.ui"];
    try {
      await ext.permissions.request(request);
    } catch (error) {
      console.warn("请求权限失败：", error);
    }
    if (needCookie) {
      cookieHostGranted = await ext.permissions
        .contains({ origins: COOKIE_ORIGINS })
        .catch(() => false);
      if (!cookieHostGranted) {
        settings.forwardCookies = false;
        els.forwardCookies.checked = false;
        notice += "未获得全站 Cookie 权限，Cookie 转发已关闭；";
      }
    }
    if (needDownloadUi) {
      downloadUiGranted = await ext.permissions
        .contains(DOWNLOAD_UI_PERMISSION)
        .catch(() => false);
      if (!downloadUiGranted) {
        settings.hideDownloadUi = false;
        els.hideDownloadUi.checked = false;
        notice += "未获得下载 UI 权限，隐藏下载列表已关闭；";
      }
    }
  }

  if (!settings.forwardCookies && cookieHostGranted) {
    try {
      await ext.permissions.remove({ origins: COOKIE_ORIGINS });
      cookieHostGranted = false;
    } catch (error) {
      console.warn("移除 Cookie 权限失败：", error);
    }
  }
  refreshCookieHint();
  refreshDownloadUiHint();

  try {
    await ext.storage.local.set({ settings });
    savedSnapshot = formSnapshot();
    dirty = false;
    refreshSaveState();
    void checkLiveStatus();
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const finalNotice = notice ? `${notice}其他设置已保存。` : "";
    setStatus(
      finalNotice || `已保存 · ${settings.host}:${settings.port} · ${time}`,
      finalNotice ? "warn" : "ok"
    );
  } catch (error) {
    setStatus(`保存失败：${error?.message || error}`, "bad");
  }
}

async function testConnection() {
  if (busy) return;
  const { ok, errors, settings } = validateSettings(readForm());
  showFieldErrors(errors);
  if (!ok) {
    setStatus("无法测试：请先修正标红的字段。", "bad");
    return;
  }

  setBusy(true);
  setStatus("正在连接 Vexto…", "");

  try {
    // 1) /ping：产品发现，Vexto 侧不校验鉴权。
    let ping;
    try {
      const response = await vextoFetch(settings, "/ping");
      const body = await readJson(response);
      if (!response.ok) {
        setStatus(describeHttpError(response.status), "bad");
        return;
      }
      if (!body || typeof body.version !== "string") {
        setStatus("端口上的服务不是 Vexto：/ping 响应缺少版本字段。", "bad");
        return;
      }
      ping = body;
    } catch (error) {
      setStatus(describeNetworkError(error, settings), "bad");
      return;
    }

    // 2) /version：引擎就绪探针，同样不校验鉴权。
    let version;
    try {
      const response = await vextoFetch(settings, "/version");
      const body = await readJson(response);
      if (!response.ok) {
        setStatus(describeHttpError(response.status), "bad");
        return;
      }
      if (!body || typeof body.engine !== "string") {
        setStatus("Vexto 的 /version 响应无法识别。", "bad");
        return;
      }
      version = body;
    } catch (error) {
      setStatus(describeNetworkError(error, settings), "bad");
      return;
    }

    // 3) 鉴权探测：Vexto 对 /ping 与 /version 免鉴权，401 只能在需要密钥的
    //    接口上暴露，所以额外读一次 /downloads/capabilities。
    let capabilities = null;
    try {
      const response = await vextoFetch(settings, "/downloads/capabilities", {
        headers: vextoHeaders(settings),
      });
      const body = await readJson(response);
      if (response.status === 401) {
        setStatus(`已连接 Vexto ${ping.version}，但${describeHttpError(401)}`, "bad");
        return;
      }
      if (!response.ok) {
        setStatus(describeHttpError(response.status), "bad");
        return;
      }
      capabilities = body;
    } catch (error) {
      setStatus(describeNetworkError(error, settings), "bad");
      return;
    }

    // 4) /v1/ping：可选稳定协议；不存在时继续用兼容接口。
    let v1 = null;
    try {
      const response = await vextoFetch(settings, "/v1/ping", {
        headers: { "X-Vexto-Client": VEXTO_CLIENT },
        timeoutMs: 1500,
      });
      const body = await readJson(response);
      if (response.ok && body && typeof body.protocol === "number" && body.protocol >= 1) {
        v1 = body;
      }
    } catch {
      // /v1 不存在时继续用兼容接口
    }
    if (v1) {
      await writeProtocolMode("v1", v1.protocol);
    } else {
      await writeProtocolMode(
        "compat",
        capabilities && Number.isInteger(capabilities.protocolVersion)
          ? capabilities.protocolVersion
          : 3
      );
    }

    const protocol = v1
      ? " · 协议 v1（X-Vexto-Client）"
      : capabilities && Number.isInteger(capabilities.protocolVersion)
        ? ` · 兼容协议 v${capabilities.protocolVersion}`
        : "";
    if (version.engine === "running") {
      setStatus(`已连接 · Vexto ${ping.version} · 引擎就绪${protocol}`, "ok");
    } else {
      setStatus(
        `已连接 · Vexto ${ping.version} · 引擎未启用（${version.engine}）：交接会回落到浏览器下载${protocol}`,
        "warn"
      );
    }
  } finally {
    setBusy(false);
  }
}

els.save.addEventListener("click", () => void saveSettings());
els.test.addEventListener("click", () => {
  showPane("connection");
  void testConnection();
});
els.forwardCookies.addEventListener("change", refreshCookieHint);
els.hideDownloadUi.addEventListener("change", refreshDownloadUiHint);
els.diagRefresh.addEventListener("click", () => void loadDiagnostics());
els.diagClear.addEventListener("click", () => void clearDiagnostics());
els.grantCookies.addEventListener("click", async () => {
  try {
    cookieHostGranted = await ext.permissions.request({ origins: COOKIE_ORIGINS });
  } catch (error) {
    cookieHostGranted = false;
    console.warn("请求 Cookie 权限失败：", error);
  }
  refreshCookieHint();
  setStatus(
    cookieHostGranted ? "已授权全站 Cookie。" : "未获得全站 Cookie 权限。",
    cookieHostGranted ? "ok" : "warn"
  );
});
els.grantDownloadUi.addEventListener("click", async () => {
  try {
    downloadUiGranted = await ext.permissions.request(DOWNLOAD_UI_PERMISSION);
  } catch (error) {
    downloadUiGranted = false;
    console.warn("请求下载 UI 权限失败：", error);
  }
  refreshDownloadUiHint();
  setStatus(
    downloadUiGranted ? "已授权下载 UI 权限。" : "未获得下载 UI 权限。",
    downloadUiGranted ? "ok" : "warn"
  );
});

for (const item of document.querySelectorAll(".nav-item")) {
  item.addEventListener("click", () => showPane(item.dataset.pane));
}

els.nav.addEventListener("keydown", (event) => {
  const items = [...els.nav.querySelectorAll(".nav-item")];
  const index = items.indexOf(document.activeElement);
  if (index < 0) return;

  let next = null;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    next = (index + 1) % items.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    next = (index - 1 + items.length) % items.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = items.length - 1;
  }
  if (next === null) return;

  event.preventDefault();
  items[next].focus();
  showPane(items[next].dataset.pane);
});

window.addEventListener("hashchange", () => showPane(paneFromHash(), { updateHash: false }));

els.liveRefresh.addEventListener("click", () => void checkLiveStatus());
els.miniStatus.addEventListener("click", () => {
  showPane("connection");
  void checkLiveStatus();
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void checkLiveStatus();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkLiveStatus();
});

for (const field of ERROR_FIELDS) {
  els[field].addEventListener("input", () => clearFieldError(field));
}

const FORM_FIELDS = [
  "enabled",
  "autoTakeover",
  "host",
  "port",
  "secret",
  "forwardHeaders",
  "forwardCookies",
  "hideDownloadUi",
  "minimumSizeMb",
  "unknownSizeTakeover",
  "duplicateWindowSeconds",
  "allowSites",
  "blockSites",
];
for (const field of FORM_FIELDS) {
  els[field].addEventListener("input", updateDirtyState);
  els[field].addEventListener("change", updateDirtyState);
}

ext.permissions.onAdded.addListener(() => {
  void loadCookiePermission();
  void loadDownloadUiPermission();
});
ext.permissions.onRemoved.addListener(() => {
  void loadCookiePermission();
  void loadDownloadUiPermission();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.target.tagName !== "INPUT" || event.target.type === "checkbox") return;
  event.preventDefault();
  void saveSettings();
});

els.appVersion.textContent = ext.runtime.getManifest().version;
showPane(paneFromHash(), { updateHash: false });
startLivePolling();

loadSettings().catch((error) => {
  setStatus(`读取设置失败：${error?.message || error}`, "bad");
});
