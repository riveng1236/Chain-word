import express from "express";
import http from "http";
import { Server } from "socket.io";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const TURN_MS = 15000;
const MAX_HEARTS = 3;

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// A small local fallback keeps the game playable even without an AI key.
// Add more words here, or configure an AI key for broader validation.
const COMMON_WORDS = new Set(`
apple eagle earth house elephant tiger rabbit tree egg grape elephant
orange engine energy yellow window water river road dog garden night
table earth hotel lemon moon notebook king goat train number radio
ocean nest star rain snake elephant tomato umbrella ant top piano
orange egg game elephant tea apple eagle engine envelope eggplant
lion nut turtle rabbit train nose ear ring grape elephant tree
house earth hammer robot table egg goat tiger rabbit tomato orange
`.trim().split(/\s+/));

function normalizeWord(w) {
  return String(w || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function validLocal(word, room) {
  if (!/^[a-z]+$/.test(word)) return false;
  if (word.length < 2) return false;
  if (room.words.includes(word)) return false;
  if (room.words.length && word[0] !== room.words.at(-1).at(-1)) return false;
  return COMMON_WORDS.has(word);
}

async function validateWord(word, room) {
  if (!/^[a-z]+$/.test(word) || word.length < 2) return { ok: false, reason: "Use an English word (letters only)." };
  if (room.used.has(word)) return { ok: false, reason: "That word was already used." };
  if (room.words.length && word[0] !== room.words.at(-1).at(-1)) {
    return { ok: false, reason: `Your word must start with "${room.words.at(-1).at(-1).toUpperCase()}".` };
  }

  if (!openai) {
    return validLocal(word, room)
      ? { ok: true }
      : { ok: false, reason: "I don't recognize that English word yet." };
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      input: [
        {
          role: "system",
          content: "You validate English words for a word-chain game. Return JSON only: {\"is_english_word\":true|false}. Accept common and legitimate English words, including plurals, inflections, proper nouns only if they are standard dictionary words, and normal modern vocabulary. Do not accept random letter strings."
        },
        { role: "user", content: word }
      ],
      text: { format: { type: "json_object" } }
    });
    const result = JSON.parse(response.output_text);
    return result.is_english_word
      ? { ok: true }
      : { ok: false, reason: "The AI says that isn't a valid English word." };
  } catch {
    return validLocal(word, room)
      ? { ok: true }
      : { ok: false, reason: "Word validation is temporarily unavailable." };
  }
}

function publicRoom(room) {
  return {
    players: room.players.map(p => ({ id: p.id, name: p.name, hearts: p.hearts })),
    started: room.started,
    turn: room.turn,
    words: room.words,
    endsAt: room.endsAt
  };
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit("state", publicRoom(room));
}

function startTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.started || room.players.length !== 2) return;
  clearTimeout(room.timer);
  room.endsAt = Date.now() + TURN_MS;
  io.to(roomId).emit("turnStart", { playerId: room.players[room.turn].id, endsAt: room.endsAt });

  room.timer = setTimeout(() => {
    const current = room.players[room.turn];
    if (!current || !room.started) return;
    current.hearts--;
    io.to(roomId).emit("mistake", {
      playerId: current.id,
      reason: "Time's up!",
      hearts: current.hearts
    });

    if (current.hearts <= 0) {
      room.started = false;
      io.to(roomId).emit("gameOver", { winnerId: room.players[1 - room.turn].id, loserId: current.id });
      broadcast(roomId);
      return;
    }

    room.turn = 1 - room.turn;
    broadcast(roomId);
    startTurn(roomId);
  }, TURN_MS + 150);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }) => {
    let code;
    do code = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(code));
    rooms.set(code, {
      players: [{ id: socket.id, name: String(name || "Player 1").slice(0, 16), hearts: MAX_HEARTS }],
      started: false, turn: 0, words: [], used: new Set(), endsAt: null, timer: null
    });
    socket.join(code);
    socket.emit("roomCreated", { code });
    broadcast(code);
  });

  socket.on("joinRoom", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMessage", "Room not found.");
    if (room.players.length >= 2) return socket.emit("errorMessage", "Room is full.");
    room.players.push({ id: socket.id, name: String(name || "Player 2").slice(0, 16), hearts: MAX_HEARTS });
    socket.join(code);
    socket.emit("joinedRoom", { code });
    broadcast(code);
  });

  socket.on("startGame", ({ code }) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.players.length !== 2 || room.started) return;
    room.started = true;
    room.turn = 0;
    room.words = [];
    room.used.clear();
    room.players.forEach(p => p.hearts = MAX_HEARTS);
    broadcast(code.toUpperCase());
    startTurn(code.toUpperCase());
  });

  socket.on("submitWord", async ({ code, word }) => {
    code = String(code || "").toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.started) return;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.turn) return socket.emit("errorMessage", "It isn't your turn.");
    if (Date.now() > room.endsAt + 100) return;

    word = normalizeWord(word);
    const result = await validateWord(word, room);

    if (/^[a-z]+$/.test(word)) room.used.add(word);

    if (!result.ok) {
      const p = room.players[playerIndex];
      p.hearts--;
      socket.emit("mistake", { playerId: p.id, reason: result.reason, hearts: p.hearts });
      if (p.hearts <= 0) {
        room.started = false;
        clearTimeout(room.timer);
        io.to(code).emit("gameOver", { winnerId: room.players[1 - playerIndex].id, loserId: p.id });
        broadcast(code);
        return;
      }
    } else {
      room.words.push(word);
      room.used.add(word);
      socket.emit("accepted", { word });
    }

    room.turn = 1 - room.turn;
    broadcast(code);
    startTurn(code);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        clearTimeout(room.timer);
        room.players.splice(idx, 1);
        if (room.players.length === 0) rooms.delete(code);
        else {
          room.started = false;
          io.to(code).emit("errorMessage", "The other player disconnected.");
          broadcast(code);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chain Word running on port ${PORT}`));
