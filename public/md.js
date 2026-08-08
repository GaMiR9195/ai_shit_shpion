/* md.js — tiny dependency-free Markdown renderer + minimal code tinter.
   Kept local on purpose: the board must work offline and never lose source text.
   Rendering is always derived from the raw string, so toggling markdown
   on/off is 100% non-destructive. */
(function (g) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* --- very small syntax tinter, keyword based, language aware enough --- */
  const KW = {
    js: "const let var function return if else for while class new await async import export from try catch throw typeof of in null true false undefined this extends default",
    ts: "const let var function return if else for while class new await async import export from try catch throw typeof of in null true false undefined this interface type enum implements extends public private readonly",
    py: "def class return if elif else for while import from as try except raise with lambda None True False and or not in is pass yield global await async",
    go: "func package import return if else for range var const type struct interface go defer chan map nil true false switch case break",
    rust: "fn let mut struct enum impl trait pub use mod match if else for while loop return self Some None Ok Err as ref move where",
    c: "int char float double void return if else for while struct typedef const static sizeof switch case break continue include define",
    java: "public private protected class interface extends implements static final void return new if else for while try catch throw import package this null true false",
    sql: "select from where group by order having join left right inner outer on as insert into values update set delete create table drop alter index limit distinct",
    sh: "if then fi else elif for in do done while case esac function echo export local return set cd",
    css: "import media supports keyframes from to important",
    html: "", json: "", md: "", txt: "",
  };
  KW.jsx = KW.js; KW.tsx = KW.ts; KW.python = KW.py; KW.cpp = KW.c; KW.bash = KW.sh; KW.shell = KW.sh;

  function tint(code, lang) {
    const html = esc(code);
    const words = (KW[lang] || KW.js).split(" ").filter(Boolean);
    if (!words.length) return html;
    const parts = [];
    // protect strings + comments first
    const rx = /("[^"\n]*"|'[^'\n]*'|`[^`]*`)|(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g;
    let last = 0, m;
    const push = (txt) => {
      parts.push(
        txt
          .replace(new RegExp("\\b(" + words.join("|") + ")\\b", "g"), '<span class="tok-k">$1</span>')
          .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-n">$1</span>')
          .replace(/\b([A-Za-z_]\w*)(?=\()/g, '<span class="tok-f">$1</span>')
      );
    };
    while ((m = rx.exec(html))) {
      push(html.slice(last, m.index));
      parts.push('<span class="' + (m[1] ? "tok-s" : "tok-c") + '">' + m[0] + "</span>");
      last = m.index + m[0].length;
    }
    push(html.slice(last));
    return parts.join("");
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  /* ------------------------------------------------------------------ *
   * maths
   *
   * KaTeX does the typesetting (index.html loads it next to the
   * highlighter). Everything here is guarded: with no KaTeX, or on a
   * formula it refuses, the original source is shown as plain text
   * instead. Nothing is ever swallowed.
   *
   * Formulas are lifted out of the source before Markdown runs and put
   * back after, so `$` inside them is never treated as emphasis and the
   * rendered HTML is never escaped. Fenced code is skipped, so a `$` in a
   * shell snippet stays a `$`.
   * ------------------------------------------------------------------ */
  const MATH_LANG = { tex: 1, latex: 1, math: 1, katex: 1 };
  const isMathLang = (l) => !!MATH_LANG[String(l || "").toLowerCase()];

  function math(tex, display) {
    const src = String(tex || "").trim();
    if (!src) return "";
    if (!g.katex) return '<span class="tex-raw">' + esc(display ? "$$" + src + "$$" : "$" + src + "$") + "</span>";
    try {
      return g.katex.renderToString(src, {
        displayMode: !!display,
        throwOnError: false,
        strict: false,
        output: "html",
      });
    } catch (e) {
      return '<span class="tex-bad">' + esc(src) + "</span>";
    }
  }

  /* a whole card of maths: one display block per blank-line-separated stanza */
  function mathBlock(src) {
    return String(src || "")
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => '<div class="tex-block">' + math(s.replace(/^\$+|\$+$/g, ""), true) + "</div>")
      .join("");
  }

  /* pull $$…$$ and $…$ out of the source, outside fenced code only */
  const HOLD = "\u0000";
  function liftMath(src) {
    const held = [];
    const lines = src.split("\n");
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
      if (fence) continue;
      lines[i] = lines[i]
        .replace(/\$\$([^$]+?)\$\$/g, (_, t) => HOLD + (held.push({ t, d: true }) - 1) + HOLD)
        // one-dollar maths needs a non-space first character, so "$5 and $7"
        // is money rather than a formula
        .replace(/\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g, (_, t) => HOLD + (held.push({ t, d: false }) - 1) + HOLD);
    }
    return { text: lines.join("\n"), held };
  }
  function dropMath(html, held) {
    if (!held.length) return html;
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const m = held[+i];
      return m ? math(m.t, m.d) : "";
    });
  }

  function render(src, fallbackLang) {
    if (isMathLang(fallbackLang)) return mathBlock(src);
    const lifted = liftMath(String(src).replace(/\r\n/g, "\n"));
    return dropMath(body(lifted.text, fallbackLang), lifted.held);
  }

  function body(src, fallbackLang) {
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0, list = null;
    const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
    const openList = (t) => { if (list !== t) { closeList(); out.push("<" + t + ">"); list = t; } };

    while (i < lines.length) {
      const ln = lines[i];
      const fence = ln.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        closeList();
        const lang = (fence[1] || fallbackLang || "txt").toLowerCase();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        // ```math / ```tex / ```latex is typeset rather than tinted
        if (isMathLang(lang)) {
          out.push('<div class="tex-block">' + math(buf.join("\n"), true) + "</div>");
          continue;
        }
        out.push('<pre><code data-lang="' + esc(lang) + '">' + hi(buf.join("\n"), lang) + "</code></pre>");
        continue;
      }
      /* `# Title`, `#Title` and `## Title ##` are all one heading. A hand
         that forgot the space still meant a heading — that missing space
         was why typing one did nothing — and a closing run of hashes is
         decoration, not text. `#include`, `#!/bin/sh` and `#fff` stay put:
         those are code that happens to start with a hash. */
      const h = ln.match(/^[ \t]{0,3}(#{1,6})([ \t]*)(.*)$/);
      const heading = h && h[3].trim() && (h[2] ||
        !/^(?:include|define|ifdef|ifndef|endif|elif|else|if|pragma|undef|import|!|[0-9a-fA-F]{3,8}$)/.test(h[3]));
      if (heading) {
        closeList();
        const txt = h[3].replace(/[ \t]+#+[ \t]*$/, "").trim();
        out.push("<h" + h[1].length + ">" + inline(txt) + "</h" + h[1].length + ">");
        i++; continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { closeList(); out.push("<hr>"); i++; continue; }
      const q = ln.match(/^\s*>\s?(.*)$/);
      if (q) { closeList(); out.push("<blockquote>" + inline(q[1]) + "</blockquote>"); i++; continue; }
      const task = ln.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      if (task) {
        openList("ul");
        out.push('<li style="list-style:none;margin-left:-14px"><input type="checkbox" disabled' +
          (task[1].toLowerCase() === "x" ? " checked" : "") + "> " + inline(task[2]) + "</li>");
        i++; continue;
      }
      const ul = ln.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) { openList("ul"); out.push("<li>" + inline(ul[1]) + "</li>"); i++; continue; }
      const ol = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) { openList("ol"); out.push("<li>" + inline(ol[1]) + "</li>"); i++; continue; }
      if (!ln.trim()) { closeList(); i++; continue; }
      closeList();
      const para = [ln];
      i++;
      /* A block that starts on the next line ends this paragraph. A heading
         written straight under a line of prose used to be swallowed into it,
         because this test wanted a space after the hashes. */
      const opens = /^\s*(?:#{1,6}|```|~~~|>|[-*+]\s|\d+[.)]\s|(?:[-*_]\s*){3,}$|\|)/;
      while (i < lines.length && lines[i].trim() && !opens.test(lines[i])) para.push(lines[i++]);
      out.push("<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    closeList();
    return out.join("");
  }

  /* A fenced block goes through the real highlighter when hl.js is loaded,
     and only falls back to the small keyword tinter when the language is
     one it does not know. Same tokens and same class names as the code
     cards, so a block reads identically whether it is its own card or a
     fence inside a note. */
  function hi(code, lang) {
    return window.HL && HL.has(lang) ? HL.highlight(code, lang) : tint(code, lang);
  }

  g.MD = { render, tint, hi, esc, math, mathBlock, isMathLang };
})(window);
