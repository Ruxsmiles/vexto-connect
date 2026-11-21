// Vexto Connect service worker
// - 右键「用 Vexto 下载」：POST /add，失败回落浏览器下载（M1）
// - 自动接管浏览器下载：downloads.onCreated + 1 秒 deadline（M2）
//
// 为什么用 onCreated 而不是 onDeterminingFilename：Edge 158 实测，MV3 worker
// 被回收后 onDeterminingFilename 不会唤醒它，下载会直接绕过接管；onCreated
// 能可靠唤醒 worker。代价是下载可能已开始写少量数据，所以这里先 pause 再交接。

importScripts("common.js");

const MENU_ID = "vexto-download-link";
const MENU_TITLE = "用 Vexto 下载";
const DEFAULT_ACTION_TITLE = "Vexto Connect";
const BADGE_OK = "✓";
const BADGE_ERR = "!";
const BADGE_COLOR_OK = "#45c98a";
const BADGE_COLOR_ERR = "#f0566d";
const TAKEOVER_DEADLINE_MS = 1000;
const PENDING_KEY = "pendingTakeovers";
const NOTIFY_THROTTLE_MS = 30000;
const HANDLED_TTL_MS = 10 * 60 * 1000;
const SELF_URL_TTL_MS = 15000;

let menuGeneration = 0;
const handledTakeovers = new Map();
const lastNotifyAt = new Map();
const selfInitiatedUrls = new Map();

// ── 设置缓存 ────────────────────────────────────────────────────────────
// 菜单和手动交接都从这里读，storage.onChanged 负责更新。

let settingsCache = null;
let settingsFromChange = false;
const settingsReady = chrome.storage.local
  .get("settings")
  .then((stored) => {
    // 初次读取可能晚于一次 storage.onChanged，不要用旧值覆盖新值
    if (!settingsFromChange) settingsCache = normalizeSettings(stored.settings);
    return settingsCache;
  })
  .catch((error) => {
    console.warn("读取设置失败：", error);
    if (!settingsFromChange) settingsCache = normalizeSettings(null);
    return settingsCache;
  });

async function loadSettings() {
  if (settingsCache) return settingsCache;
  return settingsReady;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  settingsFromChange = true;
  settingsCache = normalizeSettings(changes.settings.newValue);
  void refreshMenu();
});

// ── 右键菜单 ────────────────────────────────────────────────────────────

async function refreshMenu() {
  const generation = ++menuGeneration;
  const settings = await loadSettings();
  if (generation !== menuGeneration) return;
  await chrome.contextMenus.removeAll();
  if (generation !== menuGeneration || !settings.enabled) return;
  chrome.contextMenus.create(
    { id: MENU_ID, title: MENU_TITLE, contexts: ["link"] },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("创建右键菜单失败：", chrome.runtime.lastError.message);
      }
    }
  );
}

void refreshMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  void handoffLink(info.linkUrl || "", tab?.url || "");
});

// ── 手动交接（M1）──────────────────────────────────────────────────────

function filenameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segment = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

async function handoffLink(linkUrl, referer) {
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · 正在交给 Vexto…` });

  const settings = await loadSettings();

  if (!linkUrl) {
    await reportFailure("没有读到链接", "请确认右键点在链接上。", null);
    return;
  }
  if (!/^https?:\/\//i.test(linkUrl)) {
    await reportFailure("不支持的链接", "只能把 http/https 链接交给 Vexto。", null);
    return;
  }
  if (!settings.enabled) {
    await reportFailure("扩展已停用", "请在 Vexto Connect 选项页启用扩展后再试。", linkUrl);
    return;
  }

  const payload = { url: linkUrl, ack: "early", userAgent: navigator.userAgent };
  if (referer) payload.referer = referer;
  const filename = filenameFromUrl(linkUrl);
  if (filename) payload.filename = filename;

  let response;
  try {
    response = await vextoFetch(settings, "/add", {
      method: "POST",
      headers: vextoHeaders(settings, true),
      body: JSON.stringify(payload),
      timeoutMs: ADD_TIMEOUT_MS,
    });
  } catch (error) {
    const reason = describeNetworkError(error, settings, ADD_TIMEOUT_MS);
    await reportFailure("Vexto 未响应", reason, linkUrl);
    return;
  }

  if (response.status === 401) {
    await reportFailure("密钥不一致", describeHttpError(401), linkUrl);
    return;
  }
  if (!response.ok) {
    await reportFailure(`Vexto 返回 HTTP ${response.status}`, describeHttpError(response.status), linkUrl);
    return;
  }

  const data = await readJson(response);
  if (data && data.action === "accepted") {
    await reportSuccess();
    return;
  }

  const reason =
    data && data.reason === "rejected"
      ? "Vexto 拒绝接收：下载工具未启用，或该链接类型不受支持。"
      : `Vexto 没有接管（响应：${data ? JSON.stringify(data) : "无法解析"}）。`;
  await reportFailure("已回落到浏览器下载", reason, linkUrl);
}

async function reportSuccess() {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OK });
  await chrome.action.setBadgeText({ text: BADGE_OK });
  await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · 已交给 Vexto` });
  clearBadgeSoon();
}

