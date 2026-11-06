/*
 * Chess rules core (0x88 board). Shared by the UI and the built-in engine worker.
 * Pieces: type | (color << 3). Types: 1 P, 2 N, 3 B, 4 R, 5 Q, 6 K. Colors: 0 white, 1 black.
 * Moves are ints: from | to << 7 | promo << 14 | flag << 17
 *   flag: 0 normal, 1 double pawn push, 2 en passant, 3 castle
 */
(function (root) {
  'use strict';

  const WHITE = 0, BLACK = 1;
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const FLAG_DOUBLE = 1, FLAG_EP = 2, FLAG_CASTLE = 3;

  const N_DIRS = [-33, -31, -18, -14, 14, 18, 31, 33];
  const B_DIRS = [-17, -15, 15, 17];
  const R_DIRS = [-16, -1, 1, 16];
  const K_DIRS = [-17, -16, -15, -1, 1, 15, 16, 17];

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Castling rights: 1 = white O-O, 2 = white O-O-O, 4 = black O-O, 8 = black O-O-O
  const CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[0x04] = 15 & ~3; CASTLE_MASK[0x07] = 15 & ~1; CASTLE_MASK[0x00] = 15 & ~2;
  CASTLE_MASK[0x74] = 15 & ~12; CASTLE_MASK[0x77] = 15 & ~4; CASTLE_MASK[0x70] = 15 & ~8;

  // ---- Zobrist keys (deterministic PRNG so every thread agrees) ----
  let seed = 0x9e3779b9 | 0;
  function rnd32() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed | 0;
  }
  const Z_PIECE_LO = new Int32Array(16 * 128), Z_PIECE_HI = new Int32Array(16 * 128);
  for (let i = 0; i < 16 * 128; i++) { Z_PIECE_LO[i] = rnd32(); Z_PIECE_HI[i] = rnd32(); }
  const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16);
  for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rnd32(); Z_CASTLE_HI[i] = rnd32(); }
  const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
  for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rnd32(); Z_EP_HI[i] = rnd32(); }
  const Z_SIDE_LO = rnd32(), Z_SIDE_HI = rnd32();

  const mFrom = (m) => m & 127;
  const mTo = (m) => (m >> 7) & 127;
  const mPromo = (m) => (m >> 14) & 7;
  const mFlag = (m) => (m >> 17) & 3;
  const mk = (from, to, promo, flag) => from | (to << 7) | (promo << 14) | (flag << 17);

  const sqName = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 4) + 1);
  const sqFromName = (s) => (s.charCodeAt(0) - 97) + (s.charCodeAt(1) - 49) * 16;

  const PIECE_CHARS = ' pnbrqk';

  class Position {
    constructor(fen) {
      this.board = new Int8Array(128);
      this.load(fen || START_FEN);
    }

    load(fen) {
      const parts = fen.trim().split(/\s+/);
      this.board.fill(0);
      this.kings = [-1, -1];
      let rank = 7, file = 0;
      for (const ch of parts[0]) {
        if (ch === '/') { rank--; file = 0; continue; }
        if (ch >= '1' && ch <= '8') { file += +ch; continue; }
        const lower = ch.toLowerCase();
        const type = PIECE_CHARS.indexOf(lower);
        if (type < 1) throw new Error('Bad FEN');
        const color = ch === lower ? BLACK : WHITE;
        const sq = rank * 16 + file;
        this.board[sq] = type | (color << 3);
        if (type === KING) this.kings[color] = sq;
        file++;
      }
      this.turn = (parts[1] || 'w') === 'w' ? WHITE : BLACK;
      const c = parts[2] || '-';
      this.castling = (c.includes('K') ? 1 : 0) | (c.includes('Q') ? 2 : 0) | (c.includes('k') ? 4 : 0) | (c.includes('q') ? 8 : 0);
      this.ep = parts[3] && parts[3] !== '-' ? sqFromName(parts[3]) : -1;
      this.halfmove = parseInt(parts[4] || '0', 10);
      this.fullmove = parseInt(parts[5] || '1', 10);
      this.stack = [];
      this.histLo = [];
      this.histHi = [];
      this.computeHash();
    }

    computeHash() {
      let lo = 0, hi = 0;
      for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const p = this.board[sq];
        if (p) { lo ^= Z_PIECE_LO[p * 128 + sq]; hi ^= Z_PIECE_HI[p * 128 + sq]; }
      }
      lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
      if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
      if (this.turn) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
      this.hashLo = lo; this.hashHi = hi;
    }

    fen() {
      let s = '';
      for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[r * 16 + f];
          if (!p) { empty++; continue; }
          if (empty) { s += empty; empty = 0; }
          const ch = PIECE_CHARS[p & 7];
          s += (p >> 3) ? ch : ch.toUpperCase();
        }
        if (empty) s += empty;
        if (r) s += '/';
      }
      let c = '';
      if (this.castling & 1) c += 'K';
      if (this.castling & 2) c += 'Q';
      if (this.castling & 4) c += 'k';
      if (this.castling & 8) c += 'q';
      return `${s} ${this.turn ? 'b' : 'w'} ${c || '-'} ${this.ep >= 0 ? sqName(this.ep) : '-'} ${this.halfmove} ${this.fullmove}`;
    }

    attacked(sq, by) {
      const b = this.board;
      // pawns
      if (by === WHITE) {
        let s = sq - 15; if (!(s & 0x88) && b[s] === PAWN) return true;
        s = sq - 17; if (!(s & 0x88) && b[s] === PAWN) return true;
      } else {
        let s = sq + 15; if (!(s & 0x88) && b[s] === (PAWN | 8)) return true;
        s = sq + 17; if (!(s & 0x88) && b[s] === (PAWN | 8)) return true;
      }
      const cb = by << 3;
      for (let i = 0; i < 8; i++) {
        const s = sq + N_DIRS[i];
        if (!(s & 0x88) && b[s] === (KNIGHT | cb)) return true;
      }
      for (let i = 0; i < 8; i++) {
        const s = sq + K_DIRS[i];
        if (!(s & 0x88) && b[s] === (KING | cb)) return true;
      }
      for (let i = 0; i < 4; i++) {
        const d = B_DIRS[i];
        let s = sq + d;
        while (!(s & 0x88)) {
          const p = b[s];
          if (p) { if ((p === (BISHOP | cb)) || (p === (QUEEN | cb))) return true; break; }
          s += d;
        }
      }
      for (let i = 0; i < 4; i++) {
        const d = R_DIRS[i];
        let s = sq + d;
        while (!(s & 0x88)) {
          const p = b[s];
          if (p) { if ((p === (ROOK | cb)) || (p === (QUEEN | cb))) return true; break; }
          s += d;
        }
      }
      return false;
    }

    inCheck(color = this.turn) {
      return this.attacked(this.kings[color], color ^ 1);
    }

    // Pseudo-legal move generation (castling is fully checked).
    genMoves(capturesOnly = false) {
      const moves = [];
      const b = this.board, us = this.turn, them = us ^ 1;
      for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const p = b[sq];
        if (!p || (p >> 3) !== us) continue;
        const type = p & 7;
        if (type === PAWN) {
          const dir = us === WHITE ? 16 : -16;
          const startRank = us === WHITE ? 1 : 6;
          const promoRank = us === WHITE ? 7 : 0;
          const one = sq + dir;
          if (!(one & 0x88) && !b[one]) {
            if ((one >> 4) === promoRank) {
              moves.push(mk(sq, one, QUEEN, 0));
              if (!capturesOnly) {
                moves.push(mk(sq, one, ROOK, 0), mk(sq, one, BISHOP, 0), mk(sq, one, KNIGHT, 0));
              }
            } else if (!capturesOnly) {
              moves.push(mk(sq, one, 0, 0));
              const two = one + dir;
              if ((sq >> 4) === startRank && !b[two]) moves.push(mk(sq, two, 0, FLAG_DOUBLE));
            }
          }
          for (const cd of [dir - 1, dir + 1]) {
            const t = sq + cd;
            if (t & 0x88) continue;
            if (b[t] && (b[t] >> 3) === them) {
              if ((t >> 4) === promoRank) {
                moves.push(mk(sq, t, QUEEN, 0));
                if (!capturesOnly) moves.push(mk(sq, t, ROOK, 0), mk(sq, t, BISHOP, 0), mk(sq, t, KNIGHT, 0));
              } else moves.push(mk(sq, t, 0, 0));
            } else if (t === this.ep) {
              moves.push(mk(sq, t, 0, FLAG_EP));
            }
          }
        } else if (type === KNIGHT || type === KING) {
          const dirs = type === KNIGHT ? N_DIRS : K_DIRS;
          for (let i = 0; i < 8; i++) {
            const t = sq + dirs[i];
            if (t & 0x88) continue;
            const q = b[t];
            if (q) { if ((q >> 3) === them) moves.push(mk(sq, t, 0, 0)); }
            else if (!capturesOnly) moves.push(mk(sq, t, 0, 0));
          }
          if (type === KING && !capturesOnly) {
            const base = us === WHITE ? 0 : 0x70;
            const ks = us === WHITE ? 1 : 4, qs = us === WHITE ? 2 : 8;
            if (sq === base + 4 && (this.castling & (ks | qs)) && !this.attacked(sq, them)) {
              if ((this.castling & ks) && !b[base + 5] && !b[base + 6] && b[base + 7] === (ROOK | (us << 3)) &&
                !this.attacked(base + 5, them) && !this.attacked(base + 6, them)) {
                moves.push(mk(sq, base + 6, 0, FLAG_CASTLE));
              }
              if ((this.castling & qs) && !b[base + 3] && !b[base + 2] && !b[base + 1] && b[base] === (ROOK | (us << 3)) &&
                !this.attacked(base + 3, them) && !this.attacked(base + 2, them)) {
                moves.push(mk(sq, base + 2, 0, FLAG_CASTLE));
              }
            }
          }
        } else {
          const dirs = type === BISHOP ? B_DIRS : type === ROOK ? R_DIRS : K_DIRS;
          for (let i = 0; i < dirs.length; i++) {
            const d = dirs[i];
            let t = sq + d;
            while (!(t & 0x88)) {
              const q = b[t];
              if (q) { if ((q >> 3) === them) moves.push(mk(sq, t, 0, 0)); break; }
              if (!capturesOnly) moves.push(mk(sq, t, 0, 0));
              t += d;
            }
          }
        }
      }
      return moves;
    }

    // Returns false (and leaves position unchanged) if the move leaves own king in check.
    make(m) {
      const b = this.board;
      const from = mFrom(m), to = mTo(m), promo = mPromo(m), flag = mFlag(m);
      const us = this.turn;
      const piece = b[from];
      let captured = b[to];
      let capSq = to;
      if (flag === FLAG_EP) { capSq = to + (us === WHITE ? -16 : 16); captured = b[capSq]; }

      this.stack.push({ m, captured, castling: this.castling, ep: this.ep, halfmove: this.halfmove, lo: this.hashLo, hi: this.hashHi });
      this.histLo.push(this.hashLo); this.histHi.push(this.hashHi);

      let lo = this.hashLo, hi = this.hashHi;
      if (captured) {
        b[capSq] = 0;
        lo ^= Z_PIECE_LO[captured * 128 + capSq]; hi ^= Z_PIECE_HI[captured * 128 + capSq];
      }
      b[from] = 0;
      lo ^= Z_PIECE_LO[piece * 128 + from]; hi ^= Z_PIECE_HI[piece * 128 + from];
      const placed = promo ? (promo | (us << 3)) : piece;
      b[to] = placed;
      lo ^= Z_PIECE_LO[placed * 128 + to]; hi ^= Z_PIECE_HI[placed * 128 + to];

      if (flag === FLAG_CASTLE) {
        const rFrom = to > from ? to + 1 : to - 2;
        const rTo = to > from ? to - 1 : to + 1;
        const rook = b[rFrom];
        b[rFrom] = 0; b[rTo] = rook;
        lo ^= Z_PIECE_LO[rook * 128 + rFrom] ^ Z_PIECE_LO[rook * 128 + rTo];
        hi ^= Z_PIECE_HI[rook * 128 + rFrom] ^ Z_PIECE_HI[rook * 128 + rTo];
      }
      if ((piece & 7) === KING) this.kings[us] = to;

      lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
      this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
      lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];

      if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
      this.ep = -1;
      if (flag === FLAG_DOUBLE) {
        this.ep = (from + to) >> 1;
        lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7];
      }

      this.halfmove = ((piece & 7) === PAWN || captured) ? 0 : this.halfmove + 1;
      if (us === BLACK) this.fullmove++;
      this.turn ^= 1;
      lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI;
      this.hashLo = lo; this.hashHi = hi;

      if (this.attacked(this.kings[us], us ^ 1)) { this.unmake(); return false; }
      return true;
    }

    unmake() {
      const u = this.stack.pop();
      this.histLo.pop(); this.histHi.pop();
      const b = this.board, m = u.m;
      const from = mFrom(m), to = mTo(m), promo = mPromo(m), flag = mFlag(m);
      this.turn ^= 1;
      const us = this.turn;
      if (us === BLACK) this.fullmove--;
      const moved = promo ? (PAWN | (us << 3)) : b[to];
      b[from] = moved;
      b[to] = 0;
      if (flag === FLAG_EP) b[to + (us === WHITE ? -16 : 16)] = u.captured;
      else b[to] = u.captured;
      if (flag === FLAG_CASTLE) {
        const rFrom = to > from ? to + 1 : to - 2;
        const rTo = to > from ? to - 1 : to + 1;
        b[rFrom] = b[rTo]; b[rTo] = 0;
      }
      if ((moved & 7) === KING) this.kings[us] = from;
      this.castling = u.castling; this.ep = u.ep; this.halfmove = u.halfmove;
      this.hashLo = u.lo; this.hashHi = u.hi;
      return m;
    }

    makeNull() {
      this.stack.push({ m: 0, captured: 0, castling: this.castling, ep: this.ep, halfmove: this.halfmove, lo: this.hashLo, hi: this.hashHi, isNull: true });
      this.histLo.push(this.hashLo); this.histHi.push(this.hashHi);
      if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[this.ep & 7]; this.hashHi ^= Z_EP_HI[this.ep & 7]; }
      this.ep = -1;
      this.turn ^= 1;
      this.halfmove++;
      this.hashLo ^= Z_SIDE_LO; this.hashHi ^= Z_SIDE_HI;
    }

    unmakeNull() {
      const u = this.stack.pop();
      this.histLo.pop(); this.histHi.pop();
      this.turn ^= 1;
      this.ep = u.ep; this.halfmove = u.halfmove; this.hashLo = u.lo; this.hashHi = u.hi;
    }

    legalMoves() {
      const out = [];
      for (const m of this.genMoves()) {
        if (this.make(m)) { this.unmake(); out.push(m); }
      }
      return out;
    }

    // Number of earlier occurrences of the current position (within the reversible window).
    repetitions() {
      let count = 0;
      const n = this.histLo.length;
      for (let i = n - 2; i >= 0 && i >= n - this.halfmove; i -= 2) {
        if (this.histLo[i] === this.hashLo && this.histHi[i] === this.hashHi) count++;
      }
      return count;
    }

    insufficientMaterial() {
      let minors = 0, bishopColors = [];
      for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        const p = this.board[sq];
        if (!p) continue;
        const t = p & 7;
        if (t === KING) continue;
        if (t === PAWN || t === ROOK || t === QUEEN) return false;
        minors++;
        if (t === BISHOP) bishopColors.push(((sq >> 4) + (sq & 7)) & 1);
        else bishopColors.push(-1);
      }
      if (minors <= 1) return true;
      // Only bishops, all on the same color squares
      return bishopColors.every((c) => c !== -1 && c === bishopColors[0]);
    }

    // { over, result: '1-0' | '0-1' | '1/2-1/2' | '*', reason }
    status() {
      const legal = this.legalMoves();
      if (legal.length === 0) {
        if (this.inCheck()) return { over: true, result: this.turn === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
        return { over: true, result: '1/2-1/2', reason: 'stalemate' };
      }
      if (this.insufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
      if (this.halfmove >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
      if (this.repetitions() >= 2) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
      return { over: false, result: '*', reason: '' };
    }

    toUci(m) {
      const p = mPromo(m);
      return sqName(mFrom(m)) + sqName(mTo(m)) + (p ? PIECE_CHARS[p] : '');
    }

    fromUci(uci) {
      const from = sqFromName(uci.slice(0, 2)), to = sqFromName(uci.slice(2, 4));
      const promo = uci.length > 4 ? PIECE_CHARS.indexOf(uci[4]) : 0;
      for (const m of this.legalMoves()) {
        if (mFrom(m) === from && mTo(m) === to && mPromo(m) === promo) return m;
      }
      return 0;
    }

    // Standard algebraic notation for a legal move in the current position.
    toSan(m) {
      const from = mFrom(m), to = mTo(m), flag = mFlag(m), promo = mPromo(m);
      const piece = this.board[from], type = piece & 7;
      let san;
      if (flag === FLAG_CASTLE) {
        san = to > from ? 'O-O' : 'O-O-O';
      } else {
        const isCapture = !!this.board[to] || flag === FLAG_EP;
        if (type === PAWN) {
          san = isCapture ? 'abcdefgh'[from & 7] + 'x' : '';
          san += sqName(to);
          if (promo) san += '=' + PIECE_CHARS[promo].toUpperCase();
        } else {
          san = PIECE_CHARS[type].toUpperCase();
          const others = this.legalMoves().filter((o) => o !== m && mTo(o) === to && this.board[mFrom(o)] === piece);
          if (others.length) {
            const sameFile = others.some((o) => (mFrom(o) & 7) === (from & 7));
            const sameRank = others.some((o) => (mFrom(o) >> 4) === (from >> 4));
            if (!sameFile) san += 'abcdefgh'[from & 7];
            else if (!sameRank) san += (from >> 4) + 1;
            else san += sqName(from);
          }
          if (isCapture) san += 'x';
          san += sqName(to);
        }
      }
      this.make(m);
      if (this.inCheck()) san += this.legalMoves().length ? '+' : '#';
      this.unmake();
      return san;
    }
  }

  const Chess = {
    WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
    FLAG_DOUBLE, FLAG_EP, FLAG_CASTLE, START_FEN, PIECE_CHARS,
    N_DIRS, B_DIRS, R_DIRS, K_DIRS,
    mFrom, mTo, mPromo, mFlag, mk, sqName, sqFromName,
    Position,
  };
  root.Chess = Chess;
})(typeof self !== 'undefined' ? self : this);
