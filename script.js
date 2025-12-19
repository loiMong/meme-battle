document.addEventListener("DOMContentLoaded", () => {
  // === сервер ===
  const SERVER_URL =
    "https://1b8743df-1494-417e-9710-39a675931056-00-1adskqvejskyp.janeway.replit.dev";

  let socket = null;
  try {
    socket = io(SERVER_URL);
  } catch (e) {
    console.warn("Нет соединения с socket.io", e);
  }

  // === экраны / роль ===
  let role = null; // "host" | "player"
  const screens = document.querySelectorAll(".screen");
  let currentScreenId = "screen-role";

  function showScreen(id) {
    screens.forEach((s) =>
      s.id === id ? s.classList.add("active") : s.classList.remove("active")
    );
    currentScreenId = id;
  }

  // === состояние ===
  const state = {
    players: [],
    memes: [],
    round: 1,
  };
  let currentRoomId = null;
  let hasVotedThisRound = false;
  let playerNick = "";

  function pushDebug(message) {
    // PATCH: TikTok normalize
    console.debug(`[debug] ${message}`);
  }

  // === общие элементы ===
  const roomLabel = document.getElementById("room-label");
  const roomIdInput = document.getElementById("room-id-input");
  const btnApplyRoom = document.getElementById("btn-apply-room");

  let roomShareBox = null;
  if (roomIdInput) {
    const card = roomIdInput.closest(".card");
    if (card) {
      roomShareBox = document.createElement("div");
      roomShareBox.id = "room-share-box";
      roomShareBox.className = "hint small";
      card.appendChild(roomShareBox);
    }
  }

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  function updateRoomLabel() {
    if (!roomLabel) return;
    if (currentRoomId && role === "host") {
      roomLabel.textContent = `— комната ${currentRoomId}`;
    } else {
      roomLabel.textContent = "";
    }
  }

  function updateRoomShare() {
    if (!roomShareBox) return;
    if (!currentRoomId || role !== "host") {
      roomShareBox.textContent =
        "Игра без комнаты — все играют на этом экране.";
      return;
    }

    const url =
      window.location.origin +
      window.location.pathname +
      "?room=" +
      encodeURIComponent(currentRoomId);

    roomShareBox.innerHTML =
      `Ссылка для игроков:<br><span class="share-link">${url}</span>`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Скопировать ссылку";
    btn.className = "secondary";
    btn.style.marginTop = "0.5rem";

    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        alert("Ссылка скопирована в буфер обмена");
      } catch (e) {
        alert("Не вышло скопировать автоматически, скопируй вручную.");
      }
    });

    roomShareBox.appendChild(document.createElement("br"));
    roomShareBox.appendChild(btn);
  }

  function resetGame() {
    state.players = [];
    state.memes = [];
    state.round = 1;
    hasVotedThisRound = false;
    renderPlayers();
    renderMemesPreview();
    if (btnStartRound) btnStartRound.disabled = true;
    if (btnGoVote) btnGoVote.disabled = true;
  }

  // === media helpers ===
  function normalizeYouTubeUrl(raw) {
    try {
      const url = new URL(raw);
      let videoId = null;
      if (url.hostname.includes("youtu.be")) {
        videoId = url.pathname.replace("/", "").split("/")[0];
      }
      if (!videoId && url.searchParams.get("v")) {
        videoId = url.searchParams.get("v");
      }
      if (!videoId) {
        const shortsMatch = url.pathname.match(/shorts\/([^/?]+)/);
        if (shortsMatch) videoId = shortsMatch[1];
      }
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}`;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  async function normalizeMediaUrl(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("blob:")) return trimmed;

    const yt = normalizeYouTubeUrl(trimmed);
    if (yt) return yt;

    // TikTok short-links are handled by normalizeVideoLink() via server.
    return trimmed;
  }

  async function normalizeVideoLink(rawUrl) {
    // PATCH: TikTok normalize (server-side)
    const trimmed = (rawUrl || "").trim();
    if (!trimmed) return "";

    // Do not touch local blob/data urls
    if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return trimmed;

    try {
      const response = await fetch("/api/normalize-video-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });

      if (!response.ok) {
        pushDebug(`normalize failed http=${response.status}`);
        return "";
      }

      const data = await response.json();
      pushDebug(
        `normalize result ok=${data?.ok} embed=${Boolean(
          data?.embedUrl
        )} browser=${Boolean(data?.browserUrl)}`
      );

      if (data && data.ok) {
        return data.embedUrl || data.browserUrl || "";
      }
    } catch (e) {
      pushDebug(`normalize error: ${e?.message || String(e)}`);
    }

    return "";
  }

  function getMediaMeta(url) {
    const lower = String(url || "").toLowerCase();
    if (lower.includes("tiktok.com")) {
      return { type: "embed", aspect: "9 / 16", platform: "tiktok" };
    }
    if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
      return { type: "embed", aspect: "16 / 9", platform: "youtube" };
    }
    if (lower.match(/\.mp4|\.webm|\.ogg/)) {
      return { type: "video", aspect: "16 / 9" };
    }
    return { type: "image" };
  }

  function createMediaElement(meme) {
    const meta = getMediaMeta(meme.url || "");
    const wrapper = document.createElement("div");
    wrapper.className = "meme-media";
    if (meta.aspect) {
      wrapper.style.aspectRatio = meta.aspect;
    }
    if (meta.platform === "tiktok") {
      wrapper.classList.add("media-vertical");
    } else if (meta.platform === "youtube") {
      wrapper.classList.add("media-horizontal");
    }

    if (meta.type === "embed") {
      const iframe = document.createElement("iframe");
      iframe.src = meme.url;
      iframe.loading = "lazy";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "no-referrer-when-downgrade";
      iframe.allow = "autoplay; encrypted-media";
      wrapper.appendChild(iframe);
    } else if (meta.type === "video") {
      const video = document.createElement("video");
      video.src = meme.url;
      video.controls = true;
      video.playsInline = true;
      wrapper.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = meme.url;
      img.alt = meme.caption || "Мем";
      wrapper.appendChild(img);
    }

    return wrapper;
  }

  // === элементы ведущего ===
  const btnRoleHost = document.getElementById("btn-role-host");
  const btnRolePlayer = document.getElementById("btn-role-player");

  const btnNewGame = document.getElementById("btn-new-game");
  const btnBackHome = document.getElementById("btn-back-home");

  const formAddPlayer = document.getElementById("form-add-player");
  const playerNameInput = document.getElementById("player-name-input");
  const playersListEl = document.getElementById("players-list");
  const btnStartRound = document.getElementById("btn-start-round");

  const roundNumberSpan = document.getElementById("round-number");
  const formAddMeme = document.getElementById("form-add-meme");
  const memePlayerSelect = document.getElementById("meme-player-select");
  const memeUrlInput = document.getElementById("meme-url-input");
  const memeFileInput = document.getElementById("meme-file-input");
  const memeCaptionInput = document.getElementById("meme-caption-input");
  const memesPreviewList = document.getElementById("memes-preview-list");
  const btnGoVote = document.getElementById("btn-go-vote");

  const voteMemesContainer = document.getElementById("vote-memes-container");
  const btnShowResults = document.getElementById("btn-show-results");

  const resultsRoundNumberSpan = document.getElementById("results-round-number");
  const resultsListEl = document.getElementById("results-list");
  const btnNextRound = document.getElementById("btn-next-round");
  const btnNewGameFromResults = document.getElementById(
    "btn-new-game-from-results"
  );

  // === элементы игрока ===
  const playerRoomInput = document.getElementById("player-room-input");
  const btnPlayerJoin = document.getElementById("btn-player-join");
  const playerRoomStatus = document.getElementById("player-room-status");
  const playerVoteContainer = document.getElementById("player-vote-container");

  const playerNickInput = document.getElementById("player-nick-input");
  const playerMemeForm = document.getElementById("player-meme-form");
  const playerMemeUrlInput = document.getElementById("player-meme-url");
  const playerMemeFileInput = document.getElementById("player-meme-file");
  const playerMemeCaptionInput = document.getElementById("player-meme-caption");

  // === рендеры ===
  function renderPlayers() {
    if (!playersListEl) return;
    playersListEl.innerHTML = "";
    state.players.forEach((name, index) => {
      const li = document.createElement("li");
      li.textContent = name;

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "×";
      removeBtn.className = "remove-player-btn";
      removeBtn.addEventListener("click", () => {
        state.players.splice(index, 1);
        renderPlayers();
        renderMemePlayerSelect();
        if (btnStartRound) btnStartRound.disabled = state.players.length < 2;
      });

      li.appendChild(removeBtn);
      playersListEl.appendChild(li);
    });
    if (btnStartRound) btnStartRound.disabled = state.players.length < 2;
    renderMemePlayerSelect();
  }

  function renderMemePlayerSelect() {
    if (!memePlayerSelect) return;
    memePlayerSelect.innerHTML = "";
    state.players.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      memePlayerSelect.appendChild(option);
    });
    memePlayerSelect.disabled = state.players.length === 0;
  }

  function renderMemesPreview() {
    if (!memesPreviewList) return;
    memesPreviewList.innerHTML = "";
    state.memes.forEach((meme) => {
      const li = document.createElement("li");
      li.textContent = `${meme.playerName}: ${meme.caption || meme.url}`;
      memesPreviewList.appendChild(li);
    });
    if (btnGoVote) btnGoVote.disabled = state.memes.length === 0;
  }

  function renderVoteMemesHost() {
    if (!voteMemesContainer) return;
    voteMemesContainer.innerHTML = "";
    state.memes.forEach((meme, index) => {
      const card = document.createElement("div");
      card.className = "meme-card";

      const media = createMediaElement(meme);

      const info = document.createElement("div");
      info.className = "meme-info";

      const titleEl = document.createElement("div");
      titleEl.className = "meme-player";
      titleEl.textContent = `Мем ${index + 1}`;

      const captionEl = document.createElement("div");
      captionEl.className = "meme-caption";
      captionEl.textContent = meme.caption || "";

      const voteBtn = document.createElement("button");
      voteBtn.className = "vote-btn";
      voteBtn.textContent = hasVotedThisRound
        ? "Вы уже проголосовали"
        : "Голосовать";
      voteBtn.disabled = hasVotedThisRound;

      voteBtn.addEventListener("click", () => {
        if (hasVotedThisRound) return;
        hasVotedThisRound = true;

        const allBtns = voteMemesContainer.querySelectorAll(".vote-btn");
        allBtns.forEach((b) => (b.disabled = true));

        if (currentRoomId && socket) {
          socket.emit("vote", { roomId: currentRoomId, memeId: meme.id });
        } else {
          meme.votes += 1;
          voteBtn.textContent = "Голос принят";
        }
      });

      info.appendChild(titleEl);
      info.appendChild(captionEl);

      card.appendChild(media);
      card.appendChild(info);
      card.appendChild(voteBtn);

      voteMemesContainer.appendChild(card);
    });
  }

  function renderVoteMemesPlayer() {
    if (!playerVoteContainer) return;
    playerVoteContainer.innerHTML = "";
    state.memes.forEach((meme, index) => {
      const card = document.createElement("div");
      card.className = "meme-card";

      const media = createMediaElement(meme);

      const info = document.createElement("div");
      info.className = "meme-info";

      const titleEl = document.createElement("div");
      titleEl.className = "meme-player";
      titleEl.textContent = `Мем ${index + 1}`;

      const captionEl = document.createElement("div");
      captionEl.className = "meme-caption";
      captionEl.textContent = meme.caption || "";

      const voteBtn = document.createElement("button");
      voteBtn.className = "vote-btn";
      voteBtn.textContent = hasVotedThisRound
        ? "Вы уже проголосовали"
        : "Голосовать";
      voteBtn.disabled = hasVotedThisRound;

      voteBtn.addEventListener("click", () => {
        if (hasVotedThisRound) return;
        hasVotedThisRound = true;

        const allBtns = playerVoteContainer.querySelectorAll(".vote-btn");
        allBtns.forEach((b) => (b.disabled = true));

        if (currentRoomId && socket) {
          socket.emit("vote", { roomId: currentRoomId, memeId: meme.id });
        }
        voteBtn.textContent = "Голос принят";
      });

      info.appendChild(titleEl);
      info.appendChild(captionEl);

      card.appendChild(media);
      card.appendChild(info);
      card.appendChild(voteBtn);

      playerVoteContainer.appendChild(card);
    });
  }

  function renderResults() {
    if (!resultsListEl) return;
    if (resultsRoundNumberSpan)
      resultsRoundNumberSpan.textContent = state.round;
    resultsListEl.innerHTML = "";
    if (state.memes.length === 0) return;

    const sorted = [...state.memes].sort((a, b) => b.votes - a.votes);
    const maxVotes = sorted[0].votes;

    sorted.forEach((meme, index) => {
      const li = document.createElement("li");
      li.className = "result-item";

      const card = document.createElement("div");
      card.className = "result-card";

      const media = createMediaElement(meme);
      media.classList.add("result-media");

      const info = document.createElement("div");
      info.className = "result-info";

      const title = document.createElement("div");
      title.className = "result-title";
      title.textContent = `${index + 1}. ${meme.playerName} — ${
        meme.votes
      } голос(ов)`;

      const caption = document.createElement("div");
      caption.className = "result-caption";
      caption.textContent = meme.caption || "";

      info.appendChild(title);
      if (meme.caption) info.appendChild(caption);

      card.appendChild(media);
      card.appendChild(info);
      li.appendChild(card);

      let scale = 0.8;
      if (index === 0) {
        scale = 1.2;
      } else if (maxVotes > 0) {
        scale = 0.8 + 0.3 * (meme.votes / maxVotes);
        if (scale >= 1.2) scale = 1.1;
      }
      card.style.transform = `scale(${scale})`;
      card.style.transformOrigin = "center";

      resultsListEl.appendChild(li);
    });
  }

  function applyRoomState(roomState) {
    if (!roomState) return;
    const incomingPlayers = (roomState.players || []).map(
      (p) => p.name || p
    );
    state.players = incomingPlayers;
    const previousCount = state.memes.length;
    state.memes = roomState.memes || [];

    if (previousCount !== state.memes.length && state.memes.length === 0) {
      hasVotedThisRound = false;
    }

    renderPlayers();
    renderMemesPreview();

    if (currentScreenId === "screen-vote") {
      if (role === "host") {
        renderVoteMemesHost();
      } else if (role === "player") {
        renderVoteMemesPlayer();
      }
    }
    if (currentScreenId === "screen-player") {
      renderVoteMemesPlayer();
    }
    if (currentScreenId === "screen-results") {
      renderResults();
    }
  }

  // === выбор роли ===
  if (btnRoleHost) {
    btnRoleHost.addEventListener("click", () => {
      role = "host";
      resetGame();
      currentRoomId = null;
      updateRoomLabel();
      updateRoomShare();
      showScreen("screen-home");
    });
  }

  if (btnRolePlayer) {
    btnRolePlayer.addEventListener("click", () => {
      role = "player";
      state.players = [];
      state.memes = [];
      state.round = 1;
      hasVotedThisRound = false;
      playerNick = "";
      if (playerNickInput) {
        playerNickInput.value = "";
        playerNickInput.disabled = false;
      }

      const params = new URLSearchParams(window.location.search);
      const roomFromUrl = params.get("room");
      if (roomFromUrl && playerRoomInput) {
        const code = roomFromUrl.toUpperCase();
        playerRoomInput.value = code;
        joinPlayerRoom(code);
      }

      showScreen("screen-player");
    });
  }

  // === ведущий ===
  if (btnNewGame) {
    btnNewGame.addEventListener("click", () => {
      if (role !== "host") return;
      resetGame();
      currentRoomId = generateRoomCode();
      if (roomIdInput) roomIdInput.value = currentRoomId;
      updateRoomLabel();
      updateRoomShare();

      if (socket) {
        socket.emit("join_room", {
          roomId: currentRoomId,
          name: "Host",
          role: "host",
        });
      }

      showScreen("screen-lobby");
    });
  }

  if (btnBackHome) {
    btnBackHome.addEventListener("click", () => {
      if (role !== "host") return;
      showScreen("screen-home");
    });
  }

  if (btnApplyRoom) {
    btnApplyRoom.addEventListener("click", () => {
      if (role !== "host") return;
      let roomId =
        (roomIdInput && roomIdInput.value.trim().toUpperCase()) || "";
      if (!roomId) {
        roomId = generateRoomCode();
        if (roomIdInput) roomIdInput.value = roomId;
      }
      currentRoomId = roomId;
      updateRoomLabel();
      updateRoomShare();

      if (socket) {
        socket.emit("join_room", {
          roomId: currentRoomId,
          name: "Host",
          role: "host",
        });
      }
    });
  }

  if (formAddPlayer) {
    formAddPlayer.addEventListener("submit", (e) => {
      e.preventDefault();
      if (role !== "host") return;
      const name = (playerNameInput && playerNameInput.value.trim()) || "";
      if (!name) return;
      if (state.players.includes(name)) {
        alert("Такой игрок уже есть");
        return;
      }
      state.players.push(name);
      if (playerNameInput) playerNameInput.value = "";
      renderPlayers();
    });
  }

  if (btnStartRound) {
    btnStartRound.addEventListener("click", () => {
      if (role !== "host") return;
      state.round = 1;
      state.memes = [];
      hasVotedThisRound = false;
      if (roundNumberSpan) roundNumberSpan.textContent = state.round;
      renderMemesPreview();

      if (currentRoomId && socket) {
        socket.emit("clear_memes", { roomId: currentRoomId });
      }

      showScreen("screen-submit");
    });
  }

  if (formAddMeme) {
    formAddMeme.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (role !== "host") return;
      if (state.players.length === 0) {
        alert("Сначала добавьте игроков");
        return;
      }

      const file = memeFileInput && memeFileInput.files[0];
      let url = (memeUrlInput && memeUrlInput.value.trim()) || "";

      if (!file && !url) {
        alert("Добавь ссылку или выбери файл");
        return;
      }

      if (file) {
        url = URL.createObjectURL(file);
      } else {
        // PATCH: TikTok normalize
        pushDebug(`normalize input: ${url}`);
        const normalized = await normalizeVideoLink(url);
        url = normalized || (await normalizeMediaUrl(url));
        pushDebug(`normalize output: ${url}`);
      }

      const playerName = memePlayerSelect
        ? memePlayerSelect.value
        : "Игрок";
      const caption =
        (memeCaptionInput && memeCaptionInput.value.trim()) || "";

      if (currentRoomId && socket) {
        socket.emit("submit_meme", {
          roomId: currentRoomId,
          playerName,
          url,
          caption,
        });
      } else {
        state.memes.push({
          id: Date.now() + Math.random().toString(16).slice(2),
          playerName,
          url,
          caption,
          votes: 0,
        });
        renderMemesPreview();
      }

      if (memeUrlInput) memeUrlInput.value = "";
      if (memeCaptionInput) memeCaptionInput.value = "";
      if (memeFileInput) memeFileInput.value = "";
    });
  }

  if (btnGoVote) {
    btnGoVote.addEventListener("click", () => {
      if (role !== "host") return;
      if (state.memes.length === 0) return;
      hasVotedThisRound = false;
      renderVoteMemesHost();
      showScreen("screen-vote");
    });
  }

  if (btnShowResults) {
    btnShowResults.addEventListener("click", () => {
      if (role !== "host") return;
      renderResults();
      showScreen("screen-results");
    });
  }

  if (btnNextRound) {
    btnNextRound.addEventListener("click", () => {
      if (role !== "host") return;
      state.round += 1;
      state.memes = [];
      hasVotedThisRound = false;
      if (roundNumberSpan) roundNumberSpan.textContent = state.round;
      renderMemesPreview();

      if (currentRoomId && socket) {
        socket.emit("clear_memes", { roomId: currentRoomId });
      }

      showScreen("screen-submit");
    });
  }

  if (btnNewGameFromResults) {
    btnNewGameFromResults.addEventListener("click", () => {
      if (role !== "host") return;
      resetGame();
      currentRoomId = generateRoomCode();
      if (roomIdInput) roomIdInput.value = currentRoomId;
      updateRoomLabel();
      updateRoomShare();

      if (socket) {
        socket.emit("join_room", {
          roomId: currentRoomId,
          name: "Host",
          role: "host",
        });
      }

      showScreen("screen-lobby");
    });
  }

  // === игрок ===
  function joinPlayerRoom(roomId) {
    const code = String(roomId || "").trim().toUpperCase();
    if (!code) return;
    currentRoomId = code;
    hasVotedThisRound = false;

    if (playerRoomInput) playerRoomInput.value = code;
    if (!playerNick) {
      playerNick =
        (playerNickInput && playerNickInput.value.trim()) || "Игрок";
    }
    if (playerNickInput) {
      playerNickInput.value = playerNick;
      playerNickInput.disabled = true;
    }

    if (playerRoomStatus)
      playerRoomStatus.textContent = `Подключаемся к комнате ${code}…`;

    if (socket) {
      socket.emit("join_room", {
        roomId: currentRoomId,
        name: playerNick,
        role: "player",
      });
      if (playerRoomStatus)
        playerRoomStatus.textContent = `Вы в комнате ${code}. Ждите мема.`;
    } else {
      if (playerRoomStatus)
        playerRoomStatus.textContent =
          "Не удалось подключиться к серверу.";
    }
  }

  if (btnPlayerJoin) {
    btnPlayerJoin.addEventListener("click", () => {
      if (role !== "player") return;
      joinPlayerRoom(playerRoomInput && playerRoomInput.value);
    });
  }

  if (playerMemeForm) {
    playerMemeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (role !== "player") return;
      if (!currentRoomId) {
        alert("Сначала подключись к комнате");
        return;
      }

      if (!playerNick) {
        playerNick =
          (playerNickInput && playerNickInput.value.trim()) || "Игрок";
        if (playerNickInput) {
          playerNickInput.value = playerNick;
          playerNickInput.disabled = true;
        }
      }

      const file = playerMemeFileInput && playerMemeFileInput.files[0];
      let url =
        (playerMemeUrlInput && playerMemeUrlInput.value.trim()) || "";
      if (!file && !url) {
        alert("Добавь ссылку или выбери файл");
        return;
      }
      if (file) {
        url = URL.createObjectURL(file);
      } else {
        // PATCH: TikTok normalize
        pushDebug(`normalize input: ${url}`);
        const normalized = await normalizeVideoLink(url);
        url = normalized || (await normalizeMediaUrl(url));
        pushDebug(`normalize output: ${url}`);
      }
      const caption =
        (playerMemeCaptionInput &&
          playerMemeCaptionInput.value.trim()) ||
        "";

      if (socket) {
        socket.emit("submit_meme", {
          roomId: currentRoomId,
          playerName: playerNick,
          url,
          caption,
        });
      }

      if (playerMemeUrlInput) playerMemeUrlInput.value = "";
      if (playerMemeCaptionInput) playerMemeCaptionInput.value = "";
      if (playerMemeFileInput) playerMemeFileInput.value = "";
    });
  }

  // === socket ===
  if (socket) {
    socket.on("room_state", (roomState) => {
      applyRoomState(roomState);
    });

    socket.on("connect", () => {
      if (currentRoomId && role === "host") {
        socket.emit("join_room", {
          roomId: currentRoomId,
          name: "Host",
          role: "host",
        });
      }
      if (currentRoomId && role === "player") {
        socket.emit("join_room", {
          roomId: currentRoomId,
          name: playerNick || "Игрок",
          role: "player",
        });
      }
    });
  }
});
