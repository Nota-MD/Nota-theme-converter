# Contributing

Thanks for improving the Nota Theme Converter.

## Before opening a pull request

1. Run `npm test`.
2. Serve the site with `npm start` and test the affected converter page.
3. Try at least one real theme archive when changing recognition or font logic.
4. Keep GTK and KDE behavior in separate pipeline functions.
5. Do not copy source widget selectors into generated Nota CSS.
6. Preserve font files and their license files together.

## Theme fixtures

Tests use small in-memory archives with representative `index.theme`,
`gtk-3.0/gtk.css`, `settings.ini`, `metadata.json`, `contents/colors`,
`kdeglobals` and font files. Add a focused regression test for every new archive
layout.

## Security and privacy

Theme archives are untrusted input. Do not add network requests, remote font
loading, script execution or automatic uploads. Keep archive, entry and font
size limits in place. Validate generated CSS strings and keep assets inside the
exported theme directory.

## Copyright

You must have permission to redistribute any font or theme asset included in a
contribution. Keep all upstream notices and licenses in the source package.
