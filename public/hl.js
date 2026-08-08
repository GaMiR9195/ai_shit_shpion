/* hl.js — thin adapter over highlight.js.

   highlight.js does the actual work: ~190 languages, maintained, fast.
   This file exists only so the rest of the board keeps one small stable
   call, HL.highlight(code, lang) -> HTML. There is no tokenizer here and
   no hand-written keyword tables. */
(function (g) {
  "use strict";

  const esc = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* short names people actually type in the language tag */
  const ALIAS = {
    txt: "plaintext", text: "plaintext", "": "plaintext",
    sh: "bash", shell: "bash", zsh: "bash", console: "bash",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", rs: "rust", golang: "go",
    h: "c", hpp: "cpp", cc: "cpp", "c++": "cpp", cs: "csharp",
    yml: "yaml", md: "markdown", ps1: "powershell", kt: "kotlin",
    docker: "dockerfile", tf: "hcl", vue: "xml", svelte: "xml",
  };

  const norm = (l) => {
    const k = String(l == null ? "" : l).toLowerCase().trim();
    return ALIAS[k] || k;
  };

  const has = (l) => !!(g.hljs && g.hljs.getLanguage(norm(l)));

  /* Auto-detection walks every language in the bundle, so it is fine on a
     snippet and far too slow to run on every keystroke of a long file.
     Past this many characters an untagged card stays plain instead of
     stalling the card you are typing in. */
  const AUTO_MAX = 20000;

  function highlight(code, lang) {
    const src = String(code == null ? "" : code);
    if (!g.hljs) return esc(src);
    const l = norm(lang);
    try {
      if (l && g.hljs.getLanguage(l)) {
        return g.hljs.highlight(src, { language: l, ignoreIllegals: true }).value;
      }
      if (src.length > AUTO_MAX) return esc(src);
      return g.hljs.highlightAuto(src).value;
    } catch (e) {
      return esc(src);
    }
  }

  g.HL = {
    highlight,
    esc,
    has,
    norm,
    get KNOWN() { return g.hljs ? g.hljs.listLanguages() : []; },
  };
})(window);
