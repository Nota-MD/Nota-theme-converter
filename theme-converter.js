import {
  buildPackageZip,
  extractThemePackage,
  recognizeAndConvert,
} from "./theme-converter-core.js?v=20261101-4";

const requestedLanguage = new URLSearchParams(location.search).get("lang");
const zh = requestedLanguage
  ? requestedLanguage === "zh"
  : navigator.language.toLowerCase().startsWith("zh");
const pipeline = document.body.dataset.converterKind || "auto";

const translations = {
  privacyBanner: ["Theme packages are processed entirely on this device. Nothing is uploaded.", "主题包完全在此设备上处理，不会上传任何内容。"],
  home: ["Home", "首页"],
  themes: ["Themes", "主题"],
  converter: ["Theme converter", "主题转换器"],
  converterGtk: ["GTK / GNOME", "GTK / GNOME"],
  converterKde: ["KDE Plasma", "KDE Plasma"],
  converterTypora: ["Typora", "Typora"],
  language: ["中文", "English"],
  privacyNote: [
    "Local only. The file stays in this browser tab. No account, server, analytics or upload is involved.",
    "仅本地处理。文件只存在于当前浏览器标签页，不需要账号、服务器、统计或上传。",
  ],
  light: ["Light", "浅色"],
  dark: ["Dark", "深色"],
  download: ["Download Nota theme", "下载 Nota 主题"],
  downloadUi: ["Save as UI theme", "保存为 UI 主题"],
  downloadDocument: ["Save as document theme", "保存为文档主题"],
  copyCss: ["Copy CSS", "复制 CSS"],
  copyUiCss: ["Copy UI CSS", "复制 UI CSS"],
  copyDocumentCss: ["Copy document CSS", "复制文档 CSS"],
  uiOutput: ["UI theme", "UI 主题"],
  uiOutputHint: ["Window, sidebar and controls", "窗口、侧栏与控件"],
  documentOutput: ["Document theme", "文档主题"],
  documentOutputHint: ["Paper, type and Markdown blocks", "纸面、字体与 Markdown 块"],
  previewLabel: ["Live Nota preview", "Nota 实时预览"],
  previewTitle: ["A quieter place to write", "更安静的写作空间"],
  previewBody: [
    "The converted palette is applied to the same semantic tokens used by Nota’s desktop interface.",
    "转换后的配色会应用到 Nota 桌面界面的同一套语义设计变量。",
  ],
  previewQuote: [
    "Formatting follows the writing, while the Markdown file remains yours.",
    "格式跟随书写出现，Markdown 文件始终属于你。",
  ],
  testedWith: ["Tested package formats:", "已测试的主题包格式："],
  loading: ["Reading the theme package…", "正在读取主题包…"],
  success: ["Theme recognized and converted locally.", "已识别主题并在本地完成转换。"],
  unsupported: [
    "This archive was not recognized as a supported Typora, GTK or KDE theme.",
    "这个压缩包不是可识别的 Typora、GTK 或 KDE 主题。",
  ],
  copied: ["CSS copied.", "CSS 已复制。"],
  copyFailed: ["Could not copy the CSS.", "无法复制 CSS。"],
};

