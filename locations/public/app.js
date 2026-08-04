const socket = io()
const $ = (s, r = document) => r.querySelector(s)
const COLORS = ['#3e63dd', '#e5484d', '#f5a524', '#30a46c', '#8e4ec6', '#e93d82', '#12a594']
const EMOJI = ['🤨', '😂', '👀', '🔪', '🧐', '🙃', '🔥', '🤝']
const LS = { get: (k, d) => localStorage.getItem(k) ?? d, set: (k, v) => localStorage.setItem(k, v) }

let seed = LS.get('seed', Math.random().toString(36).slice(2, 8))
let color = LS.get('color', COLORS[0])
let sound = LS.get('sound', '1') === '1'
let S = null

// протокол-relative, чтобы работало и локально, и на https
const avatarUrl = (s) => '//api.dicebear.com/9.x/thumbs/svg?radius=50&seed=' + encodeURIComponent(s)
const imgUrl = (s) => '//picsum.photos/seed/' + encodeURIComponent(s) + '/900/560'
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/* --- мелкие радости: звук, тосты, эмодзи-салют, тема --- */
function beep(freq = 440, ms = 90) {
  if (!sound) return
  try {
    const ac = (beep.ac ||= new (window.AudioContext || window.webkitAudioContext)())
    const o = ac.createOscillator(), g = ac.createGain()
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.value = 0.04
    o.connect(g).connect(ac.destination)
    o.start()
    o.stop(ac.currentTime + ms / 1000)
  } catch {}
}
function toast(text) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = text
  $('#toasts').append(el)
  setTimeout(() => el.remove(), 3200)
}
function burst(emoji, n = 8) {
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div')
    el.className = 'float'
    el.textContent = emoji
    el.style.left = Math.random() * 100 + 'vw'
    el.style.animationDelay = (Math.random() * 0.6).toFixed(2) + 's'
    $('#fx').append(el)
    setTimeout(() => el.remove(), 3400)
  }
}
const setTheme = (t) => { document.documentElement.dataset.theme = t; LS.set('theme', t) }
setTheme(LS.get('theme', 'dark'))
$('#btn-theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
$('#btn-sound').onclick = (e) => {
  sound = !sound
  LS.set('sound', sound ? '1' : '0')
  e.currentTarget.style.opacity = sound ? 1 : 0.4
  beep(660)
}
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return
  if (e.key === 't') $('#btn-theme').click()
  if (e.key === 's') $('#btn-sound').click()
  if (e.code === 'Space' && S?.state === 'playing' && S.turnId === S.you.id) {
    e.preventDefault()
    socket.emit('next')
  }
})

/* --- экран входа --- */
$('#nick').value = LS.get('nick', '')
$('#avatar-preview').src = avatarUrl(seed)
COLORS.forEach((c) => {
  const b = document.createElement('div')
  b.className = 'sw' + (c === color ? ' on' : '')
  b.style.background = c
  b.onclick = () => {
    color = c
    LS.set('color', c)
    for (const x of $('#swatches').children) x.classList.remove('on')
    b.classList.add('on')
  }
  $('#swatches').append(b)
})
$('#btn-reroll').onclick = () => {
  seed = Math.random().toString(36).slice(2, 8)
  LS.set('seed', seed)
  $('#avatar-preview').src = avatarUrl(seed)
  beep(520, 60)
}
function auth(mode, code) {
  const nick = $('#nick').value.trim() || 'Игрок'
  LS.set('nick', nick)
  socket.emit('auth', { nick, avatar: seed, color, mode, code })
}
$('#btn-quick').onclick = () => auth('quick')
$('#btn-create').onclick = () => auth('create')
$('#btn-join').onclick = () => {
  const c = $('#join-code').value.trim().toUpperCase()
  if (c.length !== 4) return toast('Код — 4 символа')
  auth('join', c)
}
$('#nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-quick').click() })

// ссылка-приглашение: /?r=ABCD
const urlCode = new URLSearchParams(location.search).get('r')
if (urlCode) $('#join-code').value = urlCode.toUpperCase().slice(0, 4)

/* --- чат и реакции --- */
for (const id of ['lobby', 'game']) {
  $('#chat-form-' + id).onsubmit = (e) => {
    e.preventDefault()
    const input = $('input', e.target)
    if (input.value.trim()) socket.emit('chat', input.value)
    input.value = ''
  }
}
EMOJI.forEach((em) => {
  const b = document.createElement('button')
  b.textContent = em
  b.onclick = () => socket.emit('react', em)
  $('#reactions').append(b)
})
$('#copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.origin + '/?r=' + S.code)
    toast('Ссылка скопирована')
  } catch { toast('Код: ' + S.code) }
}
$('#public-toggle').onchange = (e) => socket.emit('setPublic', e.target.checked)
$('#btn-start').onclick = () => socket.emit('start')
$('#btn-next').onclick = () => { socket.emit('next'); beep(500, 60) }
$('#btn-vote').onclick = () => socket.emit('startVote', null)
$('#btn-guess').onclick = () => openGuess()

