import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'
import { TOPICS } from './topics.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000
const MAX_PLAYERS = 10
const MIN_PLAYERS = 3
const ROUND_MS = 8 * 60 * 1000
const VOTE_MS = 45 * 1000

const app = express()
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }))
app.get('/healthz', (_req, res) => res.type('text').send('ok'))

const server = createServer(app)
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 })

const rooms = new Map()

const rnd = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[rnd(a.length)]
const shuffle = (a) => {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) { const j = rnd(i + 1); [r[i], r[j]] = [r[j], r[i]] }
  return r
}
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 4; i++) s += A[rnd(A.length)]
  return rooms.has(s) ? newCode() : s
}

function createRoom(isPublic = true) {
  const room = {
    code: newCode(), isPublic, hostId: null, players: [],
    state: 'lobby', // lobby | playing | voting | ended
    topicId: 'random', round: 0,
    topicName: null, pool: [], location: null, spyId: null,
    order: [], turnIndex: 0, direction: 1,
    endsAt: null, vote: null, result: null, chat: []
  }
  rooms.set(room.code, room)
  return room
}

// автопоиск: добиваем самое заполненное публичное лобби
function findRoom() {
  let best = null
  for (const r of rooms.values()) {
    if (!r.isPublic || r.state !== 'lobby') continue
    if (r.players.length === 0 || r.players.length >= MAX_PLAYERS) continue
    if (!best || r.players.length > best.players.length) best = r
  }
  return best || createRoom(true)
}

const getPlayer = (room, id) => room.players.find((p) => p.id === id)

function say(room, text) {
  room.chat.push({ kind: 'sys', text, at: Date.now() })
  if (room.chat.length > 80) room.chat.shift()
}

function view(room, id) {
  const isSpy = room.spyId === id
  const revealed = room.state === 'ended'
  return {
    code: room.code, isPublic: room.isPublic, hostId: room.hostId,
    state: room.state, round: room.round,
    topicId: room.topicId, topicName: room.topicName,
    topics: TOPICS.map((t) => ({ id: t.id, name: t.name })),
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: room.players.map((p) => ({
      id: p.id, nick: p.nick, avatar: p.avatar, color: p.color, score: p.score
    })),
    order: room.order,
    turnId: room.order[room.turnIndex] ?? null,
    direction: room.direction,
    endsAt: room.endsAt,
    pool: room.state === 'lobby' ? [] : room.pool,
    location: revealed || !isSpy ? room.location : null, // шпион локацию не видит
    you: { id, isSpy: room.state === 'lobby' ? false : isSpy },
    vote: room.vote && {
      initiatorId: room.vote.initiatorId,
      targetId: room.vote.targetId,
      deadline: room.vote.deadline,
      voted: Object.keys(room.vote.votes),
      myChoice: room.vote.votes[id] ?? null
    },
    result: room.result,
    chat: room.chat.slice(-40)
  }
}

function sync(room) {
  for (const p of room.players) io.to(p.id).emit('state', view(room, p.id))
}

function startRound(room) {
  if (room.players.length < MIN_PLAYERS) return
  const topic = room.topicId === 'random'
    ? pick(TOPICS)
    : TOPICS.find((t) => t.id === room.topicId) || pick(TOPICS)

  room.topicName = topic.name
  room.pool = topic.items.map((i) => i.name)
  room.location = pick(topic.items)
  room.spyId = pick(room.players).id
  room.order = shuffle(room.players.map((p) => p.id)) // порядок — рандом
  room.direction = Math.random() < 0.5 ? 1 : -1       // направление — рандом
  room.turnIndex = rnd(room.order.length)             // первый отвечающий — рандом
  room.state = 'playing'
  room.vote = null
  room.result = null
  room.endsAt = Date.now() + ROUND_MS
  room.round++
  say(room, `Раунд ${room.round}. Тема «${topic.name}». Круг идёт ${room.direction > 0 ? '→ по часовой' : '← против часовой'}.`)
  sync(room)
}

function finish(room, winner, reason) {
  const spy = getPlayer(room, room.spyId)
  for (const p of room.players) {
    if (winner === 'spy' && p.id === room.spyId) p.score += 3
    if (winner === 'crew' && p.id !== room.spyId) p.score += 2
  }
  room.result = {
    winner, reason,
    spy: spy ? { id: spy.id, nick: spy.nick, avatar: spy.avatar, color: spy.color } : null,
    location: room.location
  }
  room.state = 'ended'
  room.vote = null
  room.endsAt = null
  say(room, reason)
  sync(room)
}

function nextTurn(room, steps = 1) {
  const n = room.order.length
  if (!n) return
  room.turnIndex = ((room.turnIndex + room.direction * steps) % n + n) % n
}