const pageCopy = {
  gtk: {
    eyebrow: ["GTK / GNOME converter", "GTK / GNOME 转换器"],
    title: ["Bring GNOME with you.", "把 GNOME 带到 Nota。"],
    lead: [
      "Load an installable GNOME or GTK theme package. Nota reads its palette, geometry and bundled fonts locally, then builds both a UI theme and a matching document theme.",
      "载入可安装的 GNOME 或 GTK 主题包。Nota 在本地读取配色、几何参数和主题自带字体，同时生成 UI 主题与配套文档主题。",
    ],
    dropTitle: ["Drop a GTK theme package", "拖入 GTK 主题包"],
    dropBody: [
      "or click to choose a ZIP, TAR.GZ or TAR.XZ from a GNOME or GTK theme site.",
      "或点击选择从 GNOME、GTK 主题站下载的 ZIP、TAR.GZ 或 TAR.XZ 文件。",
    ],
    idle: ["Waiting for a GTK / GNOME theme package.", "等待 GTK / GNOME 主题包。"],
    gtkCard: [
      "Recognizes theme folders containing index.theme, GTK 3/4 styles and their theme-specific settings.",
      "识别包含 index.theme、GTK 3/4 样式及主题设置的文件。",
    ],
    fontCard: [
      "Reads gtk-font-name and @font-face declarations. WOFF2, WOFF, TTF and OTF files travel with the exported theme.",
      "读取 gtk-font-name 与 @font-face 声明；WOFF2、WOFF、TTF 和 OTF 字体会随主题导出。",
    ],
    scopeTitle: ["Two outputs", "两个输出"],
    scopeBody: [
      "Produces both a UI theme and a matching document theme. GTK widget selectors are not copied into Nota.",
      "同时生成 UI 主题与配套文档主题；不会把 GTK 控件选择器照搬进 Nota。",
    ],
  },
  kde: {
    eyebrow: ["KDE Plasma converter", "KDE Plasma 转换器"],
    title: ["Your Plasma palette, now in Nota.", "把 Plasma 配色带到 Nota。"],
    lead: [
      "Load a Plasma color scheme or global theme. Nota reads its window, view, button and selection roles, plus bundled fonts, then produces both a UI theme and a matching document theme.",
      "载入 Plasma 色彩方案或全局主题。Nota 在本地读取窗口、视图、按钮、选择项配色及主题自带字体，同时生成 UI 主题与配套文档主题。",
    ],
    dropTitle: ["Drop a Plasma theme package", "拖入 Plasma 主题包"],
    dropBody: [
      "or click to choose a ZIP, TAR.GZ or TAR.XZ from KDE Store. Standalone .colors files are supported too.",
      "或点击选择从 KDE Store 下载的 ZIP、TAR.GZ 或 TAR.XZ；也支持独立的 .colors 文件。",
    ],
    idle: ["Waiting for a KDE Plasma theme package.", "等待 KDE Plasma 主题包。"],
    kdeCard: [
      "Reads Colors:Window, View, Button and Selection roles from standard Plasma color schemes.",
      "从标准 Plasma 色彩方案中读取 Colors:Window、View、Button 与 Selection 配色。",
    ],
    kdeGlobalCard: [
      "Finds metadata, config and color files inside Plasma global-theme packages while ignoring splash and wallpaper payloads.",
      "识别 Plasma 全局主题中的元数据、配置和配色文件，并忽略启动画面与壁纸内容。",
    ],
    kdeFontCard: [
      "Reads KDE font settings and @font-face declarations. Bundled WOFF2, WOFF, TTF and OTF fonts are exported with the theme.",
      "读取 KDE 字体设置与 @font-face 声明；WOFF2、WOFF、TTF 和 OTF 字体会随主题导出。",
    ],
    scopeTitle: ["Two outputs", "两个输出"],
    scopeBody: [
      "Plasma roles produce a UI theme and a matching document theme, with light/dark document companions when available.",
      "Plasma 配色角色会生成 UI 主题与配套文档主题；存在深浅配色时会一并生成文档深色伴侣。",
    ],
  },
  typora: {
    eyebrow: ["Typora theme converter", "Typora 主题转换器"],
    title: ["Keep the page. Bring the shell.", "保留页面，带走界面。"],
    lead: [
      "Load a Typora CSS theme, a standalone stylesheet or a ZIP of its adjacent assets. This converter produces the UI theme only; the document stylesheet can already be imported into Nota directly.",
      "载入 Typora CSS 主题、独立样式表，或连同相邻资源的 ZIP。这里只转换 UI 主题；Typora 的文档主题仍可直接导入 Nota。",
    ],
    dropTitle: ["Drop a Typora theme", "拖入 Typora 主题"],
    dropBody: [
      "or click to choose a CSS, ZIP, TAR.GZ or TAR.XZ. Theme folders should be archived; local imports and bundled fonts are preserved.",
      "或点击选择 CSS、ZIP、TAR.GZ、TAR.XZ。主题文件夹请先压缩；本地 @import 与随包字体会保留。",
    ],
    idle: ["Waiting for a Typora theme.", "等待 Typora 主题。"],
    typoraCard: [
      "Recognizes Typora’s --bg-color, --text-color, sidebar, hover, active-file and border tokens instead of copying document markup.",
      "识别 Typora 的 --bg-color、--text-color、侧栏、悬停、活动文件与边框变量，不复制正文 DOM 选择器。",
    ],
    typoraPairCard: [
      "Pairs a base stylesheet with its -dark companion when both live in the same theme folder.",
      "当同一主题文件夹中同时存在基础样式与 -dark 伴生样式时，会自动配对浅色和深色。",
    ],
    fontCard: [
      "Expands local @import rules, maps UI and monospace families, keeps document serif faces out of the shell, and exports only matching bundled fonts.",
      "展开本地 @import，映射界面与等宽字体，避免正文衬线字体污染外壳，并只导出实际匹配的随包字体。",
    ],
    scopeTitle: ["What is mapped", "转换内容"],
    scopeBody: [
      "Semantic UI colors, typography and practical geometry. Typora’s editor DOM and proprietary shell selectors are not copied.",
      "映射界面语义色、字体与实用几何参数；不会照搬 Typora 编辑器 DOM 和专有外壳选择器。",
    ],
  },
};

