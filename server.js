require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

const server = https.createServer({
  key:  fs.readFileSync(process.env.SSL_KEY_PATH),
  cert: fs.readFileSync(process.env.SSL_CERT_PATH),
}, app);
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}

function timeToMin(t) {
  const [time, ampm] = t.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function minToTime(mins) {
  let h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

const schedule = JSON.parse(fs.readFileSync(path.join(__dirname, 'schedule.json'), 'utf8'));
const stageTimes = schedule.map(s => timeToMin(s.time));

const TICK_MS = 150;

const state = {
  phase: 'waiting',
  stage: 0,
  time: schedule[0].time,
  timeMin: timeToMin(schedule[0].time),
  prompt: '',
  options: [],
  choices: [],
};

let clockTimer = null;

function broadcastState() {
  broadcast({ type: 'state', state });
  sendArduinoLeds();
}

function stopClock() {
  clearInterval(clockTimer);
}

function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, TICK_MS);
}

function tick() {
  state.timeMin++;
  state.time = minToTime(state.timeMin);

  if (state.stage < schedule.length && state.timeMin >= stageTimes[state.stage]) {
    stopClock();
    startStage();
    return;
  }

  broadcastState();
}

function startStage() {
  const s = schedule[state.stage];

  if (s.end) {
    state.phase = 'done';
    state.prompt = '';
    state.options = [];
    broadcastState();
    return;
  }

  state.phase = 'choosing';
  state.time = s.time;
  state.timeMin = stageTimes[state.stage];
  state.prompt = s.prompt || '';
  state.options = s.options;
  broadcastState();
}

function pickOption(label) {
  if (state.phase !== 'choosing') return;
  const s = schedule[state.stage];
  if (!s || !s.options) return;
  const opt = s.options.find(o => o.label === label);
  if (!opt) return;

  state.choices.push({
    stage: state.stage,
    label: opt.label,
    action: opt.action,
    room: opt.room,
    sticker: opt.sticker,
  });

  state.stage++;
  state.options = [];
  state.prompt = '';
  state.phase = 'acting';
  broadcastState();
  startClock();
}

function resetGame() {
  stopClock();
  state.phase = 'waiting';
  state.stage = 0;
  state.time = schedule[0].time;
  state.timeMin = timeToMin(schedule[0].time);
  state.prompt = '';
  state.options = [];
  state.choices = [];
  broadcastState();
}

function ledsForState() {
  if (state.phase !== 'choosing') return [false, false, false];
  const opts = state.options || [];
  return [
    opts.length >= 1,
    opts.length >= 2,
    opts.length >= 3,
  ];
}

function sendArduinoLeds() {
  const leds = ledsForState();
  const msg = JSON.stringify(leds);
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c.isArduino) c.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  ws.isArduino = req.url === '/arduino';

  if (ws.isArduino) {
    ws.send(JSON.stringify(ledsForState()));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(msg) || msg.length !== 3) return;
      const labels = ['A', 'B', 'C'];
      const pressed = labels.find((_, i) => msg[i] === true);
      if (pressed) pickOption(pressed);
    });
    return;
  }

  ws.send(JSON.stringify({ type: 'state', state }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'pick') {
      pickOption(msg.label);
    }

    if (msg.type === 'start') {
      resetGame();
      state.timeMin = stageTimes[0] - 1;
      state.time = minToTime(state.timeMin);
      startClock();
    }

    if (msg.type === 'reset') {
      resetGame();
    }

    if (msg.type === 'speedup') {
      if (state.phase === 'acting') {
        const nextHour = Math.ceil((state.timeMin + 1) / 60) * 60;
        state.timeMin = nextHour - 1;
        state.time = minToTime(state.timeMin);
      }
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Run: lsof -ti :${PORT} | xargs kill -9`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Server running at https://localhost:${PORT}`);
});


