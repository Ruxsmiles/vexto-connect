#!/usr/bin/env node
// 校验扩展的多语言资源，不依赖任何 npm 包：
//   node scripts/check-i18n.mjs
//
// 检查项：
//   1. _locales 下恰好是 en / zh_CN / ja / ko / es，且 manifest 的 default_locale 存在；
//   2. 五份 messages.json 的 key 完全对齐，没有空值；
//   3. 占位符（$NAME$）都有定义、都被使用，且同名占位符在各语言里指向同一个 $n$；
//   4. manifest 里的 __MSG_x__、HTML 的 data-i18n、JS 的 t("x") 都能找到对应 key；
//   5. 没有定义后从未被引用的 key。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "zh_CN", "ja", "ko", "es"];
const DEFAULT_LOCALE = "en";
const HTML_FILES = ["options.html", "popup.html"];
const JS_FILES = ["common.js", "options.js", "popup.js", "background.js"];
const MANIFEST_FILES = ["manifest.json", "manifest.firefox.json"];

const errors = [];
const fail = (message) => errors.push(message);

const readJson = (path) => {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${path}: JSON 解析失败 — ${error.message}`);
    return null;
  }
};

const PLACEHOLDER = /\$([A-Za-z0-9_]+)\$/g;
const placeholdersIn = (text) => {
  const names = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
};

// ── 1. 目录与 manifest ────────────────────────────────────────────────
const localesDir = join(ROOT, "_locales");
if (!existsSync(localesDir)) {
  fail("缺少 _locales 目录。");
}
const present = existsSync(localesDir)
  ? readdirSync(localesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];
for (const locale of LOCALES) {
  if (!present.includes(locale)) fail(`_locales 缺少 ${locale}/。`);
}
for (const locale of present) {
  if (!LOCALES.includes(locale)) fail(`_locales 下有未登记的语言目录 ${locale}/。`);
}

for (const file of MANIFEST_FILES) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  const manifest = readJson(path);
  if (!manifest) continue;
  if (manifest.default_locale !== DEFAULT_LOCALE) {
    fail(`${file}: default_locale 应为 "${DEFAULT_LOCALE}"，实际为 ${JSON.stringify(manifest.default_locale)}。`);
  }
}

// ── 2/3. messages.json ────────────────────────────────────────────────
const messages = {};
for (const locale of LOCALES) {
  const path = join(localesDir, locale, "messages.json");
  if (!existsSync(path)) continue;
  const parsed = readJson(path);
  if (!parsed) continue;
  messages[locale] = parsed;

  for (const [key, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || typeof entry.message !== "string") {
      fail(`${locale}/${key}: 缺少 message 字符串。`);
      continue;
    }
    if (!entry.message.trim()) fail(`${locale}/${key}: message 为空。`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(key)) {
      fail(`${locale}/${key}: key 应使用 lowerCamelCase。`);
    }

    const used = placeholdersIn(entry.message);
    const defined = Object.keys(entry.placeholders ?? {});
    for (const name of used) {
      if (!defined.includes(name)) fail(`${locale}/${key}: 占位符 $${name}$ 未在 placeholders 中定义。`);
    }
    for (const name of defined) {
      if (!used.includes(name)) fail(`${locale}/${key}: placeholders 定义了 $${name}$ 但 message 未使用。`);
      const content = entry.placeholders[name]?.content;
      if (!/^\$[1-9]$/.test(String(content))) {
        fail(`${locale}/${key}: 占位符 ${name} 的 content 必须是 $1..$9，实际为 ${JSON.stringify(content)}。`);
      }
    }
    const leftover = entry.message.replace(/\$[A-Za-z0-9_]+\$/g, "").replace(/\$\$/g, "");
    if (leftover.includes("$")) {
      fail(`${locale}/${key}: message 里有未转义的 "$"（字面量请写 "$$"）。`);
    }
  }
}

const base = messages[DEFAULT_LOCALE];
if (base) {
  const baseKeys = Object.keys(base);
  for (const locale of LOCALES) {
    const table = messages[locale];
    if (!table) continue;
    const keys = Object.keys(table);
    for (const key of baseKeys) {
      if (!keys.includes(key)) fail(`${locale}: 缺少 key "${key}"。`);
    }
    for (const key of keys) {
      if (!baseKeys.includes(key)) fail(`${locale}: 多出 key "${key}"（${DEFAULT_LOCALE} 里没有）。`);
    }
  }

  // 同名占位符必须在所有语言里指向同一个位置参数，否则 getMessage 的参数会错位。
  for (const key of baseKeys) {
    const expected = new Map();
    for (const locale of LOCALES) {
      const entry = messages[locale]?.[key];
      if (!entry?.placeholders) continue;
      for (const [name, value] of Object.entries(entry.placeholders)) {
        const content = String(value?.content);
        if (!expected.has(name)) expected.set(name, content);
        else if (expected.get(name) !== content) {
          fail(
            `${key}: 占位符 ${name} 在 ${locale} 是 ${content}，在其它语言是 ${expected.get(name)}。`
          );
        }
      }
    }
  }
}

// ── 4. 代码里的引用 ───────────────────────────────────────────────────
const referenced = new Set();
const known = new Set(base ? Object.keys(base) : []);

for (const file of MANIFEST_FILES) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  for (const token of readFileSync(path, "utf8").matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    referenced.add(token[1]);
    if (!known.has(token[1])) fail(`${file}: __MSG_${token[1]}__ 在 messages.json 里不存在。`);
  }
}

for (const file of HTML_FILES) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  const html = readFileSync(path, "utf8");
  for (const token of html.matchAll(/data-i18n="([^"]+)"/g)) {
    referenced.add(token[1]);
    if (!known.has(token[1])) fail(`${file}: data-i18n="${token[1]}" 在 messages.json 里不存在。`);
  }
  for (const token of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of token[1].split(",")) {
      const key = pair.slice(pair.indexOf(":") + 1).trim();
      if (!key) continue;
      referenced.add(key);
      if (!known.has(key)) fail(`${file}: data-i18n-attr 引用的 "${key}" 在 messages.json 里不存在。`);
    }
  }
}

for (const file of JS_FILES) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  const js = readFileSync(path, "utf8");
  for (const token of js.matchAll(/\bt\(\s*"([^"]+)"/g)) {
    referenced.add(token[1]);
    if (!known.has(token[1])) fail(`${file}: t("${token[1]}") 在 messages.json 里不存在。`);
  }
  // 查表（如 PANES、诊断标签）里的 key 以普通字符串出现，同一份清单里一并统计。
  for (const token of js.matchAll(/"([a-z][A-Za-z0-9]+)"/g)) referenced.add(token[1]);
}

for (const key of known) {
  if (!referenced.has(key)) fail(`key "${key}" 已定义但代码与页面都没有引用。`);
}

// ── 结果 ──────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`i18n 检查未通过（${errors.length} 项）：`);
  for (const message of errors) console.error(`  ✗ ${message}`);
  process.exit(1);
}

console.log(
  `i18n 检查通过：${LOCALES.length} 种语言 × ${known.size} 个 key，占位符与代码引用一致。`
);