function tally(room) {
  if (!room.vote) return
  const counts = {}
  for (const c of Object.values(room.vote.votes)) counts[c] = (counts[c] || 0) + 1
  const need = Math.floor(room.players.length / 2) + 1
  const [topChoice, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || []

  if (!topChoice || topChoice === 'skip' || topCount < need) {
    say(room, 'Голосование ни к чему не привело — играем дальше.')
    room.vote = null
    room.state = 'playing'
    nextTurn(room)
    return sync(room)
  }

  const accused = getPlayer(room, topChoice)
  if (!accused) { room.vote = null; room.state = 'playing'; return sync(room) }
  if (accused.id === room.spyId) finish(room, 'crew', `${accused.nick} — шпион. Поймали!`)
  else finish(room, 'spy', `${accused.nick} оказался чист. Шпион победил.`)
}

io.on('connection', (socket) => {
  let room = null
  const me = () => (room ? getPlayer(room, socket.id) : null)
  const isHost = () => room && room.hostId === socket.id

  socket.on('auth', (data = {}) => {
    if (room) return
    const nick = clean(data.nick, 14) || 'Игрок'
    const avatar = clean(data.avatar, 40) || nick
    const color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : '#3e63dd'

    if (data.mode === 'join') {
      room = rooms.get(clean(data.code, 4).toUpperCase())
      if (!room) return socket.emit('err', 'Лобби не найдено')
      if (room.players.length >= MAX_PLAYERS) return socket.emit('err', 'Лобби заполнено')
    } else if (data.mode === 'create') {
      room = createRoom(data.isPublic !== false)
    } else {
      room = findRoom()
    }

    room.players.push({ id: socket.id, nick, avatar, color, score: 0 })
    if (!room.hostId) room.hostId = socket.id
    socket.join(room.code)
    say(room, room.state === 'lobby'
      ? `${nick} в лобби.`
      : `${nick} зашёл — играет со следующего раунда.`)
    sync(room)
  })

  socket.on('setTopic', (topicId) => {
    if (!isHost() || room.state !== 'lobby') return
    room.topicId = topicId === 'random' || TOPICS.some((t) => t.id === topicId) ? topicId : 'random'
    sync(room)
  })

  socket.on('setPublic', (v) => {
    if (!isHost()) return
    room.isPublic = !!v
    sync(room)
  })

  socket.on('start', () => {
    if (!isHost() || room.state === 'playing' || room.state === 'voting') return
    if (room.players.length < MIN_PLAYERS) return socket.emit('err', `Нужно минимум ${MIN_PLAYERS} игрока`)
    startRound(room)
  })

  socket.on('backToLobby', () => {
    if (!isHost() || room.state === 'playing' || room.state === 'voting') return
    room.state = 'lobby'
    room.result = null
    room.location = null
    room.spyId = null
    room.order = []
    sync(room)
  })

  socket.on('next', () => {
    if (room?.state !== 'playing') return
    if (socket.id !== room.order[room.turnIndex] && !isHost()) return
    nextTurn(room)
    sync(room)
  })

  socket.on('startVote', (targetId) => {
    if (room?.state !== 'playing') return
    const target = targetId ? getPlayer(room, targetId) : null
    room.state = 'voting'
    room.vote = {
      initiatorId: socket.id,
      targetId: target ? target.id : null,
      votes: {},
      deadline: Date.now() + VOTE_MS
    }
    say(room, `${me()?.nick} начал голосование${target ? ` против ${target.nick}` : ''}.`)
    sync(room)
  })

  socket.on('vote', (choice) => {
    if (room?.state !== 'voting' || !room.vote) return
    if (choice !== 'skip' && !getPlayer(room, choice)) return
    room.vote.votes[socket.id] = choice
    if (Object.keys(room.vote.votes).length >= room.players.length) tally(room)
    else sync(room)
  })

  // скип всего голосования — только инициатор или хост
  socket.on('skipVote', () => {
    if (room?.state !== 'voting' || !room.vote) return
    if (socket.id !== room.vote.initiatorId && !isHost()) return
    say(room, 'Голосование отменено.')
    room.vote = null
    room.state = 'playing'
    sync(room)
  })

  socket.on('guess', (name) => {
    if (!room || (room.state !== 'playing' && room.state !== 'voting')) return
    if (socket.id !== room.spyId) return
    const guess = clean(name, 60)
    if (guess === room.location.name) finish(room, 'spy', `Шпион угадал локацию: ${room.location.name}.`)
    else finish(room, 'crew', `Шпион ошибся (${guess}). Локация — ${room.location.name}.`)
  })

  socket.on('chat', (text) => {
    if (!room) return
    const t = clean(text, 160)
    if (!t) return
    room.chat.push({ kind: 'msg', from: me()?.nick, color: me()?.color, text: t, at: Date.now() })
    if (room.chat.length > 80) room.chat.shift()
    sync(room)
  })

  socket.on('react', (emoji) => {
    if (!room) return
    io.to(room.code).emit('react', { emoji: clean(emoji, 4), from: me()?.nick })
  })

  socket.on('disconnect', () => {
    if (!room) return
    const p = me()
    const wasSpy = room.spyId === socket.id
    room.players = room.players.filter((x) => x.id !== socket.id)
    room.order = room.order.filter((x) => x !== socket.id)
    if (room.turnIndex >= room.order.length) room.turnIndex = 0
    if (room.vote) delete room.vote.votes[socket.id]
    if (room.hostId === socket.id) room.hostId = room.players[0]?.id ?? null
    if (p) say(room, `${p.nick} вышел.`)

    if (!room.players.length) return void rooms.delete(room.code)

    if ((room.state === 'playing' || room.state === 'voting') && room.players.length < MIN_PLAYERS) {
      finish(room, 'none', 'Слишком мало игроков — раунд отменён.')
    } else if ((room.state === 'playing' || room.state === 'voting') && wasSpy) {
      finish(room, 'crew', 'Шпион сбежал из игры. Победа мирных.')
    } else {
      sync(room)
    }
  })
})

// таймеры раунда и голосования
setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.state === 'voting' && room.vote && now > room.vote.deadline) { tally(room); continue }
    if (room.state === 'playing' && room.endsAt && now > room.endsAt) {
      finish(room, 'spy', 'Время вышло — шпиона не нашли.')
    }
  }
}, 1000)

server.listen(PORT, () => console.log('locations on :' + PORT))