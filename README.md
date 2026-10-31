# Nota Theme Converter

A local, browser-based theme converter for [Nota](https://github.com/Nota-MD/Nota).
It turns GNOME/GTK and KDE Plasma theme packages into self-contained Nota UI
themes without uploading the source archive.

The converter is deployed independently from the main website:

<https://nota-md.github.io/Nota-theme-converter/>

## Separate pipelines

GTK/GNOME and KDE Plasma have independent recognition and conversion paths:

| Source | What is read | Output |
|---|---|---|
| GTK 3/4 | `@define-color`, widget geometry, `gtk-font-name`, `@font-face` | Light/dark Nota tokens, font stack, bundled fonts |
| KDE Plasma | `Colors:Window`, `Colors:View`, `Colors:Button`, `Colors:Selection`, `kdeglobals`, `@font-face` | Nota tokens, KDE font stack, bundled fonts |

An archive containing both source types is never guessed silently. The selected
page fixes the pipeline, while `recognizeAndConvert(entries, { preferredKind })`
provides the same choice to programmatic callers.

## Bundled fonts

The converter discovers WOFF2, WOFF, TTF and OTF files inside the source package,
reads `@font-face` declarations and native OpenType family names where possible,
and copies the files into the exported theme:

```text
themes/ui/<id>/
├── theme.css
├── fonts/
│   └── 01-ThemeSans-Regular.ttf
├── THEME-LICENSES/
└── README.md
```

Generated CSS uses relative `url("./fonts/...")` paths. The live browser preview
uses temporary Blob URLs, so fonts can be evaluated before download.

Current limits are 16 font files, 8 MiB per file and 24 MiB in total, matching
Nota's theme-resource constraints.

## Development

There is no build step:

```sh
npm test
npm start
```

Open <http://localhost:8000/>.

The project is intentionally dependency-free. It uses browser-native ZIP/gzip
decompression, a bundled XZ decoder and native DOM APIs.

## Package support

- ZIP
- TAR
- TAR.GZ / TGZ
- TAR.XZ / TXZ
- Standalone KDE `.colors` files

Theme packages are processed only in the active browser tab. The converter has
no account, analytics, upload endpoint or remote font dependency.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests and pull requests are welcome.

## License

BSD 2-Clause. See [LICENSE](LICENSE). The bundled XZ decoder is distributed under
the BSD Zero Clause License; its notice is in
[`assets/vendor/XZ-NOTICE.txt`](assets/vendor/XZ-NOTICE.txt).
