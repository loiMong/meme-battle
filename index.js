const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.json({ limit: "12mb" })); // PATCH: TikTok normalize
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// rooms = {
//   ROOMID: {
//     hostId,
//     memes: [ { id, playerName, url, caption, votes } ],
//     votesBySocket: { socketId: memeId },
//     players: { socketId: { id, name } }
//   }
// }
const rooms = {};
// карта сокет -> комната (для очистки при disconnect)
const socketToRoom = {};

const TIKTOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"; // PATCH: TikTok normalize

function extractTikTokVideoId(urlString) {
  try {
    const url = new URL(urlString);
    const pathname = url.pathname || "";
    const patterns = [
      /\/video\/(\d+)/,
      /\/v\/(\d+)\.html/,
      /\/embed\/v2\/(\d+)/,
      /\/embed\/(\d+)/,
    ];
    for (const pattern of patterns) {
      const match = pathname.match(pattern);
      if (match && match[1]) return match[1];
    }
  } catch (e) {
    return null;
  }
  return null;
}

async function resolveTikTokRedirects(rawUrl) {
  let currentUrl = rawUrl;
  let resolvedUrl = rawUrl;
  for (let i = 0; i < 8; i += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": TIKTOK_UA,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      resolvedUrl = currentUrl;
      continue;
    }
    resolvedUrl = currentUrl;
    break;
  }
  return resolvedUrl;
}

function getRoom(roomId) {
  const id = String(roomId).trim().toUpperCase();
  if (!rooms[id]) {
    rooms[id] = {
      hostId: null,
      memes: [],
      votesBySocket: {},
      players: {},
    };
  }
  return { room: rooms[id], id };
}

function getRoomState(roomId) {
  const { room, id } = getRoom(roomId);
  return {
    roomId: id,
    memes: room.memes,
    players: Object.values(room.players || {}), // [{id,name}]
  };
}

function broadcastRoom(roomId) {
  const state = getRoomState(roomId);
  io.to(state.roomId).emit("room_state", state);
}

io.on("connection", (socket) => {
  console.log("Клиент подключился:", socket.id);

  socket.on("join_room", ({ roomId, name, role }) => {
    if (!roomId) return;
    const { room, id } = getRoom(roomId);

    socket.join(id);
    socketToRoom[socket.id] = id;

    if (role === "host") {
      room.hostId = socket.id;
      console.log(`Хост ${socket.id} теперь в комнате ${id}`);
    } else if (role === "player") {
      const playerName = (name || "Игрок").toString();
      room.players[socket.id] = {
        id: socket.id,
        name: playerName,
      };
      console.log(`Игрок ${socket.id} (${playerName}) вошёл в комнату ${id}`);
    } else {
      console.log(`Участник ${socket.id} вошёл в комнату ${id}`);
    }

    broadcastRoom(id);
  });

  socket.on("submit_meme", ({ roomId, playerName, url, caption }) => {
    if (!roomId || !url) return;
    const { room, id } = getRoom(roomId);

    const meme = {
      id:
        Date.now().toString(36) +
        Math.random().toString(36).slice(2),
      playerName: playerName || "Игрок",
      url,
      caption: caption || "",
      votes: 0,
    };

    room.memes.push(meme);
    console.log(`Новый мем в комнате ${id} от ${meme.playerName}`);
    broadcastRoom(id);
  });

  // один голос на сокет за раунд
  socket.on("vote", ({ roomId, memeId }) => {
    if (!roomId || !memeId) return;
    const { room, id } = getRoom(roomId);

    if (!room.votesBySocket) room.votesBySocket = {};

    if (room.votesBySocket[socket.id]) {
      console.log(
        `Сокет ${socket.id} уже голосовал в комнате ${id}, игнорируем`
      );
      return;
    }

    const meme = room.memes.find((m) => m.id === memeId);
    if (!meme) return;

    room.votesBySocket[socket.id] = memeId;
    meme.votes += 1;

    console.log(
      `Голос за мем ${memeId} в комнате ${id}, всего: ${meme.votes}`
    );
    broadcastRoom(id);
  });

  socket.on("clear_memes", ({ roomId }) => {
    if (!roomId) return;
    const { room, id } = getRoom(roomId);
    room.memes = [];
    room.votesBySocket = {};
    console.log(`Мемы очищены в комнате ${id} (новый раунд)`);
    broadcastRoom(id);
  });

  socket.on("disconnect", () => {
    console.log("Клиент отключился:", socket.id);
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      const { room, id } = getRoom(roomId);

      // удалить игрока
      if (room.players && room.players[socket.id]) {
        delete room.players[socket.id];
      }

      // если это был хост — просто чистим hostId
      if (room.hostId === socket.id) {
        room.hostId = null;
      }

      if (room.votesBySocket && room.votesBySocket[socket.id]) {
        delete room.votesBySocket[socket.id];
      }

      delete socketToRoom[socket.id];
      broadcastRoom(id);
    }
  });
});

app.post("/api/normalize-video-link", async (req, res) => {
  // PATCH: TikTok normalize
  const inputUrl = (req.body && req.body.url) || "";
  if (!inputUrl) {
    return res.json({ ok: false, reason: "missing_url" });
  }

  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch (error) {
    return res.json({ ok: false, reason: "invalid_url", error: error.message });
  }

  const host = parsed.hostname.toLowerCase();
  if (!host.includes("tiktok.com")) {
    return res.json({ ok: false, reason: "unsupported_platform" });
  }

  try {
    const resolvedUrl = await resolveTikTokRedirects(inputUrl);
    const videoId = extractTikTokVideoId(resolvedUrl);
    const embedUrl = videoId
      ? `https://www.tiktok.com/embed/v2/${videoId}`
      : null;
    const response = {
      ok: true,
      platform: "tiktok",
      resolvedUrl,
      browserUrl: resolvedUrl,
      embedUrl,
      videoId,
    };
    return res.json(response);
  } catch (error) {
    return res.json({ ok: false, reason: "fetch_failed", error: error.message });
  }
});

// проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("Meme battle server is running");
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
