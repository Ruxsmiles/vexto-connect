// Vexto Connect service worker（MVP）。
//
// 当前只做三件事：保存设置、回应选项页的连接测试、右键把链接交给 Vexto。
// 自动拦截浏览器下载在路线图里，等下载事件状态机稳定后再加，避免半成品
// 把用户的浏览器下载吞掉。

const DEFAULTS = {
  enabled: true,
  host: "127.0.0.1",
  port: 29110,
  secret: "",
};

const MENU_ID = "vexto-download-link";

async function getSettings() {
  const got = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...got };
}

function baseUrl(settings) {
  const host = String(settings.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number(settings.port) || 29110;
  return `http://${host}:${port}`;
}

async function api(settings, path, options = {}) {
  const headers = {
    "X-Rayburst-Client": "rayburst-connect",
    ...(options.headers || {}),
  };
  if (settings.secret) headers.Authorization = `Bearer ${settings.secret}`;
  if (options.body) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 5000);
  try {
    const res = await fetch(baseUrl(settings) + path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${data ? "：" + JSON.stringify(data) : ""}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection() {
  const settings = await getSettings();
  const ping = await api(settings, "/ping", { timeout: 3000 });
  let version = null;
  try {
    version = await api(settings, "/version", { timeout: 3000 });
  } catch {
    version = null;
  }
  return {
    ok: ping && ping.product === "rayburst",
    ping,
    version,
    endpoint: baseUrl(settings),
  };
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

async function handOff(url, referer) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: "扩展未启用" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "不是 http/https 链接" };

  const body = {
    url,
    filename: fileNameFromUrl(url),
    referer: referer || "",
    userAgent: self.navigator.userAgent || "",
    ack: "early",
  };
  try {
    const r = await api(settings, "/add", { method: "POST", body, timeout: 10000 });
    if (r && r.action === "accepted") return { ok: true };
    return { ok: false, reason: (r && r.reason) || "Vexto 拒绝了任务" };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

async function ensureMenu() {
  await chrome.contextMenus.removeAll();
  const settings = await getSettings();
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "用 Vexto 下载",
    contexts: ["link"],
  });
  await chrome.action.setBadgeText({ text: "" });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureMenu().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") ensureMenu().catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl) return;
  const result = await handOff(info.linkUrl, tab?.url || "");
  if (result.ok) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    await chrome.action.setBadgeText({ text: "✓" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({
    title: `Vexto 交接失败：${result.reason}`,
  });
  console.warn("Vexto handoff failed:", result.reason);
  // Vexto 不可用时不让链接消失：交给浏览器原生下载。
  try {
    await chrome.downloads.download({
      url: info.linkUrl,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch {}
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "vexto:test") {
    testConnection()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (message?.type === "vexto:settings-changed") {
    ensureMenu()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