/* --- рендер --- */
const show = (name) => {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === 'screen-' + name)
}
const avatarImg = (p, cls = '') =>
  `<img class="avatar ${cls}" style="border-color:${p.color}" src="${avatarUrl(p.avatar)}" alt="" />`
const nickOf = (id) => S.players.find((p) => p.id === id)?.nick || '—'

function renderChat(el) {
  el.innerHTML = S.chat.map((m) => m.kind === 'sys'
    ? `<div class="sys">${esc(m.text)}</div>`
    : `<div><b style="color:${m.color}">${esc(m.from)}</b> ${esc(m.text)}</div>`).join('')
  el.scrollTop = el.scrollHeight
}

function render() {
  if (!S) return show('auth')
  const host = S.hostId === S.you.id
  $('#room-badge').textContent = `${S.code} · ${S.players.length}/${S.maxPlayers}`

  if (S.state === 'lobby') {
    show('lobby')
    closeModal()
    $('#copy-code').textContent = S.code
    $('#public-toggle').checked = S.isPublic
    $('#public-toggle').disabled = !host
    $('#lobby-players').innerHTML = S.players.map((p) =>
      '<div class="player">' + avatarImg(p) + '<div><div class="nick">' + esc(p.nick) +
      '</div><div class="tag">' + (p.id === S.hostId ? 'хост' : p.score + ' очк.') + '</div></div></div>').join('')
    $('#topic-picker').innerHTML = [{ id: 'random', name: 'Случайная тема' }, ...S.topics]
      .map((t) => `<button class="chip ${t.id === S.topicId ? 'on' : ''}" data-topic="${t.id}">${esc(t.name)}</button>`).join('')
    for (const b of document.querySelectorAll('[data-topic]')) {
      b.disabled = !host
      b.onclick = () => socket.emit('setTopic', b.dataset.topic)
    }
    $('#btn-start').disabled = !host || S.players.length < S.minPlayers
    $('#lobby-hint').textContent = S.players.length < S.minPlayers
      ? `Нужно ещё ${S.minPlayers - S.players.length} игрока — кинь другу ссылку.`
      : host ? 'Можно начинать.' : 'Ждём хоста.'
    renderChat($('#chat-lobby'))
    return
  }

  show('game')
  const spyView = S.you.isSpy && S.state !== 'ended'
  $('#location-card').className = 'card location-card' + (spyView ? ' spy' : '')
  $('#location-card').innerHTML = spyView
    ? '<div class="meta"><span class="muted small">Тема: ' + esc(S.topicName) + '</span>' +
      '<h2>Ты шпион</h2>' +
      '<p class="muted small">Локацию ты не знаешь. Слушай, отвечай расплывчато и вычисли место.</p>' +
      '<p class="muted small">Варианты: ' + S.pool.map(esc).join(' · ') + '</p></div>'
    : '<img src="' + imgUrl(S.location.img) + '" alt="" loading="lazy" />' +
      '<div class="meta"><span class="muted small">' + esc(S.topicName) + '</span>' +
      '<h2>' + esc(S.location.name) + '</h2>' +
      '<p class="muted small">Отвечай так, чтобы свои поняли, а шпион — нет.</p></div>'

  $('#dir-label').textContent = S.direction > 0 ? '→ по часовой' : '← против часовой'
  $('#ring').innerHTML = S.order.map((id) => {
    const p = S.players.find((x) => x.id === id)
    return p ? `<div class="seat ${id === S.turnId ? 'now' : ''}">${avatarImg(p)}<span>${esc(p.nick)}</span></div>` : ''
  }).join('')

  const myTurn = S.turnId === S.you.id
  $('#btn-next').disabled = S.state !== 'playing' || !(myTurn || host)
  $('#btn-next').textContent = myTurn ? 'Ответил → дальше' : 'Отвечает ' + esc(nickOf(S.turnId))
  $('#btn-vote').disabled = S.state !== 'playing'
  $('#btn-guess').hidden = !S.you.isSpy || S.state === 'ended'
  renderChat($('#chat-game'))

  if (S.state === 'voting') renderVote()
  else if (S.state === 'ended') renderResult()
  else closeModal()
}

const openModal = (html) => { $('#modal-body').innerHTML = html; $('#modal').classList.add('on') }
const closeModal = () => $('#modal').classList.remove('on')

