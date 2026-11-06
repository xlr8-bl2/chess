/*
 * Built-in engine (Web Worker). Alpha-beta / PVS with iterative deepening,
 * transposition table, quiescence search, null-move pruning, LMR, killers & history.
 *
 * Message in:  { id, fen, moves: [uci...], depth, timeMs, noise, blunder }
 * Message out: { id, bestmove, score, depth }
 */
importScripts('chess.js');

const { Position, mFrom, mTo, mPromo, mFlag, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, FLAG_EP } = self.Chess;

const INF = 32000, MATE = 30000;
const VALUE = [0, 100, 320, 330, 500, 900, 0];
const PHASE = [0, 0, 1, 1, 2, 4, 0];

// Piece-square tables, from White's view, a8..h8 first.
const PST_MG = [
  null,
  [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
];
const PST_EG = PST_MG.slice();
PST_EG[PAWN] = [0, 0, 0, 0, 0, 0, 0, 0, 80, 80, 80, 80, 80, 80, 80, 80, 50, 50, 50, 50, 50, 50, 50, 50, 30, 30, 30, 30, 30, 30, 30, 30, 20, 20, 20, 20, 20, 20, 20, 20, 10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
PST_EG[KING] = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];

const PASSED_BONUS = [0, 5, 10, 20, 35, 60, 100, 0];

function evaluate(pos) {
  const b = pos.board;
  let mg = 0, eg = 0, phase = 0;
  const pawnFiles = [new Int8Array(10), new Int8Array(10)]; // files shifted by 1
  const pawnMinRank = [new Int8Array(10).fill(8), new Int8Array(10).fill(8)]; // white: lowest rank
  const pawnMaxRank = [new Int8Array(10).fill(-1), new Int8Array(10).fill(-1)];
  let bishops0 = 0, bishops1 = 0;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = p & 7, c = p >> 3;
    const r = sq >> 4, f = sq & 7;
    const idx = c === 0 ? (7 - r) * 8 + f : r * 8 + f;
    const s = c === 0 ? 1 : -1;
    mg += s * (VALUE[t] + PST_MG[t][idx]);
    eg += s * (VALUE[t] + PST_EG[t][idx]);
    phase += PHASE[t];
    if (t === PAWN) {
      pawnFiles[c][f + 1]++;
      if (r < pawnMinRank[c][f + 1]) pawnMinRank[c][f + 1] = r;
      if (r > pawnMaxRank[c][f + 1]) pawnMaxRank[c][f + 1] = r;
    } else if (t === BISHOP) { if (c) bishops1++; else bishops0++; }
  }

  // Pawn structure
  for (let c = 0; c < 2; c++) {
    const s = c === 0 ? 1 : -1;
    const own = pawnFiles[c], opp = pawnFiles[c ^ 1];
    for (let f = 1; f <= 8; f++) {
      if (!own[f]) continue;
      if (own[f] > 1) { mg -= s * 10 * (own[f] - 1); eg -= s * 20 * (own[f] - 1); }
      if (!own[f - 1] && !own[f + 1]) { mg -= s * 12; eg -= s * 15; }
    }
  }
  // Passed pawns
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if ((p & 7) !== PAWN) continue;
    const c = p >> 3, r = sq >> 4, f = (sq & 7) + 1;
    let passed = true;
    for (let ff = f - 1; ff <= f + 1 && passed; ff++) {
      if (c === 0) { if (pawnMaxRank[1][ff] > r) passed = false; }
      else { if (pawnMinRank[0][ff] < r && pawnFiles[0][ff]) passed = false; }
    }
    if (passed) {
      const rel = c === 0 ? r : 7 - r;
      const s = c === 0 ? 1 : -1;
      mg += s * PASSED_BONUS[rel] / 2;
      eg += s * PASSED_BONUS[rel];
    }
  }
  if (bishops0 >= 2) { mg += 30; eg += 40; }
  if (bishops1 >= 2) { mg -= 30; eg -= 40; }

  // Mop-up: help the winning side drive the lone king to the edge in simple endgames.
  if (phase <= 6 && Math.abs(eg) > 300) {
    const strong = eg > 0 ? 0 : 1;
    const wk = pos.kings[strong], lk = pos.kings[strong ^ 1];
    const lr = lk >> 4, lf = lk & 7;
    const centerDist = Math.max(3 - lr, lr - 4) + Math.max(3 - lf, lf - 4);
    const kingDist = Math.abs((wk >> 4) - lr) + Math.abs((wk & 7) - lf);
    const bonus = centerDist * 10 + (14 - kingDist) * 4;
    eg += strong === 0 ? bonus : -bonus;
  }

  if (phase > 24) phase = 24;
  const score = ((mg * phase + eg * (24 - phase)) / 24) | 0;
  return pos.turn === 0 ? score + 10 : -score + 10; // small tempo bonus
}

