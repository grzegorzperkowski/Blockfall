"use strict";

(() => {
  const COLS = 10;
  const ROWS = 20;
  const LOCK_DELAY = 500;
  const MAX_RESETS = 15;
  const CLEAR_ANIMATION_MS = Object.freeze({ 2: 600, 3: 760 });
  const STORAGE_KEY = "blockfall.best";
  const SAVE_KEY = "blockfall.game";
  const SAVE_VERSION = 1;
  const ROTATIONS = Object.freeze(["0", "R", "2", "L"]);
  const LINE_POINTS = Object.freeze([0, 100, 300, 500, 800]);
  const REPEAT_ACTIONS = new Set(["left", "right", "down"]);

  function deepFreeze(value) {
    Object.values(value).forEach(item => {
      if (item && typeof item === "object") deepFreeze(item);
    });
    return Object.freeze(value);
  }

  function orientations(spawn, pivot) {
    const states = { "0": spawn };
    for (let index = 1; index < 4; index++) {
      states[ROTATIONS[index]] = states[ROTATIONS[index - 1]].map(([x, y]) =>
        [2 * pivot - y, x]);
    }
    return states;
  }

  // Integer cell centers for JLSTZ; the I pivot lies between four cells.
  const PIECES = deepFreeze({
    I: orientations([[0, 1], [1, 1], [2, 1], [3, 1]], 1.5),
    J: orientations([[0, 0], [0, 1], [1, 1], [2, 1]], 1),
    L: orientations([[2, 0], [0, 1], [1, 1], [2, 1]], 1),
    O: { "0": [[1, 0], [2, 0], [1, 1], [2, 1]] },
    S: orientations([[1, 0], [2, 0], [0, 1], [1, 1]], 1),
    T: orientations([[1, 0], [0, 1], [1, 1], [2, 1]], 1),
    Z: orientations([[0, 0], [1, 0], [1, 1], [2, 1]], 1)
  });
  const TYPES = Object.freeze(Object.keys(PIECES));
  // SRS offsets use positive Y upward; board coordinates use positive Y downward.
  const JLSTZ_KICKS = deepFreeze({
    "0>R": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "R>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "R>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "2>R": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "2>L": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    "L>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "L>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "0>L": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]
  });
  const I_KICKS = deepFreeze({
    "0>R": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    "R>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    "R>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    "2>R": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    "2>L": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    "L>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    "L>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    "0>L": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]
  });
  const KEY_ACTIONS = Object.freeze({
    ArrowLeft: "left", ArrowRight: "right", ArrowDown: "down",
    ArrowUp: "cw", KeyX: "cw", KeyZ: "ccw", Space: "drop",
    KeyC: "hold", ShiftLeft: "hold", ShiftRight: "hold",
    KeyP: "pause", Escape: "pause"
  });
  const ui = Object.fromEntries([
    "board", "score", "best", "level", "lines", "progress", "progress-label",
    "next", "next-name", "hold", "hold-status", "start", "pause", "overlay",
    "overlay-title", "overlay-text", "overlay-action", "state-label", "announcer",
    "save-status", "offline-status"
  ].map(id => [id, document.getElementById(id)]));
  const actionButtons = [...document.querySelectorAll("[data-action]")];
  const boardCells = Array.from({ length: COLS * ROWS }, () => {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.setAttribute("aria-hidden", "true");
    ui.board.append(cell);
    return cell;
  });

  function readBest() {
    try {
      const value = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch { return 0; }
  }

  const gameState = {
    status: "ready", board: emptyBoard(), active: null, bag: [], queue: [],
    held: null, canHold: true, score: 0, best: readBest(), lines: 0, level: 1,
    gravityTime: 0, lockTime: 0, lockResets: 0,
    clearAnimation: null, lastFrame: null, repeats: new Map(), keys: new Set(), dirty: true
  };

  function emptyBoard() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function announce(message) { ui.announcer.textContent = message; }

  function saveGame() {
    if (gameState.status === "ready" || gameState.clearAnimation) return;
    const { status, board, active, bag, queue, held, canHold, score, best,
      lines, level, gravityTime, lockTime, lockResets } = gameState;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: SAVE_VERSION, status, board, active, bag, queue, held, canHold,
        score, best, lines, level, gravityTime, lockTime, lockResets
      }));
      ui["save-status"].textContent = "Progress saved on this device. Reload to resume.";
    } catch {
      ui["save-status"].textContent = "Saving is unavailable. Keep this page open to continue your game.";
    }
  }

  function validSave(saved) {
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const pieceType = value => TYPES.includes(value);
    if (!saved || saved.version !== SAVE_VERSION ||
        !["playing", "paused", "over"].includes(saved.status)) return false;
    if (!Array.isArray(saved.board) || saved.board.length !== ROWS ||
        !saved.board.every(row => Array.isArray(row) && row.length === COLS &&
          row.every(cell => cell === null || pieceType(cell)))) return false;
    if (!Array.isArray(saved.bag) || saved.bag.length > 7 ||
        !saved.bag.every(pieceType) || new Set(saved.bag).size !== saved.bag.length ||
        !Array.isArray(saved.queue) || saved.queue.length !== 1 ||
        !saved.queue.every(pieceType)) return false;
    if ((saved.held !== null && !pieceType(saved.held)) || typeof saved.canHold !== "boolean" ||
        ![saved.score, saved.best, saved.lines, saved.level, saved.lockResets].every(integer) ||
        saved.best < saved.score || saved.level !== 1 + Math.floor(saved.lines / 10) ||
        saved.lockResets > MAX_RESETS || !Number.isFinite(saved.gravityTime) ||
        saved.gravityTime < 0 || saved.gravityTime > 900 || !Number.isFinite(saved.lockTime) ||
        saved.lockTime < 0 || saved.lockTime > LOCK_DELAY) return false;
    const piece = saved.active;
    if (piece === null) return saved.status === "over";
    if (!piece || !pieceType(piece.type) || !Object.hasOwn(PIECES[piece.type], piece.rotation) ||
        !Number.isInteger(piece.x) || !Number.isInteger(piece.y) || piece.y < -4) return false;
    return occupiedCells(piece).every(([x, y]) => x >= 0 && x < COLS && y < ROWS &&
      (y < 0 || saved.board[y][x] === null));
  }

  function restoreGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!validSave(saved)) throw new Error("Invalid saved game");
      // Restore only game data; input and animation clocks always start fresh.
      const { board, active, bag, queue, held, canHold, score, lines, level,
        gravityTime, lockTime, lockResets } = saved;
      Object.assign(gameState, {
        board, active, bag, queue, held, canHold, score, lines, level,
        gravityTime, lockTime, lockResets, best: Math.max(gameState.best, saved.best),
        status: saved.status === "over" ? "over" : "paused", lastFrame: null, dirty: true
      });
      announce(saved.status === "over" ? "Previous game over. Restart to play again." :
        "Saved game restored and paused. Resume when ready.");
      ui["save-status"].textContent = "Saved game restored from this device.";
    } catch {
      ui["save-status"].textContent = "Saved progress could not be loaded. You can start a new game.";
    }
  }

  async function enableOfflineMode() {
    if (location.protocol === "file:") {
      ui["offline-status"].textContent = "Local files · Offline ready";
      return;
    }
    if (!window.isSecureContext || !("serviceWorker" in navigator)) {
      ui["offline-status"].textContent = "Offline caching needs HTTPS or localhost";
      return;
    }
    ui["offline-status"].textContent = "Preparing offline play…";
    try {
      await navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" });
      await navigator.serviceWorker.ready;
      ui["offline-status"].textContent = "Offline ready";
    } catch {
      ui["offline-status"].textContent = "Offline cache unavailable · Retry online";
    }
  }

  function addScore(points) {
    gameState.score += points;
    if (gameState.score > gameState.best) {
      gameState.best = gameState.score;
      try { localStorage.setItem(STORAGE_KEY, String(gameState.best)); } catch { /* Storage is optional. */ }
    }
    gameState.dirty = true;
  }

  function drawFromBag() {
    if (!gameState.bag.length) {
      gameState.bag = [...TYPES];
      for (let index = gameState.bag.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [gameState.bag[index], gameState.bag[other]] = [gameState.bag[other], gameState.bag[index]];
      }
    }
    return gameState.bag.pop();
  }

  function nextType() {
    while (gameState.queue.length < 2) gameState.queue.push(drawFromBag());
    return gameState.queue.shift();
  }

  function occupiedCells(piece) {
    return PIECES[piece.type][piece.rotation].map(([x, y]) => [piece.x + x, piece.y + y]);
  }

  function isValid(piece) {
    return occupiedCells(piece).every(([x, y]) =>
      x >= 0 && x < COLS && y < ROWS && (y < 0 || !gameState.board[y][x]));
  }

  function isGrounded() {
    return !isValid({ ...gameState.active, y: gameState.active.y + 1 });
  }

  function clearInput() {
    gameState.repeats.clear();
    gameState.keys.clear();
    actionButtons.forEach(button => button.classList.remove("is-held"));
  }

  function gameOver() {
    gameState.status = "over";
    clearInput();
    gameState.dirty = true;
    saveGame();
    announce(`Game over. Final score ${gameState.score}. Restart to play again.`);
  }

  function spawnPiece(type) {
    gameState.active = { type, rotation: "0", x: 3, y: type === "I" ? -1 : 0 };
    gameState.gravityTime = 0;
    gameState.lockTime = 0;
    gameState.lockResets = 0;
    gameState.dirty = true;
    if (!isValid(gameState.active)) {
      gameState.active = null;
      gameOver();
    }
  }

  function startGame() {
    clearInput();
    Object.assign(gameState, {
      status: "playing", board: emptyBoard(), active: null, bag: [], queue: [],
      held: null, canHold: true, score: 0, lines: 0, level: 1,
      gravityTime: 0, lockTime: 0, lockResets: 0,
      clearAnimation: null, lastFrame: null, dirty: true
    });
    spawnPiece(nextType());
    announce("Game started. Level 1.");
    saveGame();
  }

  function togglePause() {
    if (!["playing", "paused"].includes(gameState.status)) return;
    if (gameState.status === "playing" && gameState.clearAnimation) finishAnimatedLineClear();
    gameState.status = gameState.status === "playing" ? "paused" : "playing";
    clearInput();
    gameState.lastFrame = null;
    gameState.dirty = true;
    saveGame();
    announce(gameState.status === "paused" ? "Paused." : "Game resumed.");
  }

  function applyAdjustment(candidate) {
    if (!isValid(candidate)) return false;
    const wasGrounded = isGrounded();
    gameState.active = candidate;
    if (wasGrounded && gameState.lockResets < MAX_RESETS) {
      gameState.lockTime = 0;
      gameState.lockResets++;
    }
    gameState.dirty = true;
    return true;
  }

  function rotatePiece(direction) {
    const piece = gameState.active;
    if (piece.type === "O") return;
    const rotation = ROTATIONS[(ROTATIONS.indexOf(piece.rotation) + direction + 4) % 4];
    const kicks = piece.type === "I" ? I_KICKS : JLSTZ_KICKS;
    for (const [dx, dy] of kicks[`${piece.rotation}>${rotation}`]) {
      if (applyAdjustment({ ...piece, rotation, x: piece.x + dx, y: piece.y - dy })) return;
    }
  }

  function stepDown(manual = false) {
    const candidate = { ...gameState.active, y: gameState.active.y + 1 };
    if (!isValid(candidate)) return false;
    gameState.active = candidate;
    if (manual) addScore(1);
    gameState.dirty = true;
    return true;
  }

  function landingPiece() {
    const ghost = { ...gameState.active };
    while (isValid({ ...ghost, y: ghost.y + 1 })) ghost.y++;
    return ghost;
  }

  function lockPiece() {
    const cells = occupiedCells(gameState.active);
    if (cells.some(([, y]) => y < 0)) {
      gameOver();
      return;
    }
    cells.forEach(([x, y]) => { gameState.board[y][x] = gameState.active.type; });
    const remaining = gameState.board.filter(row => !row.every(Boolean));
    const cleared = ROWS - remaining.length;
    if (cleared === 2 || cleared === 3) {
      announce(cleared === 2 ? "Double line clear!" : "Triple line clear!");
    }
    if ((cleared === 2 || cleared === 3) &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const rows = gameState.board.reduce((fullRows, row, index) => {
        if (row.every(Boolean)) fullRows.push(index);
        return fullRows;
      }, []);
      clearInput();
      gameState.active = null;
      gameState.clearAnimation = { count: cleared, rows, elapsed: 0 };
      gameState.dirty = true;
      return;
    }
    if (cleared) completeLineClear(cleared);
    else {
      gameState.canHold = true;
      spawnPiece(nextType());
    }
  }

  function completeLineClear(cleared) {
    const remaining = gameState.board.filter(row => !row.every(Boolean));
    addScore(LINE_POINTS[cleared] * gameState.level);
    gameState.lines += cleared;
    const newLevel = 1 + Math.floor(gameState.lines / 10);
    if (newLevel > gameState.level) announce(`Level ${newLevel}. Gravity increased.`);
    gameState.level = newLevel;
    gameState.board = [...Array.from({ length: cleared }, () => Array(COLS).fill(null)), ...remaining];
    gameState.canHold = true;
    spawnPiece(nextType());
  }

  function finishAnimatedLineClear() {
    if (!gameState.clearAnimation) return;
    const { count } = gameState.clearAnimation;
    gameState.clearAnimation = null;
    completeLineClear(count);
  }

  function hardDrop() {
    const landing = landingPiece();
    addScore((landing.y - gameState.active.y) * 2);
    gameState.active = landing;
    lockPiece();
  }

  function holdPiece() {
    if (!gameState.canHold) return;
    const incoming = gameState.held;
    gameState.held = gameState.active.type;
    gameState.canHold = false;
    spawnPiece(incoming || nextType());
  }

  function performAction(action) {
    if (action === "pause") { togglePause(); return; }
    if (gameState.status !== "playing" || !gameState.active || gameState.clearAnimation) return;
    if (action === "left") applyAdjustment({ ...gameState.active, x: gameState.active.x - 1 });
    else if (action === "right") applyAdjustment({ ...gameState.active, x: gameState.active.x + 1 });
    else if (action === "down") stepDown(true);
    else if (action === "cw") rotatePiece(1);
    else if (action === "ccw") rotatePiece(-1);
    else if (action === "drop") hardDrop();
    else if (action === "hold") holdPiece();
  }

  function beginRepeat(source, action) {
    performAction(action);
    if (gameState.status === "playing") {
      gameState.repeats.set(source, { action, remaining: action === "down" ? 120 : 170 });
    }
  }

  function updateRepeats(elapsed) {
    for (const repeat of gameState.repeats.values()) {
      repeat.remaining -= elapsed;
      if (repeat.remaining <= 0) {
        performAction(repeat.action);
        repeat.remaining += repeat.action === "down" ? 40 : 50;
      }
    }
  }

  function updatePhysics(elapsed) {
    if (gameState.clearAnimation) {
      gameState.clearAnimation.elapsed += elapsed;
      if (gameState.clearAnimation.elapsed >= CLEAR_ANIMATION_MS[gameState.clearAnimation.count]) {
        finishAnimatedLineClear();
      }
      return;
    }
    updateRepeats(elapsed);
    const grounded = isGrounded();
    if (grounded) {
      gameState.lockTime += elapsed;
      if (gameState.lockTime >= LOCK_DELAY) { lockPiece(); return; }
    }
    // Preserve elapsed lock time in the air once the reset budget is exhausted.
    gameState.gravityTime += elapsed;
    const interval = Math.max(70, 900 * Math.pow(.8, gameState.level - 1));
    if (gameState.gravityTime >= interval) {
      gameState.gravityTime -= interval;
      stepDown();
    }
  }

  function renderPreview(element, type) {
    if (element.dataset.piece === (type || "empty")) return;
    element.dataset.piece = type || "empty";
    element.replaceChildren();
    element.setAttribute("aria-label", type ? `${type} piece` : "Empty slot");
    if (!type) return;
    const cells = PIECES[type]["0"];
    const minX = Math.min(...cells.map(([x]) => x));
    const minY = Math.min(...cells.map(([, y]) => y));
    const width = Math.max(...cells.map(([x]) => x)) - minX + 1;
    const height = Math.max(...cells.map(([, y]) => y)) - minY + 1;
    cells.forEach(([x, y]) => {
      const block = document.createElement("div");
      const column = 5 - width + (x - minX) * 2;
      const row = 4 - height + (y - minY) * 2;
      block.className = `block ${type} preview-column-${column} preview-row-${row}`;
      element.append(block);
    });
  }

  function renderBoard() {
    const classes = gameState.board.flat().map(type => type ? `cell block locked ${type}` : "cell");
    function paint(piece, appearance) {
      occupiedCells(piece).forEach(([x, y]) => {
        if (y >= 0 && y < ROWS) classes[y * COLS + x] = `cell ${appearance} ${piece.type}`;
      });
    }
    if (gameState.active) {
      if (gameState.status === "playing") paint(landingPiece(), "ghost");
      paint(gameState.active, "block active");
    }
    if (gameState.clearAnimation) {
      const { count, rows } = gameState.clearAnimation;
      rows.forEach((row, rowOrder) => {
        for (let column = 0; column < COLS; column++) {
          const index = row * COLS + column;
          const delay = count === 2
            ? (rowOrder === 0 ? column : COLS - 1 - column) * 18
            : Math.abs(column - (COLS - 1) / 2) * 20 + rowOrder * 25;
          const direction = column < COLS / 2 ? -1 : 1;
          boardCells[index].style.setProperty("--clear-delay", `${delay}ms`);
          boardCells[index].style.setProperty("--clear-shift", `${direction * (18 + rowOrder * 4)}px`);
          boardCells[index].style.setProperty("--clear-turn", `${direction * (12 + column % 3 * 5)}deg`);
          classes[index] += ` line-clear-${count}`;
        }
      });
    }
    classes.forEach((name, index) => {
      if (boardCells[index].className !== name) boardCells[index].className = name;
    });
    ui.board.classList.toggle("is-paused", gameState.status === "paused");
    ui.board.setAttribute("aria-label", `10 by 20 playfield. ${gameState.status}. ${gameState.active ? `Active ${gameState.active.type} piece.` : ""} ${gameState.lines} lines cleared.`);
  }

  function updateUI() {
    const { status, score, best, level, lines, held, canHold } = gameState;
    ui.score.textContent = score.toLocaleString();
    ui.best.textContent = best.toLocaleString();
    ui.level.textContent = String(level).padStart(2, "0");
    ui.lines.textContent = String(lines);
    ui.progress.value = lines % 10;
    ui["progress-label"].textContent = `${10 - lines % 10} lines to level ${level + 1}`;
    ui.start.textContent = status === "ready" ? "Start Game" : "Restart";
    ui.pause.textContent = status === "paused" ? "Resume" : "Pause";
    ui.pause.setAttribute("aria-pressed", String(status === "paused"));
    ui.pause.disabled = status === "ready" || status === "over";
    ui["state-label"].textContent = { ready: "READY", playing: "IN PLAY", paused: "PAUSED", over: "GAME OVER" }[status];
    actionButtons.forEach(button => {
      button.disabled = status !== "playing" || Boolean(gameState.clearAnimation) ||
        (button.dataset.action === "hold" && !canHold);
    });
    renderPreview(ui.next, gameState.queue[0]);
    renderPreview(ui.hold, held);
    ui["next-name"].textContent = gameState.queue[0] ? `${gameState.queue[0]} piece` : "Waiting to start";
    ui["hold-status"].textContent = !canHold ? "Used · lock to refresh" : held ? `${held} piece · available` : "Slot empty";
    ui.hold.parentElement.classList.toggle("is-unavailable", !canHold);
    ui.overlay.hidden = status === "playing";
    if (status === "paused") {
      ui["overlay-title"].textContent = "Paused";
      ui["overlay-text"].textContent = "Your next move can wait. Resume here, or return to this page later.";
      ui["overlay-action"].textContent = "Resume Game";
    } else if (status === "over") {
      ui["overlay-title"].textContent = "Game Over";
      ui["overlay-text"].textContent = `Final score: ${score.toLocaleString()} · ${lines} lines cleared`;
      ui["overlay-action"].textContent = "Play Again";
    }
  }

  function frame(timestamp) {
    const elapsed = gameState.lastFrame === null ? 0 : Math.min(100, timestamp - gameState.lastFrame);
    gameState.lastFrame = timestamp;
    if (gameState.status === "playing") {
      // Small bounded steps keep gravity and lock delay consistent across refresh rates.
      for (let remaining = elapsed; remaining > 0 && gameState.status === "playing";) {
        const step = Math.min(8, remaining);
        updatePhysics(step);
        remaining -= step;
      }
    }
    if (gameState.dirty) {
      renderBoard();
      updateUI();
      saveGame();
      gameState.dirty = false;
    }
    requestAnimationFrame(frame);
  }

  document.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const action = KEY_ACTIONS[event.code];
    if (!action || gameState.status === "ready" || gameState.status === "over") return;
    if (gameState.status === "paused" && action !== "pause") return;
    event.preventDefault();
    if (event.repeat || gameState.keys.has(event.code)) return;
    gameState.keys.add(event.code);
    if (REPEAT_ACTIONS.has(action)) beginRepeat(event.code, action);
    else performAction(action);
  });
  document.addEventListener("keyup", event => {
    gameState.keys.delete(event.code);
    gameState.repeats.delete(event.code);
  });

  actionButtons.forEach(button => {
    const action = button.dataset.action;
    button.addEventListener("click", event => {
      if (!REPEAT_ACTIONS.has(action) || event.detail === 0) performAction(action);
    });
    if (!REPEAT_ACTIONS.has(action)) return;
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || button.disabled) return;
      button.setPointerCapture(event.pointerId);
      button.classList.add("is-held");
      beginRepeat(`pointer-${event.pointerId}`, action);
    });
    function release(event) {
      gameState.repeats.delete(`pointer-${event.pointerId}`);
      button.classList.remove("is-held");
    }
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("contextmenu", event => event.preventDefault());
  });
  ui.start.addEventListener("click", startGame);
  ui.pause.addEventListener("click", togglePause);
  ui["overlay-action"].addEventListener("click", () => {
    if (gameState.status === "paused") togglePause();
    else startGame();
    ui.start.focus({ preventScroll: true });
  });
  function pauseOnLeave() {
    clearInput();
    if (gameState.status === "playing") togglePause();
    else saveGame();
  }
  window.addEventListener("blur", pauseOnLeave);
  window.addEventListener("pagehide", pauseOnLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseOnLeave();
  });
  restoreGame();
  enableOfflineMode();
  requestAnimationFrame(frame);
})();
