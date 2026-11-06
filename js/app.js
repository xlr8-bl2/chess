(function () {
  'use strict';

  const { Position, START_FEN, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
    mFrom, mTo, mPromo, sqName, sqFromName } = window.Chess;

  // ---------------------------------------------------------------- Levels
  // Lower levels use the built-in engine with deliberate inaccuracy.
  // Upper levels use Stockfish when it is available, falling back to the built-in engine.
  const LEVELS = [
    { name: 'Beginner', desc: 'Makes plenty of mistakes. Great for learning.', builtin: { depth: 1, noise: 250, blunder: 0.25 } },
    { name: 'Novice', desc: 'Knows the basics, still blunders.', builtin: { depth: 2, noise: 120, blunder: 0.1 } },
    { name: 'Casual', desc: 'A relaxed club-night opponent.', builtin: { depth: 3, noise: 50, blunder: 0.03 } },
    { name: 'Club player', desc: 'Solid tactics, few outright blunders.', builtin: { depth: 5, timeMs: 800 } },
    { name: 'Advanced', desc: 'A strong amateur.', sf: { skill: 6, movetime: 600 }, builtin: { timeMs: 1500 } },
    { name: 'Expert', desc: 'Tournament-strength play.', sf: { skill: 12, movetime: 1000 }, builtin: { timeMs: 3000 } },
    { name: 'Master', desc: 'Very hard to beat.', sf: { skill: 17, movetime: 1500 }, builtin: { timeMs: 5000 } },
    { name: 'Grandmaster', desc: 'Full-strength Stockfish.', sf: { skill: 20, movetime: 2500 }, builtin: { timeMs: 8000 } },
  ];

  const store = {
    get(k, d) { try { const v = localStorage.getItem('chess.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('chess.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------------------------------------------------------------- Engines
  class BuiltinEngine {
    constructor() { this.worker = null; this.pending = null; this.nextId = 1; }
    ensure() {
      if (this.worker) return;
      this.worker = new Worker('js/engine.js');
      this.worker.onmessage = (e) => {
        const p = this.pending;
        if (p && p.id === e.data.id) { this.pending = null; p.resolve(e.data.bestmove); }
      };
    }
    go(fen, moves, opts) {
      this.ensure();
      return new Promise((resolve) => {
        const id = this.nextId++;
        this.pending = { id, resolve };
        this.worker.postMessage({ id, fen, moves, ...opts });
      });
    }
    cancel() {
      if (this.pending) { // a search is running: kill it, a fresh worker is cheap
        this.pending = null;
        this.worker.terminate();
        this.worker = null;
      }
    }
  }

  class StockfishEngine {
    constructor() {
      this.ready = false; this.failed = false; this.resolve = null; this.ignore = 0; this.busy = false;
      this.start(() => new Worker('engine/stockfish.js'), true);
    }
    start(make, canRetry) {
      let triedFallback = false;
      const fallback = () => {
        if (triedFallback || !canRetry || this.ready) return;
        triedFallback = true;
        try { this.worker && this.worker.terminate(); } catch { /* ignore */ }
        // Some hosts block loading a worker directly; build it from the fetched source instead.
        fetch('engine/stockfish.js')
          .then((r) => { if (!r.ok) throw new Error('fetch failed'); return r.text(); })
          .then((src) => {
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            this.start(() => new Worker(url), false);
          })
          .catch(() => { this.failed = true; updateEngineNote(); });
      };
      try {
        this.worker = make();
      } catch (e) { if (canRetry) fallback(); else { this.failed = true; updateEngineNote(); } return; }
      this.worker.onerror = () => { if (canRetry) fallback(); else { this.failed = true; this.ready = false; updateEngineNote(); } };
      this.worker.onmessage = (e) => this.onLine(typeof e.data === 'string' ? e.data : String(e.data));
      this.worker.postMessage('uci');
      setTimeout(() => {
        if (this.ready) return;
        if (canRetry) fallback(); else { this.failed = true; updateEngineNote(); }
      }, 20000);
    }
    onLine(line) {
      if (line === 'uciok') { this.ready = true; this.failed = false; this.worker.postMessage('isready'); updateEngineNote(); return; }
      if (line.startsWith('bestmove')) {
        this.busy = false;
        if (this.ignore > 0) { this.ignore--; return; }
        const r = this.resolve; this.resolve = null;
        const mv = line.split(/\s+/)[1];
        if (r) r(mv && mv !== '(none)' ? mv : null);
      }
    }
    go(fen, moves, { skill, movetime }) {
      return new Promise((resolve) => {
        this.resolve = resolve;
        this.busy = true;
        this.worker.postMessage('setoption name Skill Level value ' + skill);
        this.worker.postMessage('position fen ' + fen + (moves.length ? ' moves ' + moves.join(' ') : ''));
        this.worker.postMessage('go movetime ' + movetime);
      });
    }
    cancel() {
      if (this.busy && this.resolve) {
        this.resolve = null;
        this.ignore++;
        this.worker.postMessage('stop');
      }
    }
    newGame() { if (this.ready) this.worker.postMessage('ucinewgame'); }
  }

  const builtin = new BuiltinEngine();
  let stockfish = null;
  try { stockfish = new StockfishEngine(); } catch { stockfish = null; }
  const sfUsable = () => stockfish && stockfish.ready && !stockfish.failed;

  // ---------------------------------------------------------------- State
  let pos, uciMoves, sanMoves, capturedBy;
  // isComputer[color]: whether the computer plays that color automatically.
  let isComputer = store.get('isComputer', [false, false]);
  if (!Array.isArray(isComputer) || isComputer.length !== 2) isComputer = [false, false];
  let level = Math.min(LEVELS.length - 1, Math.max(0, store.get('level', 2)));
  let orientation = isComputer[WHITE] && !isComputer[BLACK] ? BLACK : WHITE;
  let selected = -1;
  let legalFromSelected = [];
  let thinking = false;
  let searchToken = 0;
  let hintMove = 0;
  let gameStatus = { over: false };

  // ---------------------------------------------------------------- DOM
  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const statusEl = $('status');
  const promoEl = $('promo');
  const promoBox = $('promoBox');
  const levelSel = $('level');
  const levelRange = $('levelRange');

  const pieceImg = (p) => 'pieces/' + ((p >> 3) ? 'b' : 'w') + 'PNBRQK'[(p & 7) - 1] + '.svg';
  const colorName = (c) => (c === WHITE ? 'White' : 'Black');

  LEVELS.forEach((l, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${i + 1}. ${l.name}`;
    levelSel.appendChild(o);
  });
  levelRange.max = LEVELS.length - 1;

  // ---------------------------------------------------------------- Game control
  function newGame() {
    cancelSearch();
    pos = new Position(START_FEN);
    uciMoves = []; sanMoves = [];
    capturedBy = [[], []];
    selected = -1; legalFromSelected = []; hintMove = 0;
    gameStatus = { over: false };
    if (stockfish) stockfish.newGame();
    render();
    maybeComputerMove();
  }

  function playMove(m) {
    const san = pos.toSan(m);
    const to = mTo(m);
    let victim = pos.board[to];
    if (!victim && (pos.board[mFrom(m)] & 7) === PAWN && (mFrom(m) & 7) !== (to & 7)) victim = PAWN | ((pos.turn ^ 1) << 3);
    if (victim) capturedBy[pos.turn].push(victim);
    uciMoves.push(pos.toUci(m));
    sanMoves.push(san);
    pos.make(m);
    selected = -1; legalFromSelected = []; hintMove = 0;
    gameStatus = pos.status();
    render();
    maybeComputerMove();
  }

  function cancelSearch() {
    searchToken++;
    thinking = false;
    builtin.cancel();
    if (stockfish) stockfish.cancel();
  }

  const humanToMove = () => !isComputer[pos.turn];

  function maybeComputerMove(force) {
    if (gameStatus.over || thinking) return;
    if (!force && !isComputer[pos.turn]) return;
    const token = ++searchToken;
    thinking = true;
    render();
    const started = Date.now();
    const lvl = LEVELS[level];
    let p;
    if (lvl.sf && sfUsable()) p = stockfish.go(START_FEN, uciMoves.slice(), lvl.sf);
    else p = builtin.go(START_FEN, uciMoves.slice(), lvl.builtin);
    p.then((uci) => {
      if (token !== searchToken) return;
      const wait = Math.max(0, 350 - (Date.now() - started)); // keep very fast replies from feeling jarring
      setTimeout(() => {
        if (token !== searchToken) return;
        thinking = false;
        const m = uci && pos.fromUci(uci);
        if (m) playMove(m);
        else render();
      }, wait);
    });
  }

  function setPlayers(next) {
    const wasThinking = thinking;
    isComputer = next;
    store.set('isComputer', isComputer);
    // Face the board toward the single human player, if there is exactly one.
    if (isComputer[WHITE] !== isComputer[BLACK]) orientation = isComputer[WHITE] ? BLACK : WHITE;
    // Stop the computer if the side it was thinking for is now yours.
    if (wasThinking && !isComputer[pos.turn]) cancelSearch();
    selected = -1; legalFromSelected = []; hintMove = 0;
    render();
    maybeComputerMove();
  }

  function switchSides() {
    setPlayers([isComputer[BLACK], isComputer[WHITE]]);
  }

  function undo() {
    cancelSearch();
    if (!uciMoves.length) return;
    const popOne = () => {
      pos.unmake();
      uciMoves.pop(); sanMoves.pop();
      // rebuild captures cheaply by replaying
    };
    popOne();
    // Take back to a position where it's your move (undo the computer's reply too).
    while (isComputer[pos.turn] && !isComputer[pos.turn ^ 1] && uciMoves.length) popOne();
    rebuildCaptures();
    selected = -1; legalFromSelected = []; hintMove = 0;
    gameStatus = pos.status();
    render();
    maybeComputerMove();
  }

  function rebuildCaptures() {
    const p = new Position(START_FEN);
    capturedBy = [[], []];
    for (const u of uciMoves) {
      const m = p.fromUci(u);
      const to = mTo(m);
      let victim = p.board[to];
      if (!victim && (p.board[mFrom(m)] & 7) === PAWN && (mFrom(m) & 7) !== (to & 7)) victim = PAWN | ((p.turn ^ 1) << 3);
      if (victim) capturedBy[p.turn].push(victim);
      p.make(m);
    }
  }

  function setLevel(i) {
    level = +i;
    store.set('level', level);
    levelSel.value = level;
    levelRange.value = level;
    // If the computer is mid-think, restart with the new strength.
    if (thinking) { cancelSearch(); maybeComputerMove(true); }
    renderPanel();
  }

  let hintToken = 0;
  function hint() {
    if (gameStatus.over || !humanToMove() || thinking) return;
    const token = ++hintToken;
    const fenMoves = uciMoves.slice();
    statusEl.textContent = 'Thinking of a hint…';
    const done = (uci) => {
      if (token !== hintToken || uciMoves.length !== fenMoves.length) return;
      hintMove = uci ? pos.fromUci(uci) : 0;
      render();
    };
    // Use a separate built-in worker so it never collides with the computer's search.
    const w = new Worker('js/engine.js');
    w.onmessage = (e) => { w.terminate(); done(e.data.bestmove); };
    w.postMessage({ id: 1, fen: START_FEN, moves: fenMoves, timeMs: 1000 });
  }

  // ---------------------------------------------------------------- Input
  function trySelect(sq) {
    const p = pos.board[sq];
    if (p && (p >> 3) === pos.turn && humanToMove() && !gameStatus.over && !thinking) {
      selected = sq;
      legalFromSelected = pos.legalMoves().filter((m) => mFrom(m) === sq);
      return true;
    }
    return false;
  }

  function tryMoveTo(sq) {
    const cands = legalFromSelected.filter((m) => mTo(m) === sq);
    if (!cands.length) return false;
    if (cands.length > 1 || mPromo(cands[0])) {
      askPromotion(cands);
    } else {
      playMove(cands[0]);
    }
    return true;
  }

  function askPromotion(cands) {
    promoBox.innerHTML = '';
    for (const t of [QUEEN, ROOK, BISHOP, KNIGHT]) {
      const m = cands.find((c) => mPromo(c) === t);
      if (!m) continue;
      const btn = document.createElement('button');
      const img = document.createElement('img');
      img.src = pieceImg(t | (pos.turn << 3));
      img.alt = 'NBRQ'[t - 2];
      btn.appendChild(img);
      btn.onclick = () => { promoEl.hidden = true; playMove(m); };
      promoBox.appendChild(btn);
    }
    promoEl.hidden = false;
  }
  promoEl.addEventListener('click', (e) => {
    if (e.target === promoEl) { promoEl.hidden = true; selected = -1; legalFromSelected = []; render(); }
  });

  function sqFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const cell = el && el.closest('.sq');
    return cell ? +cell.dataset.sq : -1;
  }

  let drag = null;
  boardEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !promoEl.hidden) return;
    const sq = sqFromPoint(e.clientX, e.clientY);
    if (sq < 0) return;
    if (selected >= 0 && sq !== selected && tryMoveTo(sq)) return;
    if (trySelect(sq)) {
      const cell = boardEl.querySelector(`[data-sq="${sq}"]`);
      const pieceEl = cell.querySelector('.piece');
      const size = cell.getBoundingClientRect().width;
      const ghost = document.createElement('img');
      ghost.src = pieceEl.src;
      ghost.className = 'drag-ghost';
      ghost.style.width = ghost.style.height = size + 'px';
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
      drag = { sq, ghost, pieceEl, moved: false, wasSelected: false };
      render();
      drag.pieceEl = boardEl.querySelector(`[data-sq="${sq}"] .piece`);
      e.preventDefault();
    } else {
      selected = -1; legalFromSelected = [];
      render();
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      drag.moved = true;
      document.body.appendChild(drag.ghost);
      if (drag.pieceEl) drag.pieceEl.classList.add('dragging');
    }
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  });

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    d.ghost.remove();
    if (!d.moved) return; // plain click: keep selection, wait for destination click
    const sq = sqFromPoint(e.clientX, e.clientY);
    if (sq >= 0 && sq !== d.sq && tryMoveTo(sq)) return;
    render();
  });

  // ---------------------------------------------------------------- Rendering
  function render() {
    renderBoard();
    renderPanel();
  }

  function renderBoard() {
    const frag = document.createDocumentFragment();
    const last = uciMoves.length ? uciMoves[uciMoves.length - 1] : null;
    const lastFrom = last ? sqFromName(last.slice(0, 2)) : -1;
    const lastTo = last ? sqFromName(last.slice(2, 4)) : -1;
    const checkSq = !gameStatus.over || gameStatus.reason === 'checkmate' ? (pos.inCheck() ? pos.kings[pos.turn] : -1) : -1;
    const targets = new Map();
    for (const m of legalFromSelected) targets.set(mTo(m), true);

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = orientation === WHITE ? 7 - row : row;
        const file = orientation === WHITE ? col : 7 - col;
        const sq = rank * 16 + file;
        const cell = document.createElement('div');
        cell.className = 'sq ' + ((rank + file) % 2 ? 'light' : 'dark');
        cell.dataset.sq = sq;
        if (sq === lastFrom || sq === lastTo) cell.classList.add('last');
        if (sq === selected) cell.classList.add('sel');
        if (sq === checkSq) cell.classList.add('check');
        if (hintMove && (sq === mFrom(hintMove) || sq === mTo(hintMove))) cell.classList.add('hint');
        const p = pos.board[sq];
        if (p) {
          const img = document.createElement('img');
          img.className = 'piece';
          img.src = pieceImg(p);
          img.alt = colorName(p >> 3) + ' ' + ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'][p & 7];
          img.draggable = false;
          cell.appendChild(img);
        }
        if (targets.has(sq)) {
          const mark = document.createElement('div');
          mark.className = p ? 'ring' : 'dot';
          cell.appendChild(mark);
        }
        if (col === 0) {
          const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = rank + 1; cell.appendChild(c);
        }
        if (row === 7) {
          const c = document.createElement('span'); c.className = 'coord file'; c.textContent = 'abcdefgh'[file]; cell.appendChild(c);
        }
        frag.appendChild(cell);
      }
    }
    boardEl.replaceChildren(frag);
  }

  function renderCaptured(el, color) {
    const order = { 5: 0, 4: 1, 3: 2, 2: 3, 1: 4 };
    const vals = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9 };
    const list = capturedBy[color].slice().sort((a, b) => order[a & 7] - order[b & 7]);
    el.replaceChildren();
    for (const p of list) {
      const img = document.createElement('img'); img.src = pieceImg(p); img.alt = ''; el.appendChild(img);
    }
    const mine = capturedBy[color].reduce((s, p) => s + vals[p & 7], 0);
    const theirs = capturedBy[color ^ 1].reduce((s, p) => s + vals[p & 7], 0);
    if (mine > theirs) {
      const s = document.createElement('span'); s.className = 'adv'; s.textContent = '+' + (mine - theirs); el.appendChild(s);
    }
  }

  function renderPanel() {
    const topColor = orientation ^ 1, bottomColor = orientation;
    const label = (c) => (isComputer[c] ? 'Computer' : 'You') + ' (' + colorName(c) + ')';
    $('nameTop').textContent = label(topColor);
    $('nameBottom').textContent = label(bottomColor);
    $('nameTop').classList.toggle('thinking', thinking && pos.turn === topColor);
    $('nameBottom').classList.toggle('thinking', thinking && pos.turn === bottomColor);
    renderCaptured($('capTop'), topColor);
    renderCaptured($('capBottom'), bottomColor);

    for (const [id, side, comp] of [['wHuman', 0, false], ['wComp', 0, true], ['bHuman', 1, false], ['bComp', 1, true]]) {
      const el = $(id);
      el.classList.toggle('on', isComputer[side] === comp);
      el.setAttribute('aria-pressed', String(isComputer[side] === comp));
    }
    levelSel.value = level;
    levelRange.value = level;
    const lvl = LEVELS[level];
    $('levelInfo').textContent = lvl.desc;

    let s;
    statusEl.classList.toggle('over', !!gameStatus.over);
    if (gameStatus.over) {
      if (gameStatus.reason === 'checkmate') {
        const winner = gameStatus.result === '1-0' ? WHITE : BLACK;
        const oneHuman = isComputer[WHITE] !== isComputer[BLACK];
        s = `Checkmate — ${colorName(winner)} wins${oneHuman && !isComputer[winner] ? '. Well played!' : '.'}`;
      } else s = `Draw by ${gameStatus.reason}.`;
    } else if (thinking) {
      s = `Computer (${colorName(pos.turn)}) is thinking…`;
    } else {
      s = `${colorName(pos.turn)} to move`;
      if (pos.inCheck()) s += ' — check!';
      if (hintMove) s += ` · Hint: ${pos.toSan(hintMove)}`;
    }
    statusEl.textContent = s;

    const movesEl = $('moves');
    movesEl.replaceChildren();
    for (let i = 0; i < sanMoves.length; i += 2) {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = (i / 2 + 1) + '.';
      const a = document.createElement('span'); a.className = 'm'; a.textContent = sanMoves[i];
      const b = document.createElement('span'); b.className = 'm'; b.textContent = sanMoves[i + 1] || '';
      if (i === sanMoves.length - 1) a.classList.add('cur');
      if (i + 1 === sanMoves.length - 1) b.classList.add('cur');
      li.append(n, a, b);
      movesEl.appendChild(li);
    }
    movesEl.scrollTop = movesEl.scrollHeight;

    $('undoBtn').disabled = !uciMoves.length;
    $('hintBtn').disabled = gameStatus.over || thinking || !humanToMove();
    $('playBtn').disabled = gameStatus.over || thinking;
    updateEngineNote();
  }

  function updateEngineNote() {
    const el = $('engineNote');
    if (!el || !pos) return;
    const lvl = LEVELS[level];
    let sfState;
    if (sfUsable()) sfState = 'Stockfish ready';
    else if (stockfish && !stockfish.failed) sfState = 'Stockfish loading…';
    else sfState = 'Stockfish failed to load, so levels 5–8 use the built-in engine';
    let s;
    if (!lvl.sf) s = `This level uses the built-in engine. Levels 5–8 use Stockfish (${sfState}).`;
    else if (sfUsable()) s = 'This level uses Stockfish.';
    else s = `This level uses the built-in engine for now (${sfState}).`;
    el.textContent = s;
  }

  // ---------------------------------------------------------------- Wire up
  $('switchBtn').onclick = switchSides;
  $('playBtn').onclick = () => maybeComputerMove(true);
  for (const id of ['wHuman', 'wComp', 'bHuman', 'bComp']) {
    const el = $(id);
    el.onclick = () => {
      const next = isComputer.slice();
      next[+el.dataset.side] = el.dataset.who === 'computer';
      setPlayers(next);
    };
  }
  $('newBtn').onclick = newGame;
  $('undoBtn').onclick = undo;
  $('flipBtn').onclick = () => { orientation ^= 1; render(); };
  $('hintBtn').onclick = hint;
  levelSel.onchange = () => setLevel(levelSel.value);
  levelRange.oninput = () => setLevel(levelRange.value);

  newGame();
})();