// ---- Transposition table ----
const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE), ttScore = new Int16Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE), ttFlag = new Uint8Array(TT_SIZE);
const EXACT = 1, LOWER = 2, UPPER = 3;

let nodes = 0, stopTime = 0, stopped = false;
let killers = [], history = new Int32Array(16 * 128);

function moveScore(pos, m, ttm, ply) {
  if (m === ttm) return 1e7;
  const b = pos.board, to = mTo(m);
  const victim = mFlag(m) === FLAG_EP ? PAWN : (b[to] & 7);
  if (victim) return 1e6 + VALUE[victim] * 10 - VALUE[b[mFrom(m)] & 7] / 10;
  if (mPromo(m)) return 9e5 + VALUE[mPromo(m)];
  const k = killers[ply];
  if (k) { if (m === k[0]) return 8e5; if (m === k[1]) return 7e5; }
  return history[b[mFrom(m)] * 128 + to];
}

function orderMoves(pos, moves, ttm, ply) {
  const scores = moves.map((m) => moveScore(pos, m, ttm, ply));
  const idx = moves.map((_, i) => i).sort((a, c) => scores[c] - scores[a]);
  return idx.map((i) => moves[i]);
}

function checkTime() {
  if ((++nodes & 2047) === 0 && Date.now() > stopTime) stopped = true;
}