function tr(key) {
  const pair = pageCopy[pipeline]?.[key] ?? translations[key];
  if (pair) return zh ? pair[1] : pair[0];
  return key;
}

document.documentElement.lang = zh ? "zh-CN" : "en";
for (const element of document.querySelectorAll("[data-i18n]")) {
  const value = tr(element.dataset.i18n);
  element.innerHTML = value;
}

const languageLink = document.querySelector('[data-i18n="language"]');
if (languageLink) {
  const target = new URL(location.href);
  target.searchParams.set("lang", zh ? "en" : "zh");
  languageLink.href = target.toString();
  languageLink.lang = zh ? "en" : "zh-CN";
}

const input = document.querySelector("#theme-file");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#converter-status");
const result = document.querySelector("#converter-result");
const resultName = document.querySelector("#result-name");
const resultKind = document.querySelector("#result-kind");
const tokenGrid = document.querySelector("#token-grid");
const preview = document.querySelector("#nota-preview");
const previewStyle = document.querySelector("#converted-preview-style");
const downloadButton = document.querySelector("#download-theme");
const documentDownloadButton = document.querySelector("#download-document");
const copyButton = document.querySelector("#copy-css");
const modeButtons = [...document.querySelectorAll("[data-mode]")];
const outputButtons = [...document.querySelectorAll("[data-output]")];

let current = null;
let currentMode = "light";
let currentOutput = "ui";
let previewFontUrls = [];

function releasePreviewFonts() {
  for (const url of previewFontUrls) URL.revokeObjectURL(url);
  previewFontUrls = [];
}

function previewCss(theme) {
  let css = theme.css;
  previewFontUrls = theme.fonts.map((font) => {
    const url = URL.createObjectURL(new Blob([font.data], { type: font.mime }));
    css = css.replaceAll(font.cssUrl, url);
    return url;
  });
  return css;
}

function setStatus(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setPreviewMode(mode) {
  if (!current) return;
  currentMode = mode;
  preview.dataset.uiMode = mode;
  preview.dataset.preview = currentOutput;
  const output = currentOutput === "document" ? current.theme.document : current.theme;
  const palette = output[mode].palette;
  const geometry = output[mode].geometry;
  for (const [name, value] of Object.entries({
    "--p-bg": palette.bg,
    "--p-fg": palette.fg,
    "--p-fg-muted": palette.muted,
    "--p-border": palette.border,
    "--p-bg-subtle": palette.subtle,
    "--p-bg-raised": palette.raised,
    "--p-bg-hover": palette.hover,
    "--p-accent": palette.accent,
    "--p-accent-fg": palette.accentFg,
    "--p-font-ui": current.theme.uiFont,
    "--p-font-doc": current.theme.document?.uiFont || current.theme.uiFont,
    "--p-font-mono": current.theme.document?.monoFont || current.theme.monoFont || "ui-monospace, monospace",
    "--p-radius": `${geometry.radius}px`,
    "--p-radius-sm": `${geometry.radiusSmall}px`,
  })) {
    preview.style.setProperty(name, value);
  }
  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  for (const button of outputButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.output === currentOutput));
  }
  copyButton.textContent =
    currentOutput === "document" ? tr("copyDocumentCss") : tr("copyUiCss");
  renderTokens(palette);
}