function renderVote() {
  const v = S.vote
  const left = Math.max(0, Math.ceil((v.deadline - Date.now()) / 1000))
  const rows = S.players.filter((p) => p.id !== S.you.id).map((p) =>
    '<button data-vote="' + p.id + '" class="' + (v.myChoice === p.id ? 'primary' : '') + '">' +
    avatarImg(p) + ' ' + esc(p.nick) + '</button>').join('')
  const cancel = v.initiatorId === S.you.id
    ? '<button class="ghost" id="cancel-vote">Отменить голосование</button>'
    : ''
  openModal('<h2>Голосование</h2>' +
    '<p class="muted small">Начал ' + esc(nickOf(v.initiatorId)) +
    (v.targetId ? ' против ' + esc(nickOf(v.targetId)) : '') +
    ' · ' + left + ' с · проголосовало ' + v.voted.length + '/' + S.players.length + '</p>' +
    '<div class="vote-list">' + rows +
    '<button data-vote="skip" class="' + (v.myChoice === 'skip' ? 'primary' : '') + '">Пропустить (скип)</button>' +
    cancel + '</div>')
  for (const b of document.querySelectorAll('[data-vote]')) {
    b.onclick = () => { socket.emit('vote', b.dataset.vote); beep(380, 70) }
  }
  const c = $('#cancel-vote')
  if (c) c.onclick = () => socket.emit('skipVote')
}

function renderResult() {
  const r = S.result
  const title = r.winner === 'crew' ? 'Победили мирные' : r.winner === 'spy' ? 'Победил шпион' : 'Раунд отменён'
  const scores = [...S.players].sort((a, b) => b.score - a.score)
    .map((p) => `<div class="player">${avatarImg(p)}<div><div class="nick">${esc(p.nick)}</div><div class="tag">${p.score} очк.</div></div></div>`).join('')
  const locBlock = r.location
    ? '<img src="' + imgUrl(r.location.img) + '" alt="" style="width:100%;border-radius:10px" />' +
      '<p class="small">Локация: <b>' + esc(r.location.name) + '</b>' +
      (r.spy ? ' · шпион: <b>' + esc(r.spy.nick) + '</b>' : '') + '</p>'
    : ''
  const actions = S.hostId === S.you.id
    ? '<div class="row gap"><button class="primary grow" id="again">Следующий раунд</button><button id="to-lobby">В лобби</button></div>'
    : '<p class="muted small">Ждём хоста…</p>'
  openModal('<h2>' + title + '</h2><p class="muted small">' + esc(r.reason) + '</p>' +
    locBlock + '<div class="players">' + scores + '</div>' + actions)
  const a = $('#again'); if (a) a.onclick = () => socket.emit('start')
  const l = $('#to-lobby'); if (l) l.onclick = () => socket.emit('backToLobby')
}

function openGuess() {
  const opts = S.pool.map((n) => '<button data-guess="' + esc(n) + '">' + esc(n) + '</button>').join('')
  openModal('<h2>Угадать локацию</h2>' +
    '<p class="muted small">Угадаешь — победа. Нет — проиграл сразу.</p>' +
    '<div class="vote-list">' + opts +
    '<button class="ghost" id="guess-cancel">Назад</button></div>')
  for (const b of document.querySelectorAll('[data-guess]')) b.onclick = () => socket.emit('guess', b.dataset.guess)
  $('#guess-cancel').onclick = closeModal
}

/* --- сокет-события --- */
let prevState = null
socket.on('state', (s) => {
  const wasTurn = S && S.turnId === S.you.id
  S = s
  if (prevState !== 'playing' && s.state === 'playing') beep(720, 120)
  if (!wasTurn && s.turnId === s.you.id && s.state === 'playing') { beep(880, 140); toast('Твой ход') }
  if (prevState !== 'ended' && s.state === 'ended' && s.result) {
    burst(s.result.winner === 'spy' ? '🕵️' : '🎉')
  }
  prevState = s.state
  render()
})
socket.on('err', (msg) => toast(msg))
socket.on('react', ({ emoji }) => burst(emoji, 4))
socket.on('disconnect', () => toast('Связь потеряна, переподключаюсь…'))

// таймер раунда / голосования
setInterval(() => {
  if (!S) return
  if (S.endsAt) {
    const left = Math.max(0, S.endsAt - Date.now())
    const m = String(Math.floor(left / 60000)).padStart(2, '0')
    const sec = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
    $('#timer').textContent = m + ':' + sec
  } else {
    $('#timer').textContent = '--:--'
  }
  if (S.state === 'voting') renderVote()
}, 1000)