function quiesce(pos, alpha, beta, ply) {
  checkTime();
  if (stopped) return 0;
  const stand = evaluate(pos);
  if (stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  if (ply > 60) return stand;
  const moves = orderMoves(pos, pos.genMoves(true), 0, ply);
  for (const m of moves) {
    // delta pruning
    const victim = mFlag(m) === FLAG_EP ? PAWN : (pos.board[mTo(m)] & 7);
    if (!mPromo(m) && stand + VALUE[victim] + 200 < alpha) continue;
    if (!pos.make(m)) continue;
    const score = -quiesce(pos, -beta, -alpha, ply + 1);
    pos.unmake();
    if (stopped) return 0;
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function hasNonPawnMaterial(pos) {
  const b = pos.board, us = pos.turn;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (p && (p >> 3) === us) { const t = p & 7; if (t !== PAWN && t !== KING) return true; }
  }
  return false;
}

function search(pos, depth, alpha, beta, ply, allowNull) {
  checkTime();
  if (stopped) return 0;
  if (ply > 0) {
    if (pos.halfmove >= 100 || pos.repetitions() > 0) return 0;
    // mate distance pruning
    alpha = Math.max(alpha, -MATE + ply);
    beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;
  }
  const inCheck = pos.inCheck();
  if (inCheck) depth++;
  if (depth <= 0) return quiesce(pos, alpha, beta, ply);

  const pv = beta - alpha > 1;
  const ti = pos.hashLo & TT_MASK;
  let ttm = 0;
  if (ttKey[ti] === pos.hashHi) {
    ttm = ttMove[ti];
    if (!pv && ttDepth[ti] >= depth && ply > 0) {
      let s = ttScore[ti];
      if (s > MATE - 200) s -= ply; else if (s < -MATE + 200) s += ply;
      const fl = ttFlag[ti];
      if (fl === EXACT || (fl === LOWER && s >= beta) || (fl === UPPER && s <= alpha)) return s;
    }
  }

  // Null move pruning
  if (allowNull && !pv && !inCheck && depth >= 3 && hasNonPawnMaterial(pos) && evaluate(pos) >= beta) {
    pos.makeNull();
    const s = -search(pos, depth - 3, -beta, -beta + 1, ply + 1, false);
    pos.unmakeNull();
    if (stopped) return 0;
    if (s >= beta) return beta;
  }

  const moves = orderMoves(pos, pos.genMoves(), ttm, ply);
  let best = -INF, bestMove = 0, legal = 0;
  const origAlpha = alpha;
  for (const m of moves) {
    const isQuiet = !pos.board[mTo(m)] && !mPromo(m) && mFlag(m) !== FLAG_EP;
    if (!pos.make(m)) continue;
    legal++;
    let score;
    if (legal === 1) {
      score = -search(pos, depth - 1, -beta, -alpha, ply + 1, true);
    } else {
      let r = 0;
      if (depth >= 3 && legal > 3 && isQuiet && !inCheck && !pos.inCheck()) r = legal > 8 ? 2 : 1;
      score = -search(pos, depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
      if (score > alpha && r) score = -search(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
      if (score > alpha && score < beta) score = -search(pos, depth - 1, -beta, -alpha, ply + 1, true);
    }
    pos.unmake();
    if (stopped) return 0;
    if (score > best) {
      best = score; bestMove = m;
      if (score > alpha) {
        alpha = score;
        if (score >= beta) {
          if (isQuiet) {
            const k = killers[ply] || (killers[ply] = [0, 0]);
            if (k[0] !== m) { k[1] = k[0]; k[0] = m; }
            history[pos.board[mFrom(m)] * 128 + mTo(m)] += depth * depth;
          }
          break;
        }
      }
    }
  }
  if (!legal) return inCheck ? -MATE + ply : 0;

  let stored = best;
  if (stored > MATE - 200) stored += ply; else if (stored < -MATE + 200) stored -= ply;
  ttKey[ti] = pos.hashHi; ttMove[ti] = bestMove; ttScore[ti] = stored;
  ttDepth[ti] = depth; ttFlag[ti] = best >= beta ? LOWER : best > origAlpha ? EXACT : UPPER;
  return best;
}

// Root search; returns [{move, score}] for searched moves (full window when wantAll)
function rootSearch(pos, depth, moves, wantAll) {
  let alpha = -INF;
  const results = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    pos.make(m);
    let score;
    if (wantAll || i === 0) score = -search(pos, depth - 1, -INF, wantAll ? INF : -alpha, 1, true);
    else {
      score = -search(pos, depth - 1, -alpha - 1, -alpha, 1, true);
      if (score > alpha && !stopped) score = -search(pos, depth - 1, -INF, -alpha, 1, true);
    }
    pos.unmake();
    if (stopped) break;
    results.push({ move: m, score });
    if (score > alpha) alpha = score;
  }
  return results;
}

function think({ fen, moves, depth, timeMs, noise, blunder }) {
  const pos = new Position(fen);
  for (const u of moves || []) pos.make(pos.fromUci(u));
  const legal = pos.legalMoves();
  if (!legal.length) return { bestmove: null, score: 0, depth: 0 };
  if (legal.length === 1) return { bestmove: pos.toUci(legal[0]), score: 0, depth: 0 };

  if (blunder && Math.random() < blunder) {
    const m = legal[(Math.random() * legal.length) | 0];
    return { bestmove: pos.toUci(m), score: 0, depth: 0 };
  }

  nodes = 0; stopped = false;
  stopTime = Date.now() + (timeMs || 1e9);
  killers = []; history.fill(0);

  let order = orderMoves(pos, legal, 0, 0);
  let best = { move: order[0], score: 0 }, doneDepth = 0;
  const maxDepth = depth || 64;
  for (let d = 1; d <= maxDepth; d++) {
    const res = rootSearch(pos, d, order, noise > 0);
    if (!res.length) break;
    if (stopped) {
      // partial iteration: keep improvement only if found
      const top = res.reduce((a, c) => (c.score > a.score ? c : a));
      if (top.move !== best.move && top.score > best.score) best = top;
      break;
    }
    res.sort((a, c) => c.score - a.score);
    doneDepth = d;
    if (noise > 0) {
      let pick = res[0], pickVal = -Infinity;
      for (const r of res) {
        const v = r.score + (Math.random() * 2 - 1) * noise;
        if (v > pickVal) { pickVal = v; pick = r; }
      }
      best = pick;
    } else best = res[0];
    order = res.map((r) => r.move).concat(order.filter((m) => !res.some((r) => r.move === m)));
    if (Math.abs(res[0].score) > MATE - 100) break; // found a mate
  }
  return { bestmove: pos.toUci(best.move), score: best.score, depth: doneDepth };
}

self.onmessage = (e) => {
  const req = e.data;
  const out = think(req);
  self.postMessage({ id: req.id, ...out });
};
