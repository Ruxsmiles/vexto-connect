// Vexto Connect 工具栏弹窗：显示连接状态，并提供自动接管开关与设置入口。

"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  version: $("version"),
  dot: $("dot"),
  stateLabel: $("state-label"),
  stateVersion: $("state-version"),
  reason: $("reason"),
  engine: $("engine"),
  protocol: $("protocol"),
  endpoint: $("endpoint"),
  checked: $("checked"),
  enabledState: $("enabled-state"),
  autoTakeover: $("auto-takeover"),
  refresh: $("refresh"),
  openOptions: $("open-options"),
  openOptionsIcon: $("open-options-icon"),
};

let settings = null;
let refreshing = false;
let timer = null;

localizeDocument();

function setState(kind, label, versionText = "") {
  els.dot.className = `dot ${kind}`;
  els.stateLabel.textContent = label;
  els.stateVersion.textContent = versionText;
}

function endpointOf(value) {
  return `${value.host}:${value.port}`;
}

async function loadSettings() {
  const stored = await ext.storage.local.get("settings");
  settings = normalizeSettings(stored.settings);
  els.autoTakeover.checked = Boolean(settings.autoTakeover);
  els.autoTakeover.disabled = !settings.enabled;
  els.enabledState.textContent = settings.enabled ? t("extEnabled") : t("extDisabled");
  els.endpoint.textContent = endpointOf(settings);
}

async function probe(value) {
  const endpoint = endpointOf(value);
  if (!value.enabled) {
    return {
      kind: "off",
      label: t("statusDisabled"),
      reason: t("popupDisabledReason"),
      endpoint,
    };
  }

  let pingResponse;
  let ping;
  try {
    pingResponse = await vextoFetch(value, "/ping");
    ping = await readJson(pingResponse);
  } catch (error) {
    return {
      kind: "bad",
      label: t("statusDisconnected"),
      reason: describeNetworkError(error, value),
      endpoint,
    };
  }

  if (!pingResponse.ok) {
    return {
      kind: "bad",
      label: t("connError", [String(pingResponse.status)]),
      reason: describeHttpError(pingResponse.status),
      endpoint,
    };
  }
  if (!ping || typeof ping.version !== "string") {
    return {
      kind: "bad",
      label: t("statusNotVexto"),
      reason: t("pingMissingVersion"),
      endpoint,
    };
  }

  let engine = null;
  try {
    const versionResponse = await vextoFetch(value, "/version");
    const body = await readJson(versionResponse);
    if (versionResponse.ok && body && typeof body.engine === "string") {
      engine = body.engine;
    }
  } catch {
    // 引擎状态读取失败不阻断连接展示
  }

  try {
    const capabilityResponse = await vextoFetch(value, "/downloads/capabilities", {
      headers: vextoHeaders(value),
    });
    if (capabilityResponse.status === 401) {
      return {
        kind: "bad",
        label: t("statusSecretMismatch"),
        version: ping.version,
        reason: describeHttpError(401),
        endpoint,
      };
    }
  } catch {
    // 鉴权探测失败按已连接展示
  }

  const v1 = await detectV1(value);
  const protocol = t(v1 ? "protocolV1" : "protocolCompat");

  if (engine === "running") {
    return {
      kind: "ok",
      label: t("statusConnected"),
      version: ping.version,
      engine: t("engineReady"),
      protocol,
      endpoint,
    };
  }
  if (engine) {
    return {
      kind: "warn",
      label: t("statusEngineOff"),
      version: ping.version,
      engine,
      protocol,
      reason: t("liveEngineOffReason"),
      endpoint,
    };
  }
  return {
    kind: "warn",
    label: t("statusConnected"),
    version: ping.version,
    engine: "—",
    protocol,
    reason: t("popupEngineUnknownReason"),
    endpoint,
  };
}

function render(result) {
  setState(result.kind, result.label, result.version ? `Vexto ${result.version}` : "");
  els.reason.textContent = result.reason || "";
  els.engine.textContent = result.engine || "—";
  els.protocol.textContent = result.protocol || "—";
  els.endpoint.textContent = result.endpoint || "—";
  els.checked.textContent = formatTime();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  els.refresh.disabled = true;
  setState("checking", t("statusChecking"));
  els.reason.textContent = "";
  try {
    await loadSettings();
    const result = await probe(settings);
    render(result);
  } catch (error) {
    setState("bad", t("checkFailed"));
    els.reason.textContent = String(error?.message || error);
  } finally {
    refreshing = false;
    els.refresh.disabled = false;
  }
}

async function saveAutoTakeover() {
  if (!settings || !settings.enabled) return;
  const next = els.autoTakeover.checked;
  settings = { ...settings, autoTakeover: next };
  try {
    await ext.storage.local.set({ settings });
  } catch (error) {
    els.autoTakeover.checked = !next;
    console.warn("保存自动接管设置失败：", error);
  }
}

function openOptions() {
  void Promise.resolve(ext.runtime.openOptionsPage())
    .catch(() => {})
    .finally(() => window.close());
}

els.refresh.addEventListener("click", () => void refresh());
els.openOptions.addEventListener("click", openOptions);
els.openOptionsIcon.addEventListener("click", openOptions);
els.autoTakeover.addEventListener("change", () => void saveAutoTakeover());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

window.addEventListener("unload", () => {
  if (timer) clearInterval(timer);
});

async function init() {
  els.version.textContent = `v${ext.runtime.getManifest().version}`;
  await loadSettings();
  await refresh();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 5000);
}

init().catch((error) => {
  setState("bad", t("checkFailed"));
  els.reason.textContent = String(error?.message || error);
});