function renderTokens(palette) {
  const labels = ["bg", "fg", "accent", "raised", "border", "subtle", "muted", "faint"];
  tokenGrid.replaceChildren(
    ...labels.map((key) => {
      const chip = document.createElement("div");
      chip.className = "token-chip";
      chip.style.setProperty("--swatch", palette[key]);
      const swatch = document.createElement("span");
      const code = document.createElement("code");
      code.textContent = `--${key} ${palette[key]}`;
      chip.append(swatch, code);
      return chip;
    }),
  );
}

async function convertFile(file) {
  if (!file) return;
  if (file.size > 160 * 1024 * 1024) {
    setStatus("Package is larger than 160 MB.", "error");
    return;
  }
  setStatus(tr("loading"));
  result.classList.remove("visible");
  try {
    const entries = await extractThemePackage(file);
    const converted = recognizeAndConvert(entries, { preferredKind: pipeline });
    current = { ...converted, entries, file };
    currentMode = converted.theme.mode;
    currentOutput = "ui";
    resultName.textContent = converted.theme.name;
    const source =
      converted.theme.kind === "gtk"
        ? "GTK / GNOME"
        : converted.theme.kind === "kde"
          ? "KDE Plasma"
          : "Typora";
    const fontCount = converted.theme.fonts.length;
    const fontLabel = zh ? `${fontCount} 个内置字体` : `${fontCount} bundled font${fontCount === 1 ? "" : "s"}`;
    resultKind.textContent = `${source} → Nota · ${fontLabel} · ${converted.theme.id}`;
    releasePreviewFonts();
    previewStyle.textContent = previewCss(converted.theme);
    preview.dataset.uiStyle = converted.theme.id;
    for (const button of outputButtons) {
      if (button.dataset.output === "document") {
        button.hidden = !converted.theme.document;
      }
    }
    documentDownloadButton.hidden = !converted.theme.document;
    setPreviewMode(currentMode);
    result.classList.add("visible");
    setStatus(tr("success"), "success");
  } catch (error) {
    current = null;
    releasePreviewFonts();
    previewStyle.textContent = "";
    result.classList.remove("visible");
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`${tr("unsupported")} ${message}`, "error");
  } finally {
    input.value = "";
  }
}

input.addEventListener("change", () => convertFile(input.files?.[0]));

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
}

dropZone.addEventListener("drop", (event) => {
  void convertFile(event.dataTransfer?.files?.[0]);
});

for (const button of modeButtons) {
  button.addEventListener("click", () => setPreviewMode(button.dataset.mode));
}

for (const button of outputButtons) {
  button.addEventListener("click", () => {
    if (button.hidden) return;
    currentOutput = button.dataset.output;
    setPreviewMode(currentMode);
  });
}

downloadButton.addEventListener("click", () => {
  if (!current) return;
  const bytes = buildPackageZip({ ...current, output: "ui" });
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${current.theme.id}-nota-ui.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

documentDownloadButton.addEventListener("click", () => {
  if (!current?.theme.document) return;
  const bytes = buildPackageZip({ ...current, output: "document" });
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${current.theme.id}-nota-document.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

copyButton.addEventListener("click", async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(
      currentOutput === "document" ? current.theme.document.css : current.theme.css,
    );
    setStatus(tr("copied"), "success");
  } catch {
    setStatus(tr("copyFailed"), "error");
  }
});
