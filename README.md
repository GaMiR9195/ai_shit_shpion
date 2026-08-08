# SPACE

Infinite canvas board. Notes, code cards, sketches, files, file shelves, web
cards, smart-draw vectors, shared files and live cursors.

## Run it

```bash
npm install
npm start
```

Opens on `http://localhost:3000`.

`@chenglou/pretext` is a **required** dependency. It is imported directly in
`public/index.html`:

```js
import * as Pretext from "@chenglou/pretext";
window.Pretext = Pretext;
```

There is no fallback and no null. If it is not installed the board does not
start and the console says so. The server resolves the installed package and
serves it at `/vendor/pretext/*`, injecting the import map into `index.html`.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway dashboard -> **New Project** -> **Deploy from GitHub repo** -> pick it.
3. Railway detects Node, runs `npm install`, then `npm start`.
4. Service **Settings -> Networking -> Generate Domain**.
5. Service **Settings -> Volumes -> Add Volume**, mount at `/data`,
   and set `STORAGE_DIR=/data/storage`.

Without a volume the board still works, but uploaded files and room state are
lost on redeploy.

### Environment

| variable | default | meaning |
| --- | --- | --- |
| `PORT` | `3000` | set by Railway automatically |
| `STORAGE_DIR` | `./storage` | where files and rooms are written |
| `MAX_UPLOAD_MB` | `50` | per-file upload cap |

## Rooms

Everyone on the same room sees the same board, the same shared files and each
other's cursors.

```
https://your-app.up.railway.app/?room=team
```

No room means `main`.

## Libraries

| what | why |
| --- | --- |
| `@chenglou/pretext` | text measurement without DOM reflow. Required. |
| `highlight.js` | syntax highlighting, ~190 languages, loaded from its official CDN build |
| `KaTeX` | maths in markdown and in `math` / `tex` / `latex` cards, loaded from its official CDN build |

`public/geom.js` is written here on purpose. Stroke recognisers such as `$1`
and Paper.js classify a stroke into a fixed template and draw arrowheads as a
filled triangle. This board draws the head as two open barbs taken from the
lengths and angles you actually drew, so it never produces a triangle and
never turns an arrow into an arrow-made-of-arrows. Every head is made at one
size, and each barb then carries a handle of its own, so either end can be
moved without touching the other. **Relax** settles the nodes that are there
— kinks pulled out, spacing evened, ends held — rather than re-running
recognition over them, which used to change the node count under your hands.

## Layout

```
server.js            HTTP + WebSocket, file storage, room persistence
public/index.html    imports Pretext, loads the board
public/app.js        the board
public/geom.js       smart draw: stroke -> line, arrow, ellipse, rect, polygon
public/field.js      the soft glow under clusters (scalar field)
public/tidy.js       coupling: compacts without losing arrangement
public/store.js      IndexedDB file storage + upload/share
public/net.js        WebSocket sync, per-field last-writer-wins, peer cursors
public/icons.js      file-type icons
public/hl.js         thin adapter over highlight.js
public/md.js         markdown renderer + KaTeX maths
public/zip.js        zip reading and writing, no dependencies
public/style.css     all styling
```

## Files, shelves and archives

A file dropped on the board becomes a card. Several files can share one
**shelf**: a plain field of rows that grows downward by exactly one row per
file, with rows you can carry up and down inside it.

| do this | get that |
| --- | --- |
| drop a file onto another file | a shelf holding both |
| right click a `.zip` -> **Extract** | a shelf of what was inside |
| right click a shelf -> **Zip** | one `.zip` card beside it |
| select several cards -> **Zip** | the same, from the selection |
| select several cards -> **Download n as .zip** | one archive, saved to disk |

Packing and unpacking is `public/zip.js`: deflate through the browser's own
`CompressionStream`, stored entries when that is missing or would be larger.

An `.html` file or a bare link becomes a **web card**. It arrives as a
bookmark with `Render: off`; turning rendering on runs the page in a sandboxed
frame. The frame only accepts the pointer while its card is selected, so
dragging a card never reaches into the page inside it.

## Maths

A code card whose language is `math`, `tex` or `latex` is typeset instead of
highlighted, as is `$…$` and `$$…$$` inside markdown. Anything KaTeX cannot
parse is shown as its own source rather than swallowed.

## Keys

| key | action |
| --- | --- |
| right click | menu, anywhere |
| `D` | smart draw |
| `G` | coupling |
| `Ctrl` + drag | box select |
| `Ctrl` held, smart draw on | move cards and points instead of inking |
| `Ctrl` + wheel | zoom |
| double click a name | rename in place |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | undo / redo |
