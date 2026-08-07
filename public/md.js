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

  function render(src, fallbackLang) {
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
        out.push('<pre><code data-lang="' + esc(lang) + '">' + hi(buf.join("\n"), lang) + "</code></pre>");
        continue;
      }
      const h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
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
      while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
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

  g.MD = { render, tint, hi, esc };
})(window);
