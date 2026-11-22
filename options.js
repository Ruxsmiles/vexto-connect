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
  detail: $("detail"),
  diagRefresh: $("diag-refresh"),
  diagClear: $("diag-clear"),
  diagnostics: $("diagnostics"),
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

function setDetail(lines) {
  if (!lines.length) {
    els.detail.textContent = "";
    els.detail.classList.add("hidden");
    return;
  }
  els.detail.textContent = lines.join("\n");
  els.detail.classList.remove("hidden");
}

function setBusy(value) {
  busy = value;
  els.save.disabled = value;
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
    cookieHostGranted = await chrome.permissions.contains({ origins: COOKIE_ORIGINS });
  } catch (error) {
    cookieHostGranted = false;
    console.warn("检查 Cookie 权限失败：", error);
  }
  refreshCookieHint();
}

function refreshDownloadUiHint() {
  if (!els.hideDownloadUi.checked) {
    els.downloadUiHint.textContent =
      "开启后隐藏 Edge 的下载列表/气泡，接管时不再弹出；浏览器回落的下载也不会显示列表。首次开启需要授权「下载 UI」权限。";
  } else if (downloadUiGranted) {
    els.downloadUiHint.textContent = "已授权：浏览器下载列表已隐藏（全局生效）。";
  } else {
    els.downloadUiHint.textContent =
      "尚未授权「下载 UI」权限：保存时会请求权限；未授权时不会隐藏下载列表。";
  }
  els.grantDownloadUi.hidden = !els.hideDownloadUi.checked || downloadUiGranted;
}

async function loadDownloadUiPermission() {
  const supported = typeof chrome.downloads?.setUiOptions === "function";
  els.hideDownloadUiRow.hidden = !supported;
  els.downloadUiHint.hidden = !supported;
  if (!supported) {
    els.grantDownloadUi.hidden = true;
    return;
  }
  try {
    downloadUiGranted = await chrome.permissions.contains(DOWNLOAD_UI_PERMISSION);
  } catch (error) {
    downloadUiGranted = false;
    console.warn("检查下载 UI 权限失败：", error);
  }
  refreshDownloadUiHint();
}

function renderDiagnostics(list) {
  if (!Array.isArray(list) || !list.length) {
    els.diagnostics.textContent = "暂无诊断事件。";
    return;
  }
  const lines = list.map((event) => {
    const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    const parts = [time, event.source || "-", event.outcome || "-"];
    if (event.host) parts.push(event.host);
    if (event.reason) parts.push(event.reason);
    if (event.browser) parts.push(event.browser);
    if (event.protocol) parts.push(`协议 ${event.protocol}`);
    if (typeof event.count === "number") parts.push(`${event.count} 条`);
    return parts.join(" · ");
  });
  els.diagnostics.textContent = lines.join("\n");
}

async function loadDiagnostics() {
  try {
    const stored = await chrome.storage.session.get("diagnostics");
    renderDiagnostics(stored.diagnostics);
  } catch (error) {
    els.diagnostics.textContent = `读取诊断失败：${error?.message || error}`;
  }
}

