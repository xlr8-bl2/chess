# Chess Simulator

A browser chess game. Play against the computer, **switch sides at any point** (the computer takes over the color you leave), and **change difficulty at any time**, from Beginner to Grandmaster.

## Features
- Click-to-move or drag-and-drop, with legal-move dots, last-move and check highlights
- Full rules: castling, en passant, promotion (with a piece picker), checkmate, stalemate, threefold repetition, fifty-move rule, insufficient material
- Choose **You** or **Computer** for each side: play both sides yourself, or let the computer take one (or both)
- **Computer move** button: the computer plays one move for the side to move, only when you ask
- **Switch sides** mid-game swaps who plays White and Black
- **Set up any position**: drag pieces from a palette, move or remove them, pick the side to move and castling rights, or paste a FEN, then press Start game
- **8 difficulty levels**: Beginner, Novice, Casual, Club player, Advanced, Expert, Master, Grandmaster. Changing the level while the computer is thinking restarts its search at the new strength
- Undo (takes back to your last move), hint, flip board, move list, captured pieces
- Remembers your last side and difficulty

## Engines
- **Levels 1–4** use the built-in JavaScript engine (`js/engine.js`): alpha-beta search with a transposition table, quiescence search, null-move pruning and late-move reductions. The lower levels deliberately add randomness and occasional blunders.
- **Levels 5–8** use **Stockfish 10** (`engine/stockfish.js`) with its Skill Level setting; Grandmaster is full strength. If Stockfish can't load, these levels fall back to the built-in engine with longer thinking time.

Both engines run in Web Workers, so the page stays responsive.

## Hosting
It's a plain static site with no build step. Every path is relative, so it works from any URL.

**GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → pick the branch and `/ (root)` → Save.

**Vercel:** import the repo with the "Other" framework preset and leave the build command empty.

**Locally:** serve the folder (Web Workers don't run from `file://`):
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## Credits
- Stockfish 10 compiled to JavaScript by Niklas Fiekas ([stockfish.js](https://github.com/niklasf/stockfish.js)), GPLv3
- Piece images: "cburnett" set by Colin M.L. Burnett, via [lichess](https://github.com/lichess-org/lila), GPLv2+
