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
  let startFen = START_FEN;
  let pos, uciMoves, sanMoves, capturedBy;
  // Earlier stretches of this game, before the position was edited mid-game: [{ fen, sans }]
  let pastSegments = [];
  let baseCaptured = [[], []];
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

  // Position editor state
  let editing = false;
  let edit = null; // { board: Int8Array(128), turn, castling }
  let tool = 'move'; // 'move' | 'erase' | piece code

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
  const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

  LEVELS.forEach((l, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${i + 1}. ${l.name}`;
    levelSel.appendChild(o);
  });
  levelRange.max = LEVELS.length - 1;

  // ---------------------------------------------------------------- Game control
  function startGame(fen, keepHistory) {
    cancelSearch();
    if (keepHistory) {
      pastSegments.push({ fen: startFen, sans: sanMoves.slice(), ucis: uciMoves.slice(), base: baseCaptured });
      baseCaptured = capturedBy.map((l) => l.slice());
    } else {
      pastSegments = [];
      baseCaptured = [[], []];
    }
    startFen = fen;
    pos = new Position(fen);
    uciMoves = []; sanMoves = [];
    capturedBy = baseCaptured.map((l) => l.slice());
    selected = -1; legalFromSelected = []; hintMove = 0;
    gameStatus = pos.status();
    if (stockfish) stockfish.newGame();
    render();
    maybeComputerMove();
  }

  const newGame = () => startGame(START_FEN);

  function victimOf(p, m) {
    const to = mTo(m);
    let victim = p.board[to];
    if (!victim && (p.board[mFrom(m)] & 7) === PAWN && (mFrom(m) & 7) !== (to & 7)) victim = PAWN | ((p.turn ^ 1) << 3);
    return victim;
  }

  function playMove(m) {
    const san = pos.toSan(m);
    const victim = victimOf(pos, m);
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
    if (editing || gameStatus.over || thinking) return;
    if (!force && !isComputer[pos.turn]) return;
    const token = ++searchToken;
    thinking = true;
    render();
    const started = Date.now();
    const lvl = LEVELS[level];
    let p;
    if (lvl.sf && sfUsable()) p = stockfish.go(startFen, uciMoves.slice(), lvl.sf);
    else p = builtin.go(startFen, uciMoves.slice(), lvl.builtin);
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

  const switchSides = () => setPlayers([isComputer[BLACK], isComputer[WHITE]]);

  // Undo the most recent mid-game edit: go back to the game as it was just before it.
  function undoEdit() {
    const seg = pastSegments.pop();
    startFen = seg.fen;
    baseCaptured = seg.base;
    pos = new Position(seg.fen);
    for (const u of seg.ucis) pos.make(pos.fromUci(u));
    uciMoves = seg.ucis.slice();
    sanMoves = seg.sans.slice();
  }

  function undo() {
    cancelSearch();
    if (!uciMoves.length) {
      if (!pastSegments.length) return;
      undoEdit();
      rebuildCaptures();
      selected = -1; legalFromSelected = []; hintMove = 0;
      gameStatus = pos.status();
      render();
      return;
    }
    const popOne = () => { pos.unmake(); uciMoves.pop(); sanMoves.pop(); };
    popOne();
    // Against the computer, take back to a position where it's your move.
    while (isComputer[pos.turn] && !isComputer[pos.turn ^ 1] && uciMoves.length) popOne();
    rebuildCaptures();
    selected = -1; legalFromSelected = []; hintMove = 0;
    gameStatus = pos.status();
    render();
    maybeComputerMove();
  }

  function rebuildCaptures() {
    const p = new Position(startFen);
    capturedBy = baseCaptured.map((l) => l.slice());
    for (const u of uciMoves) {
      const m = p.fromUci(u);
      const victim = victimOf(p, m);
      if (victim) capturedBy[p.turn].push(victim);
      p.make(m);
    }
  }

  function setLevel(i) {
    level = +i;
    store.set('level', level);
    // If the computer is mid-think, restart with the new strength.
    if (thinking) { cancelSearch(); maybeComputerMove(true); }
    renderPanel();
  }

  let hintToken = 0;
  function hint() {
    if (gameStatus.over || !humanToMove() || thinking) return;
    const token = ++hintToken;
    const ply = uciMoves.length;
    statusEl.textContent = 'Looking for a good move…';
    const w = new Worker('js/engine.js');
    w.onmessage = (e) => {
      w.terminate();
      if (token !== hintToken || editing || uciMoves.length !== ply) return;
      hintMove = e.data.bestmove ? pos.fromUci(e.data.bestmove) : 0;
      render();
    };
    w.postMessage({ id: 1, fen: startFen, moves: uciMoves.slice(), timeMs: 1000 });
  }

  // ---------------------------------------------------------------- Position editor
  function enterEditor() {
    cancelSearch();
    hintToken++;
    editing = true;
    const p = new Position(pos.fen());
    edit = { board: Int8Array.from(p.board), turn: p.turn, castling: p.castling, fullmove: p.fullmove };
    tool = 'move';
    selected = -1; legalFromSelected = []; hintMove = 0;
    $('playPanel').hidden = true;
    $('editPanel').hidden = false;
    buildPalette();
    render();
  }

  function leaveEditor() {
    editing = false;
    edit = null;
    $('editPanel').hidden = true;
    $('playPanel').hidden = false;
    render();
  }

  // Castling is only possible with king and rook on their home squares.
  function castlingPossible(b) {
    let mask = 0;
    if (b[0x04] === KING) { if (b[0x07] === ROOK) mask |= 1; if (b[0x00] === ROOK) mask |= 2; }
    if (b[0x74] === (KING | 8)) { if (b[0x77] === (ROOK | 8)) mask |= 4; if (b[0x70] === (ROOK | 8)) mask |= 8; }
    return mask;
  }

  function editFen() {
    const p = new Position('8/8/8/8/8/8/8/8 w - - 0 1');
    p.board.set(edit.board);
    p.turn = edit.turn;
    p.castling = edit.castling & castlingPossible(edit.board);
    p.ep = -1; p.halfmove = 0; p.fullmove = edit.fullmove || 1;
    return p.fen();
  }

  // Returns an error message, or '' if the position can be played.
  function validateEdit() {
    const b = edit.board;
    let wk = 0, bk = 0, wcount = 0, bcount = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p) continue;
      if (p >> 3) bcount++; else wcount++;
      if (p === KING) wk++;
      if (p === (KING | 8)) bk++;
      if ((p & 7) === PAWN && ((sq >> 4) === 0 || (sq >> 4) === 7)) return 'Pawns can’t stand on the first or last rank.';
    }
    if (wk !== 1 || bk !== 1) return 'Each side needs exactly one king.';
    if (wcount > 16 || bcount > 16) return 'Each side can have at most 16 pieces.';
    const p = new Position(editFen());
    if (p.inCheck(p.turn ^ 1)) return `${colorName(p.turn ^ 1)} is in check but it’s ${colorName(p.turn)}’s move. Change the side to move.`;
    return '';
  }

  function placeEdit(sq, piece) {
    if (sq < 0) return;
    if (piece && (piece & 7) === KING) {
      // Only one king per color: move it instead of adding a second.
      for (let s = 0; s < 128; s++) if (!(s & 0x88) && edit.board[s] === piece) edit.board[s] = 0;
    }
    edit.board[sq] = piece;
  }

  function buildPalette() {
    const pal = $('palette');
    pal.replaceChildren();
    const mkTool = (id, icon, text, title) => {
      const b = document.createElement('button');
      b.className = 'pal tool'; b.dataset.tool = id; b.title = title;
      b.innerHTML = `<span class="tool-icon">${icon}</span>${text}`;
      pal.appendChild(b);
    };
    for (const c of [0, 1]) {
      for (const t of [KING, QUEEN, ROOK, BISHOP, KNIGHT, PAWN]) {
        const p = t | (c << 3);
        const b = document.createElement('button');
        b.className = 'pal'; b.dataset.tool = String(p);
        b.title = `${colorName(c)} ${PIECE_NAMES[t]}`;
        b.setAttribute('aria-label', b.title);
        const img = document.createElement('img'); img.src = pieceImg(p); img.alt = '';
        b.appendChild(img);
        pal.appendChild(b);
      }
      if (c === 0) mkTool('move', '✥', 'Move', 'Move pieces around');
      else mkTool('erase', '⌫', 'Erase', 'Tap squares to remove pieces');
    }
  }

  function renderEditPanel() {
    for (const el of $('palette').children) el.classList.toggle('on', el.dataset.tool === String(tool));
    $('turnW').classList.toggle('on', edit.turn === WHITE);
    $('turnB').classList.toggle('on', edit.turn === BLACK);
    const possible = castlingPossible(edit.board);
    [['cK', 1], ['cQ', 2], ['ck', 4], ['cq', 8]].forEach(([id, bit]) => {
      const el = $(id);
      el.disabled = !(possible & bit);
      el.checked = !!(edit.castling & possible & bit);
    });
    const fen = editFen();
    if (document.activeElement !== $('fenInput')) $('fenInput').value = fen;
    const err = validateEdit();
    const st = $('editStatus');
    st.classList.toggle('error', !!err);
    st.textContent = err || 'Position is ready. Continue the game or start a new one from here.';
    $('startGameBtn').disabled = !!err;
    $('continueBtn').disabled = !!err;
  }

  // ---------------------------------------------------------------- Input (play mode)
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
    if (cands.length > 1 || mPromo(cands[0])) askPromotion(cands);
    else playMove(cands[0]);
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
      img.alt = PIECE_NAMES[t];
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
    const cell = el && el.closest && el.closest('.sq');
    return cell && boardEl.contains(cell) ? +cell.dataset.sq : -1;
  }

  // ---------------------------------------------------------------- Dragging (shared)
  let drag = null; // { kind: 'play'|'edit'|'palette', sq, piece, ghost, moved, startX, startY }

  function startDrag(e, info, src) {
    const size = boardEl.getBoundingClientRect().width / 8;
    const ghost = document.createElement('img');
    ghost.src = src;
    ghost.className = 'drag-ghost';
    ghost.style.width = ghost.style.height = size + 'px';
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    drag = { ...info, ghost, moved: false, startX: e.clientX, startY: e.clientY };
  }

  let dropHover = -1;
  function setDropHover(sq) {
    if (sq === dropHover) return;
    const old = boardEl.querySelector('.sq.drop');
    if (old) old.classList.remove('drop');
    dropHover = sq;
    if (sq >= 0) { const c = boardEl.querySelector(`[data-sq="${sq}"]`); if (c) c.classList.add('drop'); }
  }

  boardEl.addEventListener('contextmenu', (e) => {
    if (!editing) return;
    e.preventDefault();
    const sq = sqFromPoint(e.clientX, e.clientY);
    if (sq >= 0) { edit.board[sq] = 0; render(); }
  });

  boardEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !promoEl.hidden) return;
    const sq = sqFromPoint(e.clientX, e.clientY);
    if (sq < 0) return;
    e.preventDefault();

    if (editing) {
      if (tool === 'erase') { edit.board[sq] = 0; render(); return; }
      if (tool !== 'move') {
        const piece = +tool;
        if (edit.board[sq] === piece) edit.board[sq] = 0; else placeEdit(sq, piece);
        render();
        return;
      }
      const piece = edit.board[sq];
      if (piece) startDrag(e, { kind: 'edit', sq, piece }, pieceImg(piece));
      return;
    }

    if (selected >= 0 && sq !== selected && tryMoveTo(sq)) return;
    if (trySelect(sq)) {
      render();
      startDrag(e, { kind: 'play', sq }, pieceImg(pos.board[sq]));
    } else {
      selected = -1; legalFromSelected = [];
      render();
    }
  });

  $('palette').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.pal');
    if (!btn || e.button !== 0) return;
    e.preventDefault();
    const t = btn.dataset.tool;
    if (t === 'move' || t === 'erase') { tool = t; render(); return; }
    startDrag(e, { kind: 'palette', piece: +t }, pieceImg(+t));
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
      drag.moved = true;
      document.body.appendChild(drag.ghost);
      if (drag.kind !== 'palette') {
        const pe = boardEl.querySelector(`[data-sq="${drag.sq}"] .piece`);
        if (pe) pe.classList.add('dragging');
      }
    }
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    setDropHover(sqFromPoint(e.clientX, e.clientY));
  });

  function endDrag(e, cancelled) {
    if (!drag) return;
    const d = drag; drag = null;
    d.ghost.remove();
    setDropHover(-1);
    const sq = cancelled ? -1 : sqFromPoint(e.clientX, e.clientY);

    if (d.kind === 'palette') {
      // A tap selects the piece as the tool; a drag drops it on the board.
      if (!d.moved) tool = (tool === d.piece ? 'move' : d.piece);
      else if (sq >= 0) placeEdit(sq, d.piece);
      render();
      return;
    }
    if (d.kind === 'edit') {
      if (!d.moved) return;
      if (sq !== d.sq) {
        edit.board[d.sq] = 0;
        if (sq >= 0) placeEdit(sq, d.piece); // dropped off the board: removed
      }
      render();
      return;
    }
    // play mode
    if (!d.moved) return; // plain click: keep selection, wait for destination click
    if (sq >= 0 && sq !== d.sq && tryMoveTo(sq)) return;
    render();
  }
  window.addEventListener('pointerup', (e) => endDrag(e, false));
  window.addEventListener('pointercancel', (e) => endDrag(e, true));

  // ---------------------------------------------------------------- Rendering
  function render() {
    renderBoard();
    renderPanel();
    if (editing) renderEditPanel();
  }

  function renderBoard() {
    const frag = document.createDocumentFragment();
    const board = editing ? edit.board : pos.board;
    const hl = new Set();
    let checkSq = -1;
    const targets = new Set();
    if (!editing) {
      const last = uciMoves.length ? uciMoves[uciMoves.length - 1] : null;
      if (last) { hl.add(sqFromName(last.slice(0, 2))); hl.add(sqFromName(last.slice(2, 4))); }
      if (selected >= 0) hl.add(selected);
      if (pos.inCheck()) checkSq = pos.kings[pos.turn];
      for (const m of legalFromSelected) targets.add(mTo(m));
    }

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = orientation === WHITE ? 7 - row : row;
        const file = orientation === WHITE ? col : 7 - col;
        const sq = rank * 16 + file;
        const cell = document.createElement('div');
        cell.className = 'sq ' + ((rank + file) % 2 ? 'light' : 'dark');
        cell.dataset.sq = sq;
        if (hl.has(sq)) cell.classList.add('hl');
        if (sq === checkSq) cell.classList.add('check');
        if (!editing && hintMove && (sq === mFrom(hintMove) || sq === mTo(hintMove))) cell.classList.add('hint');
        const p = board[sq];
        if (p) {
          const img = document.createElement('img');
          img.className = 'piece';
          img.src = pieceImg(p);
          img.alt = colorName(p >> 3) + ' ' + PIECE_NAMES[p & 7];
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
    el.replaceChildren();
    if (editing) return;
    const order = { 5: 0, 4: 1, 3: 2, 2: 3, 1: 4 };
    const vals = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9 };
    const list = capturedBy[color].slice().sort((a, b) => order[a & 7] - order[b & 7]);
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
    const label = (c) => (editing ? colorName(c) : (isComputer[c] ? 'Computer' : 'You') + ' (' + colorName(c) + ')');
    const setBar = (nameId, avId, capId, c) => {
      $(nameId).textContent = label(c);
      $(nameId).classList.toggle('thinking', !editing && thinking && pos.turn === c);
      $(avId).style.backgroundImage = `url(pieces/${c ? 'b' : 'w'}${!editing && isComputer[c] ? 'N' : 'K'}.svg)`;
      renderCaptured($(capId), c);
    };
    setBar('nameTop', 'avTop', 'capTop', topColor);
    setBar('nameBottom', 'avBottom', 'capBottom', bottomColor);
    if (editing) return;

    for (const [id, side, comp] of [['wHuman', 0, false], ['wComp', 0, true], ['bHuman', 1, false], ['bComp', 1, true]]) {
      const el = $(id);
      el.classList.toggle('on', isComputer[side] === comp);
      el.setAttribute('aria-pressed', String(isComputer[side] === comp));
    }
    levelSel.value = level;
    levelRange.value = level;
    $('levelInfo').textContent = LEVELS[level].desc;

    let s;
    statusEl.classList.toggle('over', !!gameStatus.over);
    if (gameStatus.over) {
      if (gameStatus.reason === 'checkmate') {
        const winner = gameStatus.result === '1-0' ? WHITE : BLACK;
        const oneHuman = isComputer[WHITE] !== isComputer[BLACK];
        s = `Checkmate. ${colorName(winner)} wins${oneHuman && !isComputer[winner] ? '. Well played!' : '.'}`;
      } else s = `Draw by ${gameStatus.reason}.`;
    } else if (thinking) {
      s = `Computer (${colorName(pos.turn)}) is thinking…`;
    } else {
      s = `${colorName(pos.turn)} to move`;
      if (pos.inCheck()) s += ', check!';
      if (hintMove) s += ` · Hint: ${pos.toSan(hintMove)}`;
    }
    statusEl.textContent = s;

    // Move list: earlier segments (before mid-game edits), then the current one.
    const movesEl = $('moves');
    movesEl.replaceChildren();
    const addSegment = (fen, sans, isCurrent) => {
      const start = new Position(fen);
      const offset = start.turn === BLACK ? 1 : 0;
      const total = sans.length + offset;
      for (let i = 0; i < total && sans.length; i += 2) {
        const li = document.createElement('li');
        const n = document.createElement('span'); n.className = 'n'; n.textContent = (start.fullmove + i / 2) + '.';
        li.appendChild(n);
        for (const j of [i, i + 1]) {
          const k = j - offset;
          const span = document.createElement('span'); span.className = 'm';
          span.textContent = k < 0 ? '…' : (sans[k] || '');
          if (isCurrent && k === sans.length - 1) span.classList.add('cur');
          li.appendChild(span);
        }
        movesEl.appendChild(li);
      }
    };
    const note = (text) => {
      const li = document.createElement('li');
      li.className = 'note';
      li.textContent = text;
      movesEl.appendChild(li);
    };
    for (const seg of pastSegments) { addSegment(seg.fen, seg.sans, false); note('Board edited'); }
    addSegment(startFen, sanMoves, true);
    if (!sanMoves.length && !pastSegments.length) note('No moves yet');
    const wrap = movesEl.parentElement;
    wrap.scrollTop = wrap.scrollHeight;

    $('undoBtn').disabled = !uciMoves.length && !pastSegments.length;
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
  $('editBtn').onclick = enterEditor;
  levelSel.onchange = () => setLevel(levelSel.value);
  levelRange.oninput = () => setLevel(levelRange.value);

  // Editor controls
  $('turnW').onclick = () => { edit.turn = WHITE; render(); };
  $('turnB').onclick = () => { edit.turn = BLACK; render(); };
  [['cK', 1], ['cQ', 2], ['ck', 4], ['cq', 8]].forEach(([id, bit]) => {
    $(id).onchange = (e) => { edit.castling = e.target.checked ? (edit.castling | bit) : (edit.castling & ~bit); render(); };
  });
  $('startPosBtn').onclick = () => {
    const p = new Position(START_FEN);
    edit = { board: Int8Array.from(p.board), turn: WHITE, castling: 15, fullmove: 1 };
    render();
  };
  $('clearBtn').onclick = () => { edit.board.fill(0); edit.castling = 0; render(); };
  $('editFlipBtn').onclick = () => { orientation ^= 1; render(); };
  const loadFen = () => {
    try {
      const p = new Position($('fenInput').value);
      edit = { board: Int8Array.from(p.board), turn: p.turn, castling: p.castling, fullmove: p.fullmove };
      $('fenInput').blur();
      render();
    } catch {
      const st = $('editStatus');
      st.classList.add('error');
      st.textContent = 'That FEN couldn’t be read. Check it and try again.';
    }
  };
  $('fenLoadBtn').onclick = loadFen;
  $('fenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFen(); });
  $('cancelEditBtn').onclick = leaveEditor;
  const finishEdit = (keepHistory) => {
    if (validateEdit()) return;
    const fen = editFen();
    editing = false; edit = null;
    $('editPanel').hidden = true;
    $('playPanel').hidden = false;
    startGame(fen, keepHistory);
  };
  $('startGameBtn').onclick = () => finishEdit(false);
  $('continueBtn').onclick = () => finishEdit(true);

  newGame();
})();
