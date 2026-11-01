import {
  buildPackageZip,
  extractThemePackage,
  makeZip,
  recognizeAndConvert,
} from "../theme-converter-core.js";
import { readFileSync } from "node:fs";

let passed = 0;
const failures = [];

function test(name, body) {
  try {
    body();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✘ ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function bytes(value) {
  return new TextEncoder().encode(value);
}

console.log("\n【Theme converter】");

test("GTK package maps named colors and geometry", () => {
  const entries = [
    {
      path: "Sample/gtk-3.0/gtk.css",
      data: bytes(`
        @define-color theme_bg_color #f6f5f4;
        @define-color theme_fg_color #241f31;
        @define-color theme_base_color #ffffff;
        @define-color theme_selected_bg_color #3584e4;
        @define-color theme_selected_fg_color #ffffff;
        headerbar { min-height: 38px; }
        button { border-radius: 10px; }
      `),
    },
    {
      path: "Sample/index.theme",
      data: bytes("[Desktop Entry]\nName=Sample GTK\n"),
    },
  ];
  const { recognized, theme } = recognizeAndConvert(entries);
  assert(recognized.kind === "gtk", "GTK package was not recognized");
  assert(theme.name === "Sample GTK", "index.theme name was not used");
  assert(theme.light.palette.bg === "#f6f5f4", "background mismatch");
  assert(theme.light.palette.accent === "#3584e4", "accent mismatch");
  assert(theme.light.geometry.radius === 10, "radius mismatch");
});

test("KDE color scheme maps Window, View and Selection", () => {
  const entries = [
    {
      path: "Look/contents/colors",
      data: bytes(`
        [Colors:Window]
        BackgroundNormal=44,55,70
        ForegroundNormal=233,229,223
        [Colors:View]
        BackgroundNormal=31,40,51
        ForegroundNormal=233,229,223
        [Colors:Selection]
        BackgroundNormal=189,91,0
        ForegroundNormal=255,255,255
      `),
    },
    {
      path: "Look/metadata.json",
      data: bytes(JSON.stringify({ KPlugin: { Name: "KDE Sample" } })),
    },
  ];
  const { recognized, theme } = recognizeAndConvert(entries);
  assert(recognized.kind === "kde", "KDE package was not recognized");
  assert(theme.name === "KDE Sample", "KDE metadata name was not used");
  assert(theme.light.palette.bg === "#2c3746", "window background mismatch");
  assert(theme.light.palette.raised === "#1f2833", "view background mismatch");
  assert(theme.light.palette.accent === "#bd5b00", "selection mismatch");
});

test("GTK pipeline preserves declared fonts in CSS and ZIP", () => {
  const font = bytes("GTK-CUSTOM-FONT");
  const entries = [
    {
      path: "Sample/gtk-3.0/gtk.css",
      data: bytes(`
        @font-face {
          font-family: "Sample Sans";
          src: url("../fonts/SampleSans-Regular.ttf") format("truetype");
          font-weight: 400;
        }
        @define-color theme_bg_color #f8f7f4;
        @define-color theme_fg_color #24212b;
        @define-color theme_selected_bg_color #2d75d8;
      `),
    },
    {
      path: "Sample/gtk-3.0/settings.ini",
      data: bytes("[Settings]\ngtk-font-name=Sample Sans 11\n"),
    },
    { path: "Sample/fonts/SampleSans-Regular.ttf", data: font },
    { path: "Sample/index.theme", data: bytes("[Desktop Entry]\nName=Font GTK\n") },
  ];
  const converted = recognizeAndConvert(entries, { preferredKind: "gtk" });
  assert(converted.theme.pipeline === "gtk", "GTK pipeline was not selected");
  assert(converted.theme.fonts.length === 1, "GTK font file was not collected");
  assert(converted.theme.css.includes("@font-face"), "font-face declaration is missing");
  assert(converted.theme.css.includes('url("./fonts/01-SampleSans-Regular.ttf")'), "font URL is missing");
  assert(converted.theme.css.includes('--font-ui: "Sample Sans"'), "GTK font family was not mapped");
  const zipText = new TextDecoder().decode(buildPackageZip({ entries, ...converted }));
  assert(zipText.includes("themes/ui/gtk-font-gtk/fonts/01-SampleSans-Regular.ttf"), "font missing from ZIP");
  assert(zipText.includes("GTK-CUSTOM-FONT"), "font bytes missing from ZIP");
});

test("KDE pipeline reads font settings and keeps bundled fonts", () => {
  const font = bytes("KDE-CUSTOM-FONT");
  const entries = [
    {
      path: "Plasma/contents/colors",
      data: bytes(`
        [Colors:Window]
        BackgroundNormal=239,241,244
        ForegroundNormal=31,35,42
        [Colors:View]
        BackgroundNormal=255,255,255
        [Colors:Selection]
        BackgroundNormal=29,153,243
      `),
    },
    {
      path: "Plasma/contents/config/kdeglobals",
      data: bytes("[General]\nfont=KDE Sans,10,-1,5,50,0,0,0,0,0\n"),
    },
    { path: "Plasma/contents/fonts/KDESans-Regular.ttf", data: font },
    {
      path: "Plasma/metadata.json",
      data: bytes(JSON.stringify({ KPlugin: { Name: "KDE Fonts", Category: "Plasma Theme" } })),
    },
  ];
  const converted = recognizeAndConvert(entries, { preferredKind: "kde" });
  assert(converted.theme.pipeline === "kde", "KDE pipeline was not selected");
  assert(converted.theme.fonts.length === 1, "KDE font file was not collected");
  assert(converted.theme.css.includes('--font-ui: "KDE Sans"'), "KDE configured font was not mapped");
  assert(converted.theme.css.includes('url("./fonts/01-KDESans-Regular.ttf")'), "KDE font URL is missing");
});

test("ambiguous packages can be converted through either pipeline", () => {
  const entries = [
    {
      path: "Mixed/gtk-4.0/gtk.css",
      data: bytes("@define-color theme_bg_color #ffffff; @define-color theme_fg_color #111111;"),
    },
    { path: "Mixed/index.theme", data: bytes("[Desktop Entry]\nName=Mixed GTK\n") },
    {
      path: "Mixed/contents/colors",
      data: bytes("[Colors:Window]\nBackgroundNormal=10,20,30\nForegroundNormal=240,240,240\n"),
    },
    {
      path: "Mixed/metadata.json",
      data: bytes(JSON.stringify({ KPlugin: { Name: "Mixed Plasma", Category: "Plasma Theme" } })),
    },
  ];
  const gtk = recognizeAndConvert(entries, { preferredKind: "gtk" });
  const kde = recognizeAndConvert(entries, { preferredKind: "kde" });
  assert(gtk.theme.kind === "gtk" && gtk.theme.light.palette.bg === "#ffffff", "GTK override failed");
  assert(kde.theme.kind === "kde" && kde.theme.light.palette.bg === "#0a141e", "KDE override failed");
  assert(kde.theme.sourceKinds.includes("gtk"), "available source kinds were not reported");
});

test("Typora theme maps UI variables without copying document selectors", () => {
  const font = bytes("TYpora-CUSTOM-FONT");
  const entries = [
    {
      path: "Typora/paper.css",
      data: bytes(`
        @font-face {
          font-family: "Paper Sans";
          src: url("fonts/PaperSans.ttf") format("truetype");
        }
        :root {
          --bg-color: #faf7f0;
          --text-color: #312a22;
          --side-bar-bg-color: #f0ebe1;
          --item-hover-bg-color: #e8dfd0;
          --active-file-bg-color: #dfd2bd;
          --search-select-text-color: var(--bg-color);
          --primary-color: #a23b2a;
          --window-border: 1px solid #c9bca8;
          --font-family: "Paper Serif", serif;
          --font-sans-serif: "Paper Sans", sans-serif;
        }
        body { background: var(--bg-color); color: var(--text-color); }
        #write { padding: 2rem; }
        button { border-radius: 7px; min-height: 32px; }
      `),
    },
    { path: "Typora/fonts/PaperSans.ttf", data: font },
  ];
  const converted = recognizeAndConvert(entries, { preferredKind: "typora" });
  assert(converted.theme.pipeline === "typora", "Typora pipeline was not selected");
  assert(converted.theme.light.palette.bg === "#faf7f0", "Typora background mismatch");
  assert(converted.theme.light.palette.raised === "#f0ebe1", "Typora sidebar mismatch");
  assert(converted.theme.light.palette.accent === "#a23b2a", "Typora accent mismatch");
  assert(converted.theme.light.geometry.radius === 7, "Typora radius mismatch");
  assert(converted.theme.fonts.length === 1, "Typora bundled font was not collected");
  assert(converted.theme.css.includes('--font-ui: "Paper Sans"'), "Typora UI font was not mapped");
  assert(!converted.theme.css.includes("#write"), "document selectors leaked into UI CSS");
  const zipText = new TextDecoder().decode(buildPackageZip({ entries, ...converted }));
  assert(zipText.includes("Typora → Nota UI"), "Typora package README is missing the source pipeline");
});

test("Typora document serif fonts do not leak into the Nota UI font", () => {
  const entries = [
    {
      path: "Paper/paper.css",
      data: bytes(`
        @font-face {
          font-family: "Paper Serif";
          src: url("fonts/PaperSerif.ttf") format("truetype");
        }
        :root {
          --bg-color: #ffffff;
          --text-color: #222222;
          --font-family: "Paper Serif", serif;
        }
        #write { font-family: var(--font-family); }
      `),
    },
    { path: "Paper/fonts/PaperSerif.ttf", data: bytes("SERIF") },
  ];
  const converted = recognizeAndConvert(entries, { preferredKind: "typora" });
  assert(!converted.theme.uiFont.includes("Paper Serif"), "serif document font leaked into --font-ui");
  assert(converted.theme.fonts.length === 0, "unused document font was exported into the UI package");
});

test("Typora light and dark companions stay paired", () => {
  const entries = [
    {
      path: "Paper/paper.css",
      data: bytes(`
        :root {
          --bg-color: #fffaf2;
          --text-color: #241f1a;
          --primary-color: #b24a36;
        }
        #write { color: var(--text-color); }
      `),
    },
    {
      path: "Paper/paper-dark.css",
      data: bytes(`
        :root {
          --bg-color: #191714;
          --text-color: #eee7dc;
          --primary-color: #e88b72;
        }
        #write { color: var(--text-color); }
      `),
    },
  ];
  const converted = recognizeAndConvert(entries, { preferredKind: "typora" });
  assert(converted.theme.light.palette.bg === "#fffaf2", "light companion was not selected");
  assert(converted.theme.dark.palette.bg === "#191714", "dark companion was not paired");
});

test("a standalone Typora CSS file is accepted", async () => {
  const source = ":root { --bg-color: #ffffff; --text-color: #111111; } #write { color: var(--text-color); }";
  const entries = await extractThemePackage({
    name: "paper.css",
    async arrayBuffer() {
      return bytes(source).buffer;
    },
  });
  assert(entries.length === 1 && entries[0].path === "paper.css", "CSS file was not exposed as one entry");
  const converted = recognizeAndConvert(entries, { preferredKind: "typora" });
  assert(converted.theme.light.palette.bg === "#ffffff", "standalone Typora CSS was not converted");
});

test("wrapped Typora ZIPs resolve dot-relative imports", async () => {
  const entries = await extractThemePackage({
    name: "paper.zip",
    async arrayBuffer() {
      const zip = makeZip({
        "Wrapper/paper.css": '@import "./parts/colors.css";\n#write { color: var(--text-color); }',
        "Wrapper/parts/colors.css": ":root { --bg-color: #fffaf2; --text-color: #241f1a; }",
      });
      return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
    },
  });
  const converted = recognizeAndConvert(entries, { preferredKind: "typora" });
  assert(converted.theme.light.palette.bg === "#fffaf2", "wrapped import colors were not loaded");
});

test("unrecognized archives are rejected", () => {
  let message = "";
  try {
    recognizeAndConvert([{ path: "assets/photo.png", data: new Uint8Array([1, 2, 3]) }]);
  } catch (error) {
    message = String(error);
  }
  assert(message.includes("No supported theme structure"), "missing explicit rejection");
});

test("generated Nota package is a readable ZIP", () => {
  const entries = [
    {
      path: "Sample/gtk-4.0/gtk.css",
      data: bytes("@define-color theme_bg_color #ffffff; @define-color theme_fg_color #000000;"),
    },
    { path: "Sample/index.theme", data: bytes("[Desktop Entry]\nName=ZIP Test\n") },
  ];
  const converted = recognizeAndConvert(entries);
  const zip = buildPackageZip({ entries, ...converted });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert(view.getUint32(0, true) === 0x04034b50, "ZIP local header missing");
  assert(new TextDecoder().decode(zip).includes("themes/ui/"), "Nota package path missing");
});

test("generic ZIP writer retains UTF-8 names", () => {
  const zip = makeZip({ "中文/theme.css": "body {}" });
  assert(new TextDecoder().decode(zip).includes("中文/theme.css"), "UTF-8 filename missing");
});

test("converter pages inject generated CSS through a style element", () => {
  for (const page of ["gtk.html", "kde.html", "typora.html"]) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert(
      html.includes('<style id="converted-preview-style"></style>'),
      `${page} does not provide a style element for converted CSS`,
    );
    assert(
      !html.includes('<script id="converted-preview-style"></script>'),
      `${page} still uses a script element for converted CSS`,
    );
  }
});

test("converter entry exposes a round-trip language switch", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert(html.includes('id="language-toggle"'), "language toggle id is missing");
  assert(html.includes('languageLink.href = "?lang=en"'), "Chinese mode cannot switch back to English");
  assert(html.includes('languageLink.href = "?lang=zh"'), "English mode cannot switch to Chinese");
  assert(html.includes('href="typora.html"'), "Typora converter choice is missing");
  assert(html.includes('a[href="typora.html"]'), "Typora page does not preserve the language parameter");
});

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) process.exitCode = 1;
