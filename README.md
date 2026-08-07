# SPACE

Infinite canvas board. Notes, code cards, sketches, files, smart-draw vectors,
shared files and live cursors.

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

`public/geom.js` is written here on purpose. Stroke recognisers such as `$1`
and Paper.js classify a stroke into a fixed template and draw arrowheads as a
filled triangle. This board draws the head as two open barbs taken from the
lengths and angles you actually drew, so it never produces a triangle and
never turns an arrow into an arrow-made-of-arrows.

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
public/md.js         markdown renderer
public/style.css     all styling
```

## Keys

| key | action |
| --- | --- |
| right click | menu, anywhere |
| `D` | smart draw |
| `G` | coupling |
| `Ctrl` + drag | box select |
| `Ctrl` + wheel | zoom |
| double click a name | rename in place |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | undo / redo |
