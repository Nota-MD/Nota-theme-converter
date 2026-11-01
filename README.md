# Nota Theme Converter

A local, browser-based theme converter for [Nota](https://github.com/Nota-MD/Nota).
It turns Typora, GNOME/GTK and KDE Plasma themes into self-contained Nota UI
themes without uploading the source files.

The converter is deployed independently from the main website:

<https://nota-md.github.io/Nota-theme-converter/>

## Separate pipelines

Typora, GTK/GNOME and KDE Plasma have independent recognition and conversion
paths:

| Source | What is read | Output |
|---|---|---|
| Typora | `--bg-color`, `--text-color`, sidebar/hover/active tokens, local `@import`, `@font-face` | Light/dark pairs, Nota tokens, font stack, bundled fonts |
| GTK 3/4 | `@define-color`, widget geometry, `gtk-font-name`, `@font-face` | UI theme + matching document theme, light/dark tokens, font stack, bundled fonts |
| KDE Plasma | `Colors:Window`, `Colors:View`, `Colors:Button`, `Colors:Selection`, `kdeglobals`, `@font-face` | UI theme + matching document theme, light/dark tokens, KDE font stack, bundled fonts |

An archive containing both source types is never guessed silently. The selected
page fixes the pipeline, while `recognizeAndConvert(entries, { preferredKind })`
provides the same choice to programmatic callers.

## Bundled fonts

The converter discovers WOFF2, WOFF, TTF and OTF files inside the source package,
reads `@font-face` declarations and native OpenType family names where possible,
and copies matching files into the exported theme. For Typora, document serif
faces stay in the document theme pipeline and are not used as Nota's UI font.

```text
themes/ui/<id>/
├── theme.css
├── fonts/
│   └── 01-ThemeSans-Regular.ttf
├── THEME-LICENSES/
└── README.md

document/<id>/
├── theme.css
├── fonts/
├── THEME-LICENSES/
└── README.md

document/dark/<id>.css     # Imported as <id>-dark
```

Generated CSS uses relative `url("./fonts/...")` paths. The live browser preview
uses temporary Blob URLs, so fonts can be evaluated before download.

Current limits are 16 font files, 32 MiB per file and 48 MiB in total, matching
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

- Standalone Typora `.css` files
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