async function clearDiagnostics() {
  try {
    await chrome.storage.session.remove("diagnostics");
    renderDiagnostics([]);
    setStatus("诊断已清空。", "");
  } catch (error) {
    setStatus(`清空诊断失败：${error?.message || error}`, "bad");
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  if (stored.settings) {
    const settings = normalizeSettings(stored.settings);
    render(settings);
    setStatus(`已读取设置 · ${settings.host}:${settings.port}`, "");
  } else {
    render(DEFAULT_SETTINGS);
    setStatus("使用默认设置（尚未保存）", "");
  }
  await loadCookiePermission();
  await loadDownloadUiPermission();
  void loadDiagnostics();
}

async function saveSettings() {
  if (busy) return;
  const { ok, errors, settings } = validateSettings(readForm());
  showFieldErrors(errors);
  if (!ok) {
    setStatus("设置未保存：请修正标红的字段。", "bad");
    return;
  }

  let notice = "";
  const needCookie = settings.forwardCookies && !cookieHostGranted;
  const needDownloadUi = settings.hideDownloadUi && !downloadUiGranted;

  // 权限申请必须在用户手势里发起：这里之前只有同步代码。
  if (needCookie || needDownloadUi) {
    const request = {};
    if (needCookie) request.origins = COOKIE_ORIGINS;
    if (needDownloadUi) request.permissions = ["downloads.ui"];
    try {
      await chrome.permissions.request(request);
    } catch (error) {
      console.warn("请求权限失败：", error);
    }
    if (needCookie) {
      cookieHostGranted = await chrome.permissions
        .contains({ origins: COOKIE_ORIGINS })
        .catch(() => false);
      if (!cookieHostGranted) {
        settings.forwardCookies = false;
        els.forwardCookies.checked = false;
        notice += "未获得全站 Cookie 权限，Cookie 转发已关闭；";
      }
    }
    if (needDownloadUi) {
      downloadUiGranted = await chrome.permissions
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
      await chrome.permissions.remove({ origins: COOKIE_ORIGINS });
      cookieHostGranted = false;
    } catch (error) {
      console.warn("移除 Cookie 权限失败：", error);
    }
  }
  refreshCookieHint();
  refreshDownloadUiHint();

  try {
    await chrome.storage.local.set({ settings });
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
    setDetail([]);
    return;
  }

  const lines = [];
  const log = (line) => {
    lines.push(line);
    setDetail(lines);
  };

  setBusy(true);
  setStatus("正在连接 Vexto…", "");
  setDetail([]);

  try {
    // 1) /ping：产品发现，Vexto 侧不校验鉴权。
    let ping;
    try {
      const response = await vextoFetch(settings, "/ping");
      const body = await readJson(response);
      log(`GET /ping → HTTP ${response.status}${body ? ` ${JSON.stringify(body)}` : ""}`);
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
      log("GET /ping → 网络失败");
      setStatus(describeNetworkError(error, settings), "bad");
      return;
    }

    // 2) /version：引擎就绪探针，同样不校验鉴权。
    let version;
    try {
      const response = await vextoFetch(settings, "/version");
      const body = await readJson(response);
      log(`GET /version → HTTP ${response.status}${body ? ` ${JSON.stringify(body)}` : ""}`);
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
      log("GET /version → 网络失败");
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
      log(
        `GET /downloads/capabilities → HTTP ${response.status}${body ? ` ${JSON.stringify(body)}` : ""}`
      );
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
      log("GET /downloads/capabilities → 网络失败");
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
      log(`GET /v1/ping → HTTP ${response.status}${body ? ` ${JSON.stringify(body)}` : ""}`);
      if (response.ok && body && typeof body.protocol === "number" && body.protocol >= 1) {
        v1 = body;
      }
    } catch (error) {
      log("GET /v1/ping → 网络失败");
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
els.test.addEventListener("click", () => void testConnection());
els.forwardCookies.addEventListener("change", refreshCookieHint);
els.hideDownloadUi.addEventListener("change", refreshDownloadUiHint);
els.diagRefresh.addEventListener("click", () => void loadDiagnostics());
els.diagClear.addEventListener("click", () => void clearDiagnostics());
els.grantCookies.addEventListener("click", async () => {
  try {
    cookieHostGranted = await chrome.permissions.request({ origins: COOKIE_ORIGINS });
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
    downloadUiGranted = await chrome.permissions.request(DOWNLOAD_UI_PERMISSION);
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

for (const field of ERROR_FIELDS) {
  els[field].addEventListener("input", () => clearFieldError(field));
}

chrome.permissions.onAdded.addListener(() => {
  void loadCookiePermission();
  void loadDownloadUiPermission();
});
chrome.permissions.onRemoved.addListener(() => {
  void loadCookiePermission();
  void loadDownloadUiPermission();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && event.target.tagName !== "TEXTAREA") {
    event.preventDefault();
    void saveSettings();
  }
});

loadSettings().catch((error) => {
  setStatus(`读取设置失败：${error?.message || error}`, "bad");
});