async function reportFailure(headline, reason, fallbackUrl) {
  console.warn(`Vexto Connect：${headline}。${reason}`);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ERR });
    await chrome.action.setBadgeText({ text: BADGE_ERR });
    await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${headline}` });

    const fallbackNote = fallbackUrl ? "已改用浏览器下载。" : "";
    notify(`${DEFAULT_ACTION_TITLE} · ${headline}`, `${reason}${fallbackNote}`);
  } catch (error) {
    // 状态展示失败也不能影响回落下载
    console.warn("显示失败状态时出错：", error);
  } finally {
    if (fallbackUrl) startBrowserDownload(fallbackUrl);
    clearBadgeSoon();
  }
}

function startBrowserDownload(url) {
  // 标记为自己的下载，避免开启自动接管后被再次拦截
  rememberSelfDownload(url);
  chrome.downloads.download({ url, saveAs: false }, () => {
    if (chrome.runtime.lastError) {
      notify(
        `${DEFAULT_ACTION_TITLE} · 浏览器下载未启动`,
        `浏览器下载也未能启动：${chrome.runtime.lastError.message}。请复制链接后手动下载。`
      );
    }
  });
}

function rememberSelfDownload(url) {
  selfInitiatedUrls.set(url, Date.now());
  if (selfInitiatedUrls.size > 100) {
    const cutoff = Date.now() - SELF_URL_TTL_MS;
    for (const [key, at] of selfInitiatedUrls) {
      if (at < cutoff) selfInitiatedUrls.delete(key);
    }
  }
}

function isSelfDownload(url) {
  const at = selfInitiatedUrls.get(url);
  if (!at) return false;
  if (Date.now() - at > SELF_URL_TTL_MS) {
    selfInitiatedUrls.delete(url);
    return false;
  }
  return true;
}

// ── 自动接管（M2）──────────────────────────────────────────────────────

chrome.downloads.onCreated.addListener((item) => {
  void maybeTakeOver(item);
});

function shouldAutoTakeOver(item, settings) {
  if (!settings.enabled || !settings.autoTakeover) return false;
  if (!/^https?:\/\//i.test(item.url || "")) return false;
  // 扩展自己发起的下载（例如右键失败后的回落）不再接管，避免循环
  if (item.byExtensionId || isSelfDownload(item.url)) return false;
  if (item.state !== "in_progress" && item.state !== "complete") return false;
  return true;
}

async function maybeTakeOver(item) {
  if (wasHandled(item.id)) return;
  const settings = await loadSettings();
  if (!shouldAutoTakeOver(item, settings)) return;

  // onCreated 时 byExtensionId 可能还没写入，稍等再读一次
  await new Promise((resolve) => setTimeout(resolve, 50));
  let fresh = item;
  try {
    [fresh] = await chrome.downloads.search({ id: item.id });
  } catch {
    fresh = null;
  }
  if (!fresh || !shouldAutoTakeOver(fresh, settings)) return;
  await beginTakeover(fresh, settings);
}

function wasHandled(id) {
  const at = handledTakeovers.get(id);
  if (!at) return false;
  if (Date.now() - at > HANDLED_TTL_MS) {
    handledTakeovers.delete(id);
    return false;
  }
  return true;
}

function markHandled(id) {
  handledTakeovers.set(id, Date.now());
  if (handledTakeovers.size > 500) {
    const cutoff = Date.now() - HANDLED_TTL_MS;
    for (const [key, at] of handledTakeovers) {
      if (at < cutoff) handledTakeovers.delete(key);
    }
  }
}

function takeoverPayload(item) {
  const payload = {
    url: item.finalUrl || item.url,
    ack: "early",
    userAgent: navigator.userAgent,
  };
  if (item.referrer) payload.referer = item.referrer;
  // onCreated 阶段浏览器可能还没确定文件名，用 URL 最后一段兜底
  const filename = item.filename || filenameFromUrl(item.finalUrl || item.url);
  if (filename) payload.filename = filename;
  if (Number.isFinite(item.fileSize) && item.fileSize > 0) payload.size = item.fileSize;
  return payload;
}

async function beginTakeover(item, settings) {
  markHandled(item.id);

  let settled = false;
  // 安全网：任何路径卡住都必须在 deadline 后恢复浏览器下载
  const guard = setTimeout(() => {
    if (!settled) resumeDownload(item.id);
  }, TAKEOVER_DEADLINE_MS + 500);

  try {
    await setPending(item.id, { url: item.url, startedAt: Date.now(), stage: "paused" });
    chrome.downloads.pause(item.id, () => {
      void chrome.runtime.lastError;
    });

    let response;
    try {
      response = await vextoFetch(settings, "/add", {
        method: "POST",
        headers: vextoHeaders(settings, true),
        body: JSON.stringify(takeoverPayload(item)),
        timeoutMs: TAKEOVER_DEADLINE_MS,
      });
    } catch (error) {
      const reason = describeNetworkError(error, settings, TAKEOVER_DEADLINE_MS);
      await clearPending(item.id);
      settled = true;
      resumeDownload(item.id);
      await reportTakeoverFailure("Vexto 未响应，已恢复浏览器下载", reason);
      return;
    }

    if (response.status === 401) {
      await clearPending(item.id);
      settled = true;
      resumeDownload(item.id);
      await reportTakeoverFailure("密钥不一致，已恢复浏览器下载", describeHttpError(401));
      return;
    }
    if (!response.ok) {
      await clearPending(item.id);
      settled = true;
      resumeDownload(item.id);
      await reportTakeoverFailure(
        `Vexto 返回 HTTP ${response.status}，已恢复浏览器下载`,
        describeHttpError(response.status)
      );
      return;
    }

    const data = await readJson(response);
    if (data && data.action === "accepted") {
      await clearPending(item.id);
      settled = true;
      await removeBrowserDownload(item.id);
      await reportTakeoverSuccess();
      return;
    }

    const reason =
      data && data.reason === "rejected"
        ? "Vexto 拒绝接收（下载工具未启用或链接类型不支持）。"
        : `Vexto 没有接管（响应：${data ? JSON.stringify(data) : "无法解析"}）。`;
    await clearPending(item.id);
    settled = true;
    resumeDownload(item.id);
    await reportTakeoverFailure("已恢复浏览器下载", reason);
  } catch (error) {
    console.warn("自动接管出错，恢复浏览器下载：", error);
    await clearPending(item.id).catch(() => {});
    settled = true;
    resumeDownload(item.id);
    await reportTakeoverFailure("自动接管出错，已恢复浏览器下载", String(error?.message || error));
  } finally {
    clearTimeout(guard);
  }
}

function resumeDownload(id) {
  chrome.downloads.resume(id, () => {
    void chrome.runtime.lastError;
  });
}

async function removeBrowserDownload(id) {
  try {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state === "complete") {
      await chrome.downloads.removeFile(id);
    } else {
      await chrome.downloads.cancel(id);
    }
  } catch (error) {
    void error;
  }
  try {
    await chrome.downloads.erase({ id });
  } catch (error) {
    void error;
  }
}

async function reportTakeoverSuccess() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OK });
    await chrome.action.setBadgeText({ text: BADGE_OK });
    await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · 已接管下载` });
  } catch (error) {
    console.warn("显示接管成功状态失败：", error);
  }
  clearBadgeSoon();
}

