/* icons.js — file icon pack.

   One family, one stroke weight, 24px box, no plates and no fills, so a
   wall of file cards still reads as one set. Extension table first,
   mime type second, generic binary last. */
(function (g) {
  "use strict";

  /* the page/sheet outline every document icon is built on */
  const SHEET = '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M13.5 3v5.5H19"/>';

  const ICONS = {
    /* ---- documents ---- */
    bin:   '<path d="M12 3.2l8 4.4v8.8L12 20.8 4 16.4V7.6z"/><path d="M12 12l8-4.4M12 12v8.8M12 12L4 7.6"/>',
    doc:   SHEET,
    text:  SHEET + '<path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4"/>',
    rtf:   SHEET + '<path d="M8.5 12.5h7M8.5 15.5h4.5"/><path d="M8.5 18h7"/>',
    pdf:   SHEET + '<path d="M8.4 17.8c3.3-1.5 4.8-4.2 4.4-5.9-.3-1.3-1.7-1-1.7.5 0 2.3 2.5 4.8 4.6 4.5"/>',
    word:  SHEET + '<path d="M8 12.5l1.5 5.5 1.7-4 1.7 4 1.5-5.5"/>',
    ebook: '<path d="M5 4.5h8.5a3 3 0 0 1 3 3V20a2.6 2.6 0 0 0-2.6-2H5z"/><path d="M19 4.5v13.2"/><path d="M16.5 7.5a3 3 0 0 1 2.5-3"/>',
    md:    SHEET + '<path d="M8 18v-5l2 2.4L12 13v5"/><path d="M14.5 13v5M14.5 18l1.8-2M14.5 18l-1.3-1.6"/>',

    /* ---- data ---- */
    sheet: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M9.5 10v9.5M15 10v9.5"/>',
    csv:   '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M12 9.5v10"/>',
    db:    '<ellipse cx="12" cy="6.2" rx="7" ry="2.9"/><path d="M5 6.2v11.6c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6.2"/><path d="M5 12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9"/>',
    json:  '<path d="M9.5 3.5C7.5 3.5 7.5 8 7.5 8s0 4-2.5 4c2.5 0 2.5 4 2.5 4s0 4.5 2 4.5"/><path d="M14.5 3.5c2 0 2 4.5 2 4.5s0 4 2.5 4c-2.5 0-2.5 4-2.5 4s0 4.5-2 4.5"/>',
    log:   SHEET + '<path d="M8.5 12.5h2M12 12.5h3.5M8.5 15.5h5M15 15.5h.5M8.5 18h3"/>',
    cfg:   '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"/>',

    /* ---- code ---- */
    code:  '<path d="M9 7.5L4.5 12 9 16.5"/><path d="M15 7.5L19.5 12 15 16.5"/><path d="M13.2 5.2l-2.4 13.6"/>',
    js:    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M10.2 9v5.2c0 1.3-.7 1.9-1.7 1.9-.8 0-1.4-.4-1.7-1"/><path d="M17.2 10.1c-.4-.7-1-1.1-1.9-1.1-1.1 0-1.8.6-1.8 1.5 0 2 3.9 1.3 3.9 3.6 0 1.1-.9 1.9-2.2 1.9-1 0-1.8-.4-2.2-1.2"/>',
    ts:    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M6.8 9.2h5M9.3 9.2v7"/><path d="M17.6 10.3c-.4-.7-1-1.1-1.8-1.1-1 0-1.7.6-1.7 1.4 0 1.9 3.7 1.3 3.7 3.5 0 1.1-.9 1.8-2.1 1.8-.9 0-1.7-.4-2.1-1.1"/>',
    py:    '<path d="M12 3.2c-2.8 0-4.4.8-4.4 2.6v2.3h4.6v.8H5.9c-1.9 0-3.1 1.4-3.1 4s1.1 4 3.1 4h1.3v-2.6c0-2 1.5-3.3 3.6-3.3h3.4c1.7 0 3-1.2 3-2.8V5.8c0-1.7-1.6-2.6-5.2-2.6z"/><circle cx="9.6" cy="6" r=".9"/>',
    html:  '<path d="M4.6 3.5l1.5 15.2L12 20.5l5.9-1.8 1.5-15.2z"/><path d="M16.4 7.5H8l.35 3.4h7.7l-.6 5.4-3.45 1-3.45-1-.2-2.1"/>',
    css:   '<path d="M4.6 3.5l1.5 15.2L12 20.5l5.9-1.8 1.5-15.2z"/><path d="M16.2 7.5H8.1l.3 3.2h7.4l-.6 5.5-3.2.95-3.2-.95-.2-2.2"/>',
    shell: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4.5"/>',
    diff:  SHEET + '<path d="M9 13h4M11 11v4"/><path d="M9 18h4"/>',

    /* ---- media ---- */
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M20.5 15l-4.5-4.5-6.5 6.5"/>',
    vector:'<rect x="3" y="3" width="4" height="4" rx=".8"/><rect x="17" y="3" width="4" height="4" rx=".8"/><rect x="3" y="17" width="4" height="4" rx=".8"/><rect x="17" y="17" width="4" height="4" rx=".8"/><path d="M7 5h10M5 7v10M19 7v10M7 19h10"/>',
    raw:   '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="12" cy="12" r="3.4"/><path d="M3.5 8h4"/>',
    psd:   '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.2 16.5v-9h2.6a2.4 2.4 0 0 1 0 4.8H8.2"/><path d="M16.4 10.4c-.9-.6-2.6-.5-2.6.5 0 1.4 2.8.8 2.8 2.4 0 1.1-1.6 1.4-2.8.7"/>',
    video: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M10.5 9.5l5 2.5-5 2.5z"/>',
    audio: '<path d="M9.5 17.5V6l9-1.8v11"/><circle cx="7" cy="17.5" r="2.5"/><circle cx="16" cy="15.2" r="2.5"/>',
    sub:   '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M7 14.5h4M13 14.5h4"/>',
    model: '<path d="M12 3.2l8 4.4v8.8L12 20.8 4 16.4V7.6z"/><path d="M12 12l8-4.4M12 12v8.8M12 12L4 7.6"/><path d="M8 5.4l8 4.4"/>',

    /* ---- bundles + system ---- */
    zip:   SHEET + '<path d="M10 4.5h1.6M10 7.5h1.6M10 10.5h1.6M10 13.5h1.6"/><rect x="9.6" y="15.6" width="2.4" height="3.4" rx=".7"/>',
    disk:  '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><rect x="8" y="5" width="8" height="5" rx="1"/><circle cx="12" cy="15" r="2.2"/>',
    exe:   '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/><path d="M9.5 2.8v2.7M14.5 2.8v2.7M9.5 18.5v2.7M14.5 18.5v2.7M2.8 9.5h2.7M2.8 14.5h2.7M18.5 9.5h2.7M18.5 14.5h2.7"/><path d="M10 10h4v4h-4z"/>',
    font:  '<path d="M6.5 19l5.5-14 5.5 14"/><path d="M8.8 13.6h6.4"/>',
    key:   '<circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H21"/><path d="M17.5 12v3.2M20 12v2.2"/>',
    lock:  '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
    torrent:'<circle cx="12" cy="12" r="8.5"/><path d="M12 6.5v7l4 2"/>',
    folder:'<path d="M3.5 6.5a2 2 0 0 1 2-2h3.3l2 2.4h7.7a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  };

  /* extension -> icon. Grouped so it stays editable by hand. */
  const BY_EXT = {};
  const map = (key, list) => list.split(" ").forEach((e) => { if (e) BY_EXT[e] = key; });

  map("image", "png jpg jpeg gif webp avif bmp tiff tif heic heif ico jfif jxl");
  map("vector", "svg ai eps sketch fig xd");
  map("raw", "raw cr2 cr3 nef arw dng orf rw2 raf srw");
  map("psd", "psd psb xcf afphoto afdesign");
  map("video", "mp4 mov avi mkv webm m4v mpg mpeg wmv flv 3gp ogv mts prproj");
  map("audio", "mp3 wav flac aac ogg oga m4a aiff aif alac opus wma mid midi");
  map("sub", "srt vtt ass ssa sub");
  map("model", "obj fbx gltf glb stl 3ds dae blend usdz ply step");

  map("pdf", "pdf");
  map("word", "doc docx odt pages");
  map("doc", "key ppt pptx odp");
  map("rtf", "rtf tex bib");
  map("ebook", "epub mobi azw azw3 djvu fb2");
  map("md", "md markdown mdx rst adoc");
  map("text", "txt text nfo readme me");

  map("sheet", "xls xlsx ods numbers xlsm");
  map("csv", "csv tsv psv");
  map("db", "db sqlite sqlite3 sql mdb accdb parquet avro orc dump bak");
  map("json", "json json5 jsonc jsonl ndjson yaml yml toml plist");
  map("log", "log out err trace");
  map("cfg", "ini cfg conf config properties env editorconfig gitattributes gitignore dockerignore lock");

  map("js", "js mjs cjs jsx");
  map("ts", "ts tsx mts cts d");
  map("py", "py pyc pyw pyi ipynb");
  map("html", "html htm xhtml vue svelte astro ejs hbs pug jinja twig");
  map("css", "css scss sass less styl pcss");
  map("shell", "sh bash zsh fish ps1 bat cmd nu");
  map("diff", "diff patch");
  map("code", "c h cpp hpp cc cxx cs java kt kts scala swift go rs rb php pl pm lua r dart ex exs erl hs clj cljs " +
              "m mm asm zig nim v jl groovy gradle sbt cmake mk makefile dockerfile vim el vb f90 pas ada");
  map("xml", "xml");

  map("zip", "zip rar 7z tar gz tgz bz2 xz zst lz4 cab arj lzh sit");
  map("disk", "iso img dmg vhd vmdk qcow2 toast");
  map("exe", "exe msi app apk ipa deb rpm appimage dll so dylib bin com jar war");
  map("font", "ttf otf woff woff2 eot fon pfb");
  map("key", "pem key pub ppk asc gpg pgp");
  map("lock", "p12 pfx crt cer der keystore jks");
  map("torrent", "torrent");

  BY_EXT.xml = "code";

  const MIME_RULES = [
    [/^image\/svg/, "vector"],
    [/^image\//, "image"],
    [/^video\//, "video"],
    [/^audio\//, "audio"],
    [/^font\//, "font"],
    [/^application\/(zip|x-7z|x-rar|x-tar|gzip|x-bzip)/, "zip"],
    [/^application\/pdf/, "pdf"],
    [/^application\/json/, "json"],
    [/^application\/(x-sh|x-shellscript)/, "shell"],
    [/^application\/(xml|xhtml)/, "code"],
    [/^application\/(x-msdownload|vnd\.debian|x-apple-diskimage)/, "exe"],
    [/^text\/csv/, "csv"],
    [/^text\/html/, "html"],
    [/^text\/css/, "css"],
    [/^text\/markdown/, "md"],
    [/^text\//, "text"],
  ];

  /* filenames that carry meaning without an extension */
  const BY_NAME = {
    dockerfile: "code", makefile: "code", rakefile: "code", gemfile: "code",
    procfile: "cfg", license: "doc", licence: "doc", changelog: "md", readme: "md",
    ".gitignore": "cfg", ".env": "cfg", ".npmrc": "cfg", ".editorconfig": "cfg",
  };

  const extOf = (n) => ((String(n || "").match(/\.([A-Za-z0-9]+)$/) || [])[1] || "").toLowerCase();

  function keyFor(name, mimeType) {
    const n = String(name || "").toLowerCase().trim();
    const base = n.split(/[\\/]/).pop();

    if (BY_NAME[base]) return BY_NAME[base];

    const e = extOf(base);
    if (e && BY_EXT[e]) return BY_EXT[e];

    const m = String(mimeType || "").toLowerCase();
    for (const [rx, key] of MIME_RULES) if (rx.test(m)) return key;

    return "bin";
  }

  const svgFor = (name, mimeType) => ICONS[keyFor(name, mimeType)] || ICONS.bin;

  g.FileIcons = { ICONS, keyFor, svgFor, extOf };
})(window);
