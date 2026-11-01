const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20000;

export function decodeText(bytes) {
  return textDecoder.decode(bytes);
}

export function slugify(value) {
  const slug = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "imported-theme";
}

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress deflate streams.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress gzip streams.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  if (output.length > MAX_ARCHIVE_BYTES) throw new Error("The decompressed package is larger than 256 MB.");
  return output;
}

async function unxz(bytes) {
  const xz = globalThis["xz-decompress"]?.XzReadableStream;
  if (!xz) throw new Error("The XZ decoder did not load.");
  const stream = new xz(new Blob([bytes]).stream());
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  if (output.length > MAX_ARCHIVE_BYTES) throw new Error("The decompressed package is larger than 256 MB.");
  return output;
}

function normalizePath(path) {
  return String(path)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-directory record was not found.");

  const count = u16(view, eocd + 10);
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error("The ZIP contains too many files.");
  let cursor = u32(view, eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (u32(view, cursor) !== 0x02014b50) throw new Error("Invalid ZIP central directory.");
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = normalizePath(decodeText(nameBytes));
    if (uncompressedSize > MAX_ARCHIVE_BYTES) throw new Error(`ZIP entry is too large: ${name}`);

    if (u32(view, localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    if (!(flags & 0x1)) {
      let data;
      if (method === 0) data = compressed.slice();
      else if (method === 8) data = await inflateRaw(compressed);
      else throw new Error(`Unsupported ZIP compression method ${method}.`);
      entries.push({ path: name, data });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readCString(bytes, start, length) {
  let end = start;
  const limit = Math.min(bytes.length, start + length);
  while (end < limit && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(start, end));
}

function octal(bytes, start, length) {
  const value = readCString(bytes, start, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function parsePax(data) {
  const result = {};
  const source = textDecoder.decode(data);
  let offset = 0;
  while (offset < source.length) {
    const space = source.indexOf(" ", offset);
    if (space < 0) break;
    const length = Number.parseInt(source.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = source.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function untar(bytes) {
  const entries = [];
  let offset = 0;
  let longName = "";
  let pax = {};
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    if (size > MAX_ARCHIVE_BYTES) throw new Error("TAR entry is larger than 256 MB.");
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    const baseName = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const name = pax.path || longName || (prefix ? `${prefix}/${baseName}` : baseName);

    if (type === "x" || type === "g") {
      pax = { ...pax, ...parsePax(data) };
    } else if (type === "L") {
      longName = readCString(data, 0, data.length);
    } else {
      if (type !== "5" && name) entries.push({ path: normalizePath(name), data: data.slice() });
      if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("The TAR contains too many files.");
      longName = "";
      pax = {};
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function extractThemePackage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".css")) {
    return [{ path: basename(file.name), data: bytes }];
  }
  if (
    (bytes[0] === 0x50 && bytes[1] === 0x4b) ||
    lower.endsWith(".zip")
  ) {
    return unzip(bytes);
  }
  if (
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz")
  ) {
    return untar(await gunzip(bytes));
  }
  if (
    (bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58 && bytes[4] === 0x5a) ||
    lower.endsWith(".tar.xz") ||
    lower.endsWith(".txz")
  ) {
    return untar(await unxz(bytes));
  }
  if (lower.endsWith(".tar") || (bytes.length > 265 && decodeText(bytes.subarray(257, 262)) === "ustar")) {
    return untar(bytes);
  }
  throw new Error("Unsupported package. Use a Typora CSS/ZIP, GTK theme archive, or KDE color scheme.");
}

function parseIni(source) {
  const sections = {};
  let current = "";
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      sections[current] ??= {};
      continue;
    }
    const equals = line.indexOf("=");
    if (equals > 0 && current) {
      sections[current][line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
    }
  }
  return sections;
}

function parseIndexTheme(source) {
  const ini = parseIni(source);
  const desktop = ini["Desktop Entry"] ?? {};
  const localized = (base) => {
    if (desktop[base]) return desktop[base];
    const key = Object.keys(desktop).find((name) => name.startsWith(`${base}[`));
    return key ? desktop[key] : "";
  };
  return {
    name: localized("Name"),
    comment: localized("Comment"),
  };
}

function parseKdeMetadata(source) {
  try {
    const json = JSON.parse(source);
    const plugin = json.KPlugin ?? {};
    return {
      name: plugin.Name || json.name || "",
      license: plugin.License || "",
      description: plugin.Description || json.description || "",
      category: plugin.Category || json.category || "",
    };
  } catch {
    return { name: "", license: "", description: "", category: "" };
  }
}

function basename(path) {
  const parts = normalizePath(path).split("/");
  return parts.at(-1) ?? "";
}

function dirname(path) {
  const parts = normalizePath(path).split("/");
  parts.pop();
  return parts.join("/");
}

function findEntry(entries, path) {
  const wanted = normalizePath(path);
  return entries.find((entry) => entry.path === wanted);
}

function cssBundle(entries, path, seen = new Set()) {
  if (seen.has(path)) return "";
  seen.add(path);
  const entry = findEntry(entries, path);
  if (!entry) return "";
  let out = decodeText(entry.data);
  out = out.replace(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?\s*;/g, (_all, imported) => {
    if (/^https?:/i.test(imported)) return "";
    const next = normalizePath(`${dirname(path)}/${imported}`);
    return cssBundle(entries, next, seen);
  });
  return out;
}

function themeRootFromCss(path) {
  const match = normalizePath(path).match(/^(.*?)\/gtk-[34]\.0\/gtk(?:-dark)?\.css$/i);
  return match?.[1] ?? "";
}

function uniqueColors(...values) {
  return [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];
}

function entriesUnder(entries, root) {
  return root ? entries.filter((entry) => entry.path.startsWith(`${root}/`)) : entries;
}

function detectGtkTheme(entries) {
  const cssEntries = entries.filter((entry) => /\/gtk-[34]\.0\/gtk(?:-dark)?\.css$/i.test(entry.path));
  const roots = [...new Set(cssEntries.map((entry) => themeRootFromCss(entry.path)))];

  if (!roots.length) return null;
    const root = roots.sort((a, b) => {
      const score = (value) => entriesUnder(cssEntries, value).length;
      return score(b) - score(a);
    })[0];
    const relevant = entriesUnder(cssEntries, root);
    const lightPath =
      relevant.find((entry) => /gtk-4\.0\/gtk\.css$/i.test(entry.path))?.path ||
      relevant.find((entry) => /gtk-3\.0\/gtk\.css$/i.test(entry.path))?.path ||
      relevant[0]?.path;
    const darkPath =
      relevant.find((entry) => /gtk-4\.0\/gtk-dark\.css$/i.test(entry.path))?.path ||
      relevant.find((entry) => /gtk-3\.0\/gtk-dark\.css$/i.test(entry.path))?.path;
    const indexText = findEntry(entries, `${root}/index.theme`)?.data;
    const info = indexText ? parseIndexTheme(decodeText(indexText)) : { name: basename(root), comment: "" };
    const settingsText = findEntry(entries, `${root}/gtk-3.0/settings.ini`)?.data;
    const settings = settingsText ? parseIni(decodeText(settingsText)) : {};
    return {
      kind: "gtk",
      pipeline: "gtk",
      root,
      name: info.name || basename(root) || "GTK theme",
      comment: info.comment,
      lightCss: cssBundle(entries, lightPath),
      darkCss: darkPath ? cssBundle(entries, darkPath) : "",
      gtkFont: settings.Settings?.["gtk-font-name"] || "",
      variants: roots.length,
    };
}

function kdeColorCandidates(entries) {
  return entries.filter((entry) => {
    if (entry.data.length > 2 * 1024 * 1024) return false;
    const path = entry.path.toLowerCase();
    if (!(path.endsWith(".colors") || basename(path) === "colors" || path.includes("/colors/"))) return false;
    const source = decodeText(entry.data);
    return source.includes("[Colors:Window]") || source.includes("[Colors:View]");
  });
}

function parseKdeFont(entries) {
  const configEntries = entries.filter((entry) => {
    const name = basename(entry.path).toLowerCase();
    return ["kdeglobals", "plasmarc", "kwinrc"].includes(name) && entry.data.length <= 2 * 1024 * 1024;
  });
  const preferred = [
    ["General", "font"],
    ["General", "menuFont"],
    ["General", "toolBarFont"],
    ["WM", "activeFont"],
    ["WM", "inactiveFont"],
  ];
  const found = new Map();
  for (const entry of configEntries) {
    const sections = parseIni(decodeText(entry.data));
    for (const [section, key] of preferred) {
      const value = sections[section]?.[key];
      if (value && !found.has(`${section}:${key}`)) found.set(`${section}:${key}`, value);
    }
  }
  for (const [section, key] of preferred) {
    const value = found.get(`${section}:${key}`);
    if (value) return value;
  }
  return "";
}

function kdePackageRoot(colorPath, entries) {
  const marker = colorPath.indexOf("/contents/");
  if (marker >= 0) return colorPath.slice(0, marker);
  const metadata = entries.find((entry) => /(^|\/)metadata\.json$/i.test(entry.path));
  return metadata ? dirname(metadata.path) : dirname(colorPath);
}

function detectKdeTheme(entries) {
  const colorEntries = kdeColorCandidates(entries);
  if (!colorEntries.length) return null;

  const parsed = colorEntries.map((entry) => {
    const source = decodeText(entry.data);
    return {
      entry,
      source,
      palette: parseKdePalette(source),
      name: basename(entry.path).replace(/\.colors$/i, ""),
    };
  });
  const primary =
    parsed.find((item) => !/dark|midnight|black/i.test(item.entry.path) && item.palette.mode === "light") ??
    parsed[0];
  const dark = parsed.find((item) => item !== primary && item.palette.mode === "dark");
  const root = kdePackageRoot(primary.entry.path, entries);
  const metadataEntry =
    findEntry(entries, `${root}/metadata.json`) ??
    entries.find((entry) => /(^|\/)metadata\.json$/i.test(entry.path));
  const metadata = metadataEntry ? parseKdeMetadata(decodeText(metadataEntry.data)) : {};

  return {
    kind: "kde",
    pipeline: "kde",
    root,
    name: metadata.name || basename(root) || primary.name || "KDE color scheme",
    comment: metadata.description || "KDE Plasma theme",
    colors: primary.source,
    darkColors: dark?.source ?? "",
    kdeFont: parseKdeFont(entries),
    variants: parsed.length,
    isGlobalTheme: Boolean(metadata.category || /\/contents\//.test(primary.entry.path)),
  };
}

function typoraVariantBase(path) {
  return basename(path)
    .replace(/\.css$/i, "")
    .replace(/(?:^|[-_.])(?:light|dark|darker|night)(?=$|[-_.])/gi, "")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .toLowerCase();
}

function typoraCandidates(entries) {
  const eligible = entries.filter((entry) => {
    if (!/\.css$/i.test(entry.path) || /\.user\.css$/i.test(entry.path)) return false;
    if (entry.data.length > 8 * 1024 * 1024) return false;
    const css = cssBundle(entries, entry.path).replace(/\/\*[\s\S]*?\*\//g, "");
    return css.includes("#write") || css.includes("--bg-color");
  });
  const minimumDepth = Math.min(
    ...eligible.map((entry) => normalizePath(entry.path).split("/").length),
  );
  return eligible
    .filter((entry) => normalizePath(entry.path).split("/").length === minimumDepth)
    .map((entry) => {
      const css = cssBundle(entries, entry.path).replace(/\/\*[\s\S]*?\*\//g, "");
      const stem = basename(entry.path).replace(/\.css$/i, "");
      let score = 0;
      if (css.includes("--bg-color")) score += 50;
      if (css.includes("#write")) score += 35;
      if (css.includes("--text-color")) score += 12;
      if (css.includes("#typora-sidebar")) score += 8;
      if (/(^|\/)(?:theme|base)\.css$/i.test(entry.path)) score += 20;
      if (!/(?:^|[-_.])(?:light|dark|darker|night)(?:$|[-_.])/i.test(stem)) score += 8;
      score -= Math.min(stem.length, 40) / 10;
      return { entry, css, score };
    })
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path));
}

function detectTyporaTheme(entries) {
  const candidates = typoraCandidates(entries);
  if (!candidates.length) return null;

  const selectedPath = candidates[0].entry.path;
  const variantBase = typoraVariantBase(selectedPath);
  const sameVariant = candidates.filter(
    (candidate) => typoraVariantBase(candidate.entry.path) === variantBase,
  );
  const isDarkName = (path) => /(?:^|[-_.])(?:dark|darker|night)(?:$|[-_.])/i.test(basename(path));
  const light =
    sameVariant.find((candidate) => !isDarkName(candidate.entry.path)) ?? candidates[0];
  const dark = sameVariant.find((candidate) => isDarkName(candidate.entry.path));
  const lightCss = cssBundle(entries, light.entry.path);
  const darkCss = dark ? cssBundle(entries, dark.entry.path) : "";
  const variables = parseCssVariables(lightCss);
  const typoraFont = safeUiFontStack(
    resolveCssVariable("--font-ui", variables) ||
      resolveCssVariable("--font-sans-serif", variables) ||
      resolveCssVariable("--font-family", variables) ||
      resolveCssVariable("--font-text", variables),
  );
  const typoraMonoFont =
    resolveCssVariable("--font-monospace", variables) ||
    resolveCssVariable("--code-font-family", variables) ||
    resolveCssVariable("--monospace", variables);

  return {
    kind: "typora",
    pipeline: "typora",
    root: dirname(light.entry.path),
    name: basename(light.entry.path).replace(/\.css$/i, "") || "Typora theme",
    comment: "Typora theme",
    lightCss,
    darkCss,
    typoraFont,
    typoraMonoFont,
    variants: candidates.length,
  };
}

export function recognizeThemePackage(entries, options = {}) {
  const gtk = detectGtkTheme(entries);
  const kde = detectKdeTheme(entries);
  const typora = detectTyporaTheme(entries);
  const availableKinds = [gtk?.kind, kde?.kind, typora?.kind].filter(Boolean);
  const preferredKind = String(options.preferredKind ?? "auto").toLowerCase();

  if (!availableKinds.length) {
    throw new Error(
      "No supported theme structure was found. Use a Typora CSS theme, a GTK package with gtk-3.0/gtk.css, or a KDE color scheme.",
    );
  }

  let recognized;
  if (["gtk", "kde", "typora"].includes(preferredKind)) {
    recognized = { gtk, kde, typora }[preferredKind];
    if (!recognized) {
      throw new Error(
        `No ${preferredKind.toUpperCase()} theme was found. Available source: ${availableKinds.join(", ").toUpperCase()}.`,
      );
    }
  } else if (preferredKind !== "auto") {
    throw new Error(`Unknown conversion pipeline: ${preferredKind}.`);
  } else if (gtk && kde) {
    recognized = kde.isGlobalTheme ? kde : gtk;
  } else if (typora && !gtk && !kde) {
    recognized = typora;
  } else {
    recognized = gtk ?? kde ?? typora;
  }

  return { ...recognized, availableKinds };
}

const namedColors = {
  black: "#000000",
  white: "#ffffff",
  transparent: null,
};

export function parseColor(value) {
  if (!value) return null;
  const source = value.trim().toLowerCase();
  if (source in namedColors) return namedColors[source];
  const short = /^#([0-9a-f]{3})$/i.exec(source);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(source);
  if (hex) return `#${hex[1]}`.toLowerCase();
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(source);
  if (rgb) {
    return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i.exec(source);
  if (hsl) {
    return hslToHex(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
  }
  const tuple = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(source);
  if (tuple) return rgbToHex(Number(tuple[1]), Number(tuple[2]), Number(tuple[3]));
  return null;
}

export function rgbToHex(r, g, b) {
  const v = (number) => Math.max(0, Math.min(255, Math.round(number))).toString(16).padStart(2, "0");
  return `#${v(r)}${v(g)}${v(b)}`;
}

function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1 ? [chroma, x, 0] :
    section < 2 ? [x, chroma, 0] :
    section < 3 ? [0, chroma, x] :
    section < 4 ? [0, x, chroma] :
    section < 5 ? [x, 0, chroma] :
    [chroma, 0, x];
  const match = l - chroma / 2;
  return rgbToHex((r + match) * 255, (g + match) * 255, (b + match) * 255);
}

function parseCssVariables(css) {
  const values = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    values[match[1]] = match[2].trim();
  }
  return values;
}

function resolveCssVariable(name, values, seen = new Set()) {
  if (seen.has(name)) return "";
  const source = values[name];
  if (!source) return "";
  seen.add(name);
  const resolved = source.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g,
    (_all, nested, fallback) =>
      resolveCssVariable(nested, values, new Set(seen)) || String(fallback || "").trim(),
  );
  seen.delete(name);
  return resolved.trim();
}

function firstCssVariableColor(names, values) {
  for (const name of names) {
    const value = resolveCssVariable(name, values);
    if (!value) continue;
    const direct = parseColor(value);
    if (direct) return direct;
    for (const token of value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? []) {
      const color = parseColor(token);
      if (color) return color;
    }
  }
  return null;
}

function firstDistinctCssVariableColor(names, values, background) {
  let fallback = null;
  for (const name of names) {
    const color = firstCssVariableColor([name], values);
    if (!color) continue;
    fallback ??= color;
    if (Math.abs(luminance(color) - luminance(background)) >= 0.035) return color;
  }
  return fallback;
}

function firstCssVariable(names, values) {
  for (const name of names) {
    const value = resolveCssVariable(name, values);
    if (value) return value;
  }
  return "";
}

function rgb(color) {
  const parsed = parseColor(color);
  if (!parsed) return null;
  return [
    Number.parseInt(parsed.slice(1, 3), 16),
    Number.parseInt(parsed.slice(3, 5), 16),
    Number.parseInt(parsed.slice(5, 7), 16),
  ];
}

export function mixColors(a, b, weight = 0.5) {
  const left = rgb(a);
  const right = rgb(b);
  if (!left || !right) return a || b;
  return rgbToHex(
    left[0] * (1 - weight) + right[0] * weight,
    left[1] * (1 - weight) + right[1] * weight,
    left[2] * (1 - weight) + right[2] * weight,
  );
}

export function luminance(color) {
  const channels = rgb(color);
  if (!channels) return 0;
  const [r, g, b] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastText(background) {
  return luminance(background) > 0.48 ? "#000000" : "#ffffff";
}

function resolveAliases(values) {
  const result = { ...values };
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const [key, value] of Object.entries(result)) {
      const alias = /^@([\w-]+)$/.exec(value.trim());
      if (alias && result[alias[1]] && result[alias[1]] !== value) {
        result[key] = result[alias[1]];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

function parseDefineColors(css) {
  const values = {};
  for (const match of css.matchAll(/@define-color\s+([\w-]+)\s+([^;]+);/g)) {
    values[match[1]] = match[2].trim();
  }
  return resolveAliases(values);
}

function firstColor(declarations, property) {
  const match = new RegExp(`${property}\\s*:\\s*([^;]+)`, "i").exec(declarations);
  if (!match) return null;
  for (const part of match[1].split(/[,\s]+/)) {
    const color = parseColor(part);
    if (color) return color;
  }
  return null;
}

function cssRules(css) {
  const rules = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

function colorFromRules(rules, selectorPattern, fallback) {
  for (const rule of rules) {
    if (!selectorPattern.test(rule.selector)) continue;
    const background = firstColor(rule.body, "background(?:-color)?");
    if (background) return background;
  }
  return fallback;
}

function foregroundFromRules(rules, selectorPattern, fallback) {
  for (const rule of rules) {
    if (!selectorPattern.test(rule.selector)) continue;
    const foreground = firstColor(rule.body, "(?:^|;)\\s*color");
    if (foreground) return foreground;
  }
  return fallback;
}

function modeOf(background) {
  return luminance(background) < 0.48 ? "dark" : "light";
}

function geometryFromCss(css) {
  const rules = cssRules(css);
  const radii = [];
  const heights = [];
  for (const rule of rules) {
    for (const match of rule.body.matchAll(/border-radius\s*:\s*([\d.]+)px/g)) {
      const value = Number(match[1]);
      if (value >= 0 && value <= 24) radii.push(value);
    }
    for (const match of rule.body.matchAll(/min-height\s*:\s*([\d.]+)px/g)) {
      const value = Number(match[1]);
      if (value >= 20 && value <= 48) heights.push(value);
    }
  }
  const median = (values, fallback) => {
    if (!values.length) return fallback;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const radius = median(radii, 8);
  const height = median(heights, 34);
  return {
    radius: Math.max(0, Math.min(16, Math.round(radius))),
    radiusSmall: Math.max(0, Math.min(10, Math.round(radius * 0.62))),
    controlHeight: Math.round(height),
    toolbarHeight: Math.round(Math.max(34, Math.min(52, height + 6))),
    statusHeight: 28,
  };
}

function configuredFontFamily(font) {
  const raw = String(font || "").trim();
  if (!raw) return "";
  const parts = raw.split(",").map((part) => part.trim());
  const first = parts[0]?.replace(/^["']|["']$/g, "").trim() ?? "";
  if (parts.length > 1 && /^-?\d+(?:\.\d+)?$/.test(parts[1])) return first;
  return raw
    .replace(/^font-family\s*:/i, "")
    .replace(/\s+\d+(?:\.\d+)?\s*$/, "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
}

function fontFamilyNames(font) {
  const raw = String(font || "")
    .replace(/^font-family\s*:/i, "")
    .replace(/\s+\d+(?:\.\d+)?\s*$/, "");
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((name) => name && !/^(?:normal|regular|bold|sans-serif|serif|monospace|system-ui)$/i.test(name));
}

function safeUiFontStack(font) {
  const first = configuredFontFamily(font).toLowerCase();
  if (!first) return "";
  if (
    /\b(?:serif|song|songti|ming|mincho|kai|times|georgia|palatino|garamond|roman|computer modern|cmu|lora|merriweather)\b/i.test(
      first,
    )
  ) {
    return "";
  }
  return font;
}

function normalizeFont(font) {
  const family = configuredFontFamily(font);
  const raw = family || String(font || "").replace(/\s+\d+(?:\.\d+)?\s*$/, "").trim();
  if (!raw) return "system-ui, sans-serif";
  const families = raw.split(",").map((part) => {
    const name = part.trim().replace(/^["']|["']$/g, "");
    if (!name || /^(normal|regular|bold)$/i.test(name)) return "";
    return `"${name.replaceAll('"', "")}"`;
  }).filter(Boolean);
  return families.length ? `${families.join(", ")}, sans-serif` : "system-ui, sans-serif";
}

const FONT_FORMATS = {
  otf: { mime: "font/otf", format: "opentype" },
  ttf: { mime: "font/ttf", format: "truetype" },
  woff: { mime: "font/woff", format: "woff" },
  woff2: { mime: "font/woff2", format: "woff2" },
};
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_FONT_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_FONTS = 16;

function extension(path) {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
}

function fontFormat(path) {
  return FONT_FORMATS[extension(path)] ?? null;
}

function resolveArchiveUrl(cssPath, raw) {
  let value = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!value || /^(?:data|https?|blob|file):/i.test(value) || value.startsWith("//") || value.startsWith("#")) {
    return "";
  }
  value = value.split(/[?#]/, 1)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    return "";
  }
  const parts = dirname(cssPath).split("/").filter(Boolean);
  for (const part of normalizePath(value).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return "";
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function cssFontFaces(entries) {
  const hints = new Map();
  for (const entry of entries) {
    if (!/\.css$/i.test(entry.path) || entry.data.length > 2 * 1024 * 1024) continue;
    const css = decodeText(entry.data).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
      const body = match[1];
      const familyMatch = /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i.exec(body);
      const family = (familyMatch?.[1] ?? familyMatch?.[2] ?? familyMatch?.[3] ?? "").trim();
      for (const urlMatch of body.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'" \t\r\n]+))\s*\)/gi)) {
        const assetPath = resolveArchiveUrl(entry.path, urlMatch[1] ?? urlMatch[2] ?? urlMatch[3]);
        if (!assetPath || !fontFormat(assetPath)) continue;
        hints.set(assetPath, {
          family,
          style: /font-style\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() || "normal",
          weight: /font-weight\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() || "normal",
        });
      }
    }
  }
  return hints;
}

function sfntFamily(data) {
  if (data.length < 12) return "";
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const signature = String.fromCharCode(...data.subarray(0, 4));
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(view.getUint32(0, false)) && !signature.startsWith("tt")) {
    return "";
  }
  const tableCount = view.getUint16(4, false);
  if (tableCount > 4096) return "";
  let nameOffset = 0;
  for (let index = 0; index < tableCount; index++) {
    const record = 12 + index * 16;
    if (record + 16 > data.length) break;
    if (decodeText(data.subarray(record, record + 4)) === "name") {
      nameOffset = view.getUint32(record + 8, false);
      break;
    }
  }
  if (!nameOffset || nameOffset + 6 > data.length) return "";
  const count = view.getUint16(nameOffset + 2, false);
  const strings = nameOffset + view.getUint16(nameOffset + 4, false);
  const candidates = [];
  for (let index = 0; index < count; index++) {
    const record = nameOffset + 6 + index * 12;
    if (record + 12 > data.length) break;
    const platform = view.getUint16(record, false);
    const nameId = view.getUint16(record + 6, false);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = view.getUint16(record + 8, false);
    const offset = strings + view.getUint16(record + 10, false);
    if (offset + length > data.length || length > 1024) continue;
    const raw = data.subarray(offset, offset + length);
    let value = "";
    if (platform === 0 || platform === 3) {
      let text = "";
      for (let at = 0; at + 1 < raw.length; at += 2) {
        const code = (raw[at] << 8) | raw[at + 1];
        if (code) text += String.fromCharCode(code);
      }
      value = text;
    } else if (platform === 1) {
      value = decodeText(raw);
    }
    value = value.replace(/\0/g, "").trim();
    if (value) candidates.push({ value, score: nameId === 16 ? 2 : 1 });
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.value ?? "";
}

function familyFromFilename(path) {
  return basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]?(thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|black|italic|oblique)(?=[_-]|$).*$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fontStyleFromName(path, fallback = "normal") {
  return /italic|oblique/i.test(path) ? "italic" : fallback;
}

function fontWeightFromName(path, fallback = "normal") {
  const name = path.toLowerCase();
  const weights = [
    ["thin", "100"],
    ["extralight", "200"],
    ["ultralight", "200"],
    ["extra-light", "200"],
    ["light", "300"],
    ["regular", "400"],
    ["book", "400"],
    ["medium", "500"],
    ["semibold", "600"],
    ["semi-bold", "600"],
    ["demibold", "600"],
    ["extrabold", "800"],
    ["extra-bold", "800"],
    ["black", "900"],
    ["bold", "700"],
  ];
  return weights.find(([token]) => name.includes(token))?.[1] ?? fallback;
}

function cssString(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n\f]+/g, " ")}"`;
}

function fontStyle(value, fallback = "normal") {
  const normalized = String(value || "").trim().toLowerCase();
  return /^(?:normal|italic|oblique)$/.test(normalized) ? normalized : fallback;
}

function fontFaceWeight(value, fallback = "normal") {
  const normalized = String(value || "").trim().toLowerCase();
  return /^(?:normal|bold|[1-9]00)$/.test(normalized) ? normalized : fallback;
}

function cssComment(value) {
  return String(value || "").replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ").slice(0, 200);
}

function collectFonts(entries, recognized) {
  const hints = cssFontFaces(entries);
  const fontSetting =
    recognized.kind === "gtk"
      ? recognized.gtkFont
      : recognized.kind === "kde"
        ? recognized.kdeFont
        : recognized.typoraFont;
  const configured = configuredFontFamily(fontSetting);
  const configuredFamilies = fontFamilyNames(fontSetting);
  const configuredMonoFamilies = fontFamilyNames(recognized.typoraMonoFont);
  const selected = [];
  let total = 0;
  let configuredFamilyUsed = false;

  for (const entry of entries) {
    const format = fontFormat(entry.path);
    if (!format || !entry.data.length || entry.data.length > MAX_FONT_BYTES) continue;
    if (selected.length >= MAX_FONTS || total + entry.data.length > MAX_FONT_TOTAL_BYTES) break;
    const hint = hints.get(entry.path);
    const detectedFamily = sfntFamily(entry.data) || familyFromFilename(entry.path);
    const looksMono = /mono|code|console/i.test(detectedFamily) || /mono|code|console/i.test(entry.path);
    if (recognized.kind === "typora") {
      const candidate = String(hint?.family || detectedFamily).toLowerCase();
      const allowed = looksMono ? configuredMonoFamilies : configuredFamilies;
      if (!allowed.some((family) => candidate.includes(family.toLowerCase()))) continue;
    }
    let family = hint?.family || detectedFamily;
    if (!hint?.family && configured && !configuredFamilyUsed && !looksMono) {
      family = configured;
      configuredFamilyUsed = true;
    }
    family = String(family || (looksMono ? "Theme Mono" : "Theme UI")).slice(0, 128);
    const safeBase = basename(entry.path).replace(/[^a-z0-9._-]+/gi, "-").slice(-72) || `font.${extension(entry.path)}`;
    const outputName = `${String(selected.length + 1).padStart(2, "0")}-${safeBase}`;
    selected.push({
      sourcePath: entry.path,
      outputPath: `fonts/${outputName}`,
      cssUrl: `./fonts/${outputName}`,
      data: entry.data,
      mime: format.mime,
      format: format.format,
      family,
      style: fontStyle(hint?.style, fontStyleFromName(entry.path)),
      weight: hint?.weight
        ? fontFaceWeight(hint.weight, fontWeightFromName(entry.path))
        : fontWeightFromName(entry.path),
    });
    total += entry.data.length;
  }

  return selected.map((font) => ({
    ...font,
    faces: `@font-face {\n  font-family: ${cssString(font.family)};\n  src: url(${cssString(font.cssUrl)}) format(${cssString(font.format)});\n  font-style: ${font.style};\n  font-weight: ${font.weight};\n  font-display: swap;\n}`,
  }));
}

function fontStack(fonts, preferred, fallback = "sans-serif") {
  const families = [];
  if (preferred) families.push(preferred);
  for (const font of fonts) {
    if (!families.includes(font.family)) families.push(font.family);
  }
  const quoted = families.map((family) => cssString(family));
  return [...quoted, "system-ui", fallback].join(", ");
}

function completePalette(raw) {
  const bg = raw.bg || "#f6f5f4";
  const fg = raw.fg || contrastText(bg);
  const view = raw.view || bg;
  const accent = raw.accent || "#3584e4";
  const candidateBorder = parseColor(raw.border);
  const border =
    candidateBorder &&
    Math.abs(luminance(candidateBorder) - luminance(bg)) >= 0.018 &&
    Math.abs(luminance(candidateBorder) - luminance(bg)) <= 0.34
      ? candidateBorder
      : mixColors(bg, fg, 0.14);
  return {
    bg,
    fg,
    muted: raw.muted || mixColors(fg, bg, 0.34),
    faint: raw.faint || mixColors(fg, bg, 0.55),
    border,
    borderStrong: raw.borderStrong || mixColors(border, fg, 0.28),
    subtle: raw.subtle || mixColors(bg, fg, 0.055),
    raised: raw.raised || view,
    hover: raw.hover || mixColors(bg, fg, 0.07),
    active: raw.active || mixColors(bg, fg, 0.12),
    accent,
    accentFg: raw.accentFg || contrastText(accent),
  };
}

function parseGtkPalette(css, font) {
  const colors = parseDefineColors(css);
  const rules = cssRules(css);
  const bg =
    parseColor(colors.theme_bg_color) ||
    parseColor(colors.bg_color) ||
    colorFromRules(rules, /(^|,\s*)(\.background|window|headerbar)(\s|$|,|:|\.)/i, "#f6f5f4");
  const fg =
    parseColor(colors.theme_fg_color) ||
    parseColor(colors.fg_color) ||
    foregroundFromRules(rules, /(^|,\s*)(\.background|window|headerbar)(\s|$|,|:|\.)/i, contrastText(bg));
  const view = parseColor(colors.theme_base_color) || parseColor(colors.view_bg_color) || bg;
  const accent =
    parseColor(colors.theme_selected_bg_color) ||
    parseColor(colors.accent_color) ||
    parseColor(colors.selected_bg_color) ||
    colorFromRules(rules, /selection|:selected|\.selected/i, "#3584e4");
  const accentFg =
    parseColor(colors.theme_selected_fg_color) ||
    parseColor(colors.selected_fg_color) ||
    contrastText(accent);
  const border = parseColor(colors.borders) || parseColor(colors.border_color);
  return {
    mode: modeOf(bg),
    font: normalizeFont(font),
    geometry: geometryFromCss(css),
    palette: completePalette({ bg, fg, view, accent, accentFg, border }),
  };
}

function parseKdePalette(source, font = "") {
  const sections = parseIni(source);
  const window3 = sections["Colors:Window"] ?? {};
  const view = sections["Colors:View"] ?? {};
  const button = sections["Colors:Button"] ?? {};
  const selection = sections["Colors:Selection"] ?? {};
  const bg =
    parseColor(window3.BackgroundNormal) ||
    parseColor(button.BackgroundNormal) ||
    parseColor(view.BackgroundNormal) ||
    "#f6f5f4";
  const fg =
    parseColor(window3.ForegroundNormal) ||
    parseColor(button.ForegroundNormal) ||
    contrastText(bg);
  const accent =
    parseColor(selection.BackgroundNormal) ||
    parseColor(button.DecorationFocus) ||
    "#3584e4";
  return {
    mode: modeOf(bg),
    font: normalizeFont(font),
    geometry: { radius: 6, radiusSmall: 4, controlHeight: 32, toolbarHeight: 38, statusHeight: 28 },
    palette: completePalette({
      bg,
      fg,
      view: parseColor(view.BackgroundNormal) || bg,
      accent,
      accentFg: parseColor(selection.ForegroundNormal) || contrastText(accent),
      border: mixColors(bg, fg, 0.16),
    }),
  };
}

function parseTyporaPalette(css, font = "") {
  const variables = parseCssVariables(css);
  const rules = cssRules(css);
  const bg =
    firstCssVariableColor(
      [
        "--bg-color",
        "--background-color",
        "--window-bg-color",
        "--interface-default-bg-color",
        "--writeArea-bg-color",
      ],
      variables,
    ) ||
    colorFromRules(rules, /(^|,\s*)(?:body|html|#write)(?:\s|$|,|:|\.)/i, "#f6f5f4");
  const fg =
    firstCssVariableColor(
      [
        "--text-color",
        "--body-text-color",
        "--writeArea-text-color",
        "--write-area-text-color",
      ],
      variables,
    ) ||
    foregroundFromRules(
      rules,
      /(^|,\s*)(?:body|html|#write)(?:\s|$|,|:|\.)/i,
      contrastText(bg),
    );
  const view =
    firstCssVariableColor(["--side-bar-bg-color", "--sidebar-bg-color"], variables) || bg;
  const subtle =
    firstCssVariableColor(
      ["--code-block-bg-color", "--code-bg-color", "--blockquote-bg-color"],
      variables,
    ) || mixColors(bg, fg, 0.055);
  const hover =
    firstCssVariableColor(
      ["--item-hover-bg-color", "--btn-hover-bg-color", "--control-hover-bg-color"],
      variables,
    ) || mixColors(bg, fg, 0.07);
  const active =
    firstCssVariableColor(["--active-file-bg-color", "--control-active-bg-color"], variables) ||
    mixColors(bg, fg, 0.12);
  const accent =
    firstDistinctCssVariableColor(
      [
        "--theme-color-01",
        "--tw-primary",
        "--todo-bg-color",
        "--search-select-text-color",
        "--link-color",
        "--a-color",
        "--active-text-color",
        "--primary-color",
        "--primary-btn-border-color",
        "--active-file-border-color",
        "--focus-ring-color",
        "--menu-footer-OK-btn-bg-color",
        "--select-text-bg-color",
        "--writeArea-selected-text-bg-color",
      ],
      variables,
      bg,
    ) ||
    foregroundFromRules(
      rules,
      /(^|,\s*)a(?:\s|$|,|:|\.)/i,
      colorFromRules(rules, /selection|:selected|\.selected/i, "#3584e4"),
    );
  const accentFg =
    firstCssVariableColor(
      ["--active-file-text-color", "--select-text-font-color", "--primary-btn-text-color"],
      variables,
    ) || contrastText(accent);
  const border = firstCssVariableColor(
    ["--window-border", "--control-border-color", "--border-color", "--table-border-color"],
    variables,
  );

  return {
    mode: modeOf(bg),
    font: normalizeFont(font),
    geometry: geometryFromCss(css),
    palette: completePalette({
      bg,
      fg,
      view,
      subtle,
      raised: view,
      hover,
      active,
      accent,
      accentFg,
      border,
    }),
  };
}

function samePalette(left, right) {
  return ["bg", "fg", "accent", "raised", "border"].every((key) => left.palette[key] === right.palette[key]);
}

function declarationLines(palette) {
  return [
    `  --bg: ${palette.bg};`,
    `  --fg: ${palette.fg};`,
    `  --fg-muted: ${palette.muted};`,
    `  --fg-faint: ${palette.faint};`,
    `  --border: ${palette.border};`,
    `  --border-strong: ${palette.borderStrong};`,
    `  --bg-subtle: ${palette.subtle};`,
    `  --bg-raised: ${palette.raised};`,
    `  --bg-hover: ${palette.hover};`,
    `  --bg-active: ${palette.active};`,
    `  --accent: ${palette.accent};`,
    `  --accent-fg: ${palette.accentFg};`,
    `  --switch-on: ${palette.accent};`,
    `  --link: ${palette.accent};`,
  ];
}

function renderThemeCss(id, recognized, light, dark, fonts) {
  const uiFonts = fonts.filter((font) => !/mono|code|console/i.test(`${font.family} ${font.sourcePath}`));
  const fontSetting =
    recognized.kind === "gtk"
      ? recognized.gtkFont
      : recognized.kind === "kde"
        ? recognized.kdeFont
        : recognized.typoraFont;
  const configured = configuredFontFamily(fontSetting);
  const preferred = configured || uiFonts[0]?.family || fonts[0]?.family;
  const configuredMono =
    recognized.kind === "typora" ? configuredFontFamily(recognized.typoraMonoFont) : "";
  const mono =
    fonts.find((font) => /mono|code|console/i.test(`${font.family} ${font.sourcePath}`))?.family ||
    configuredMono;
  const fallbackUiFonts = recognized.kind === "typora" ? [] : fonts;
  const uiFont = uiFonts.length
    ? fontStack(uiFonts, preferred)
    : configured
      ? normalizeFont(configured)
      : fallbackUiFonts.length
        ? fontStack(fallbackUiFonts, preferred)
        : normalizeFont("");
  const monoFont = mono ? `${cssString(mono)}, ui-monospace, monospace` : "ui-monospace, monospace";
  const sourceLabel =
    recognized.kind === "gtk"
      ? "GTK / GNOME theme package"
      : recognized.kind === "kde"
        ? "KDE Plasma theme package"
        : "Typora theme";
  const fontCss = fonts.map((font) => font.faces).join("\n\n");
  const css = `/* Generated by Nota Theme Converter from ${cssComment(recognized.name)}. */
/* Source pipeline: ${sourceLabel}. */
/* Palette, typography and geometry are mapped semantically; source widget CSS is not copied. */

${fontCss ? `${fontCss}\n\n` : ""}[data-ui-style="${id}"] {
  --font-ui: ${uiFont};
  --font-mono: ${monoFont};
  --radius: ${light.geometry.radius}px;
  --radius-sm: ${light.geometry.radiusSmall}px;
  --control-height: ${light.geometry.controlHeight}px;
  --toolbar-height: ${light.geometry.toolbarHeight}px;
  --statusbar-height: ${light.geometry.statusHeight}px;
}

[data-ui-style="${id}"][data-ui-mode="light"] {
  color-scheme: light;
${declarationLines(light.palette).join("\n")}
}

[data-ui-style="${id}"][data-ui-mode="dark"] {
  color-scheme: ${dark.palette.bg === light.palette.bg ? "light dark" : "dark"};
${declarationLines(dark.palette).join("\n")}
}
`;
  return { css, uiFont, monoFont: mono || "" };
}

function convertGtkTheme(id, recognized, entries) {
  const light = parseGtkPalette(recognized.lightCss, recognized.gtkFont);
  let dark = recognized.darkCss ? parseGtkPalette(recognized.darkCss, recognized.gtkFont) : light;
  if (samePalette(light, dark)) dark = light;
  const fonts = collectFonts(entries, recognized);
  const rendered = renderThemeCss(id, recognized, light, dark, fonts);
  return {
    id,
    ...rendered,
    light,
    dark,
    mode: light.mode,
    name: recognized.name,
    kind: "gtk",
    pipeline: "gtk",
    fonts,
    sourceKinds: recognized.availableKinds,
  };
}

function convertKdeTheme(id, recognized, entries) {
  let light = parseKdePalette(recognized.colors, recognized.kdeFont);
  let dark = recognized.darkColors ? parseKdePalette(recognized.darkColors, recognized.kdeFont) : light;
  if (light.mode === "dark" && dark.mode === "light") [light, dark] = [dark, light];
  if (samePalette(light, dark)) dark = light;
  const fonts = collectFonts(entries, recognized);
  const rendered = renderThemeCss(id, recognized, light, dark, fonts);
  return {
    id,
    ...rendered,
    light,
    dark,
    mode: light.mode,
    name: recognized.name,
    kind: "kde",
    pipeline: "kde",
    fonts,
    sourceKinds: recognized.availableKinds,
  };
}

function convertTyporaTheme(id, recognized, entries) {
  let light = parseTyporaPalette(recognized.lightCss, recognized.typoraFont);
  let dark = recognized.darkCss
    ? parseTyporaPalette(recognized.darkCss, recognized.typoraFont)
    : light;
  if (light.mode === "dark" && dark.mode === "light") [light, dark] = [dark, light];
  if (light.mode === "dark") dark = light;
  if (samePalette(light, dark)) dark = light;
  const fonts = collectFonts(entries, recognized);
  const rendered = renderThemeCss(id, recognized, light, dark, fonts);
  return {
    id,
    ...rendered,
    light,
    dark,
    mode: light.mode,
    name: recognized.name,
    kind: "typora",
    pipeline: "typora",
    fonts,
    sourceKinds: recognized.availableKinds,
  };
}

export function buildNotaTheme(id, recognized, entries = []) {
  if (recognized.kind === "gtk") return convertGtkTheme(id, recognized, entries);
  if (recognized.kind === "kde") return convertKdeTheme(id, recognized, entries);
  if (recognized.kind === "typora") return convertTyporaTheme(id, recognized, entries);
  throw new Error(`Unsupported conversion pipeline: ${recognized.kind}`);
}

export function recognizeAndConvert(entries, options = {}) {
  const recognized = recognizeThemePackage(entries, options);
  const id = slugify(`${recognized.kind}-${recognized.name}`);
  return { recognized, theme: buildNotaTheme(id, recognized, entries) };
}

function licenseEntries(entries) {
  return entries
    .filter((entry) =>
      /(^|\/)(license|licence|copying|copyright|ofl|notice|third-party)([^/]*)(\.[a-z0-9]+)?$/i.test(entry.path),
    )
    .filter((entry) => entry.data.length <= 512 * 1024)
    .slice(0, 12);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function little16(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function little32(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = textEncoder.encode(name);
    const data = typeof value === "string" ? textEncoder.encode(value) : value;
    const checksum = crc32(data);
    const local = concat([
      little32(0x04034b50),
      little16(20),
      little16(0x0800),
      little16(0),
      little16(0),
      little16(0),
      little32(checksum),
      little32(data.length),
      little32(data.length),
      little16(nameBytes.length),
      little16(0),
      nameBytes,
      data,
    ]);
    localParts.push(local);
    centralParts.push(
      concat([
        little32(0x02014b50),
        little16(20),
        little16(20),
        little16(0x0800),
        little16(0),
        little16(0),
        little16(0),
        little32(checksum),
        little32(data.length),
        little32(data.length),
        little16(nameBytes.length),
        little16(0),
        little16(0),
        little16(0),
        little16(0),
        little32(0),
        little32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }
  const central = concat(centralParts);
  const end = concat([
    little32(0x06054b50),
    little16(0),
    little16(0),
    little16(Object.keys(files).length),
    little16(Object.keys(files).length),
    little32(central.length),
    little32(offset),
    little16(0),
  ]);
  return concat([...localParts, central, end]);
}

export function buildPackageZip({ entries, recognized, theme }) {
  const fontNames = theme.fonts?.length
    ? theme.fonts.map((font) => `- ${font.family} (${font.outputPath})`).join("\n")
    : "- No bundled font files were found; the generated font stack relies on installed system fonts.";
  const readme = `# ${theme.name} for Nota

Generated by Nota Theme Converter.

Source format: ${
    recognized.kind === "gtk"
      ? "GTK / GNOME theme package"
      : recognized.kind === "kde"
        ? "KDE Plasma theme package"
        : "Typora theme"
  }
Conversion pipeline: ${
    recognized.kind === "gtk"
      ? "GTK → Nota UI"
      : recognized.kind === "kde"
        ? "KDE Plasma → Nota UI"
        : "Typora → Nota UI"
  }
Mapped theme ID: ${theme.id}

## Bundled fonts

${fontNames}

## Install

Extract this archive into your Nota configuration directory:

\`\`\`text
themes/ui/${theme.id}/theme.css
\`\`\`

On Linux this is usually:

\`\`\`sh
unzip ${theme.id}-nota-ui.zip -d "$HOME/.config/nota"
\`\`\`

Then restart Nota and choose **${theme.name}** in Appearance.

## Scope

The converter maps palette, typography, corner radius and a practical control
density. GTK or KDE widget selectors are not copied. Bundled font formats
(WOFF2, WOFF, TTF and OTF) are preserved with relative \`@font-face\` URLs.
The source theme's license still applies to derived colors and any included
font or license files.
`;
  const files = {
    [`themes/ui/${theme.id}/theme.css`]: theme.css,
    [`themes/ui/${theme.id}/README.md`]: readme,
  };
  for (const font of theme.fonts ?? []) {
    files[`themes/ui/${theme.id}/${font.outputPath}`] = font.data;
  }
  for (const entry of licenseEntries(entries)) {
    files[`themes/ui/${theme.id}/THEME-LICENSES/${basename(entry.path)}`] = entry.data;
  }
  return makeZip(files);
}