async function reportTakeoverFailure(headline, reason) {
  console.warn(`Vexto Connect：${headline}。${reason}`);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ERR });
    await chrome.action.setBadgeText({ text: BADGE_ERR });
    await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${headline}` });
  } catch (error) {
    console.warn("显示接管失败状态失败：", error);
  }
  notifyThrottled(headline, `${DEFAULT_ACTION_TITLE} · ${headline}`, reason);
  clearBadgeSoon();
}

function notifyThrottled(key, title, message) {
  const now = Date.now();
  if (now - (lastNotifyAt.get(key) || 0) < NOTIFY_THROTTLE_MS) return;
  lastNotifyAt.set(key, now);
  notify(title, message);
}

// ── 进行中的交接（storage.session）──────────────────────────────────────

async function setPending(id, entry) {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] || {};
  pending[id] = entry;
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

async function clearPending(id) {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] || {};
  if (!(id in pending)) return;
  delete pending[id];
  if (Object.keys(pending).length) {
    await chrome.storage.session.set({ [PENDING_KEY]: pending });
  } else {
    await chrome.storage.session.remove(PENDING_KEY);
  }
}

// worker 重启后，把上次被暂停、还没恢复的下载放行
async function recoverPendingTakeovers() {
  let pending = {};
  try {
    pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] || {};
  } catch (error) {
    console.warn("读取未完成交接失败：", error);
    return;
  }
  const ids = Object.keys(pending);
  if (!ids.length) return;
  for (const key of ids) {
    const id = Number(key);
    try {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state === "in_progress" && item.paused) {
        resumeDownload(id);
      }
    } catch (error) {
      console.warn(`恢复下载 ${id} 失败：`, error);
    }
  }
  await chrome.storage.session.remove(PENDING_KEY);
  console.warn(`Vexto Connect：恢复了 ${ids.length} 条未完成的交接记录`);
}

void recoverPendingTakeovers();

// ── 通用 ────────────────────────────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("通知失败：", chrome.runtime.lastError.message);
      }
    }
  );
}

function clearBadgeSoon() {
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" });
  }, 3000);
}
