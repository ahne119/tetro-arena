/* =========================================================
   TETRO ARENA - Solos, AI 2v2 Team Battle & Supabase Online
   ========================================================= */

// [중요] 깃허브 배포 시 아래에 본인 Supabase Project URL과 Key를 입력해 올리면
// 사이트를 방문하는 모든 사람이 별도 설정 없이 바로 온라인 기능을 이용할 수 있습니다.
const DEFAULT_SUPABASE_CONFIG = {
  url: "", // 예: "https://gffpfxbogevyecydmdim.supabase.co/rest/v1/"
  key: ""  // 예: "sb_publishable_K5cV3hYlPLNGT4_wqJ4_IA_HZnmB5GO" 또는 anon public key
};

const COLS = 10;
const ROWS = 20;
const BLOCK_SIZE = 30;

const COLORS = {
  0: null,
  1: '#00f0f0', // I
  2: '#3b82f6', // J
  3: '#f97316', // L
  4: '#eab308', // O
  5: '#22c55e', // S
  6: '#a855f7', // T
  7: '#ef4444', // Z
  8: '#64748b'  // 방해 블록
};

const PIECE_KEYS = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
const SHAPES = {
  I: [[0,0,0,0], [1,1,1,1], [0,0,0,0], [0,0,0,0]],
  J: [[2,0,0], [2,2,2], [0,0,0]],
  L: [[0,0,3], [3,3,3], [0,0,0]],
  O: [[4,4], [4,4]],
  S: [[0,5,5], [5,5,0], [0,0,0]],
  T: [[0,6,0], [6,6,6], [0,0,0]],
  Z: [[7,7,0], [0,7,7], [0,0,0]]
};

function cloneMatrix(m) {
  return m.map(row => [...row]);
}

function rotateMatrix(matrix, dir = 1) {
  const N = matrix.length;
  const res = Array.from({ length: N }, () => Array(N).fill(0));
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (dir === 1) res[c][N - 1 - r] = matrix[r][c];
      else res[N - 1 - c][r] = matrix[r][c];
    }
  }
  return res;
}

/* ----------------- 효과음 (Web Audio API) ----------------- */
const Sound = {
  enabled: true,
  ctx: null,
  init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },
  beep(freq, duration = 0.06, type = 'square', vol = 0.05) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  },
  move() { this.beep(220, 0.03, 'triangle', 0.03); },
  rotate() { this.beep(360, 0.05, 'sine', 0.04); },
  drop() { this.beep(130, 0.08, 'square', 0.05); },
  clear(lines) {
    const base = 440 + lines * 110;
    this.beep(base, 0.12, 'triangle', 0.08);
    setTimeout(() => this.beep(base * 1.25, 0.14, 'triangle', 0.07), 70);
  },
  attack() { this.beep(180, 0.18, 'sawtooth', 0.06); },
  gameover() {
    this.beep(260, 0.18, 'sawtooth', 0.07);
    setTimeout(() => this.beep(170, 0.3, 'sawtooth', 0.07), 160);
  }
};

/* ----------------- 게임 엔진 클래스 ----------------- */
class TetroEngine {
  constructor(options = {}) {
    this.id = options.id || 'player';
    this.name = options.name || '플레이어';
    this.team = options.team || 'RED';
    this.isAI = Boolean(options.isAI);
    this.onAttack = options.onAttack || null;
    this.onStateChange = options.onStateChange || null;
    this.onGameOver = options.onGameOver || null;
    this.reset();
  }

  reset() {
    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    this.bag = [];
    this.queue = [];
    this.holdKey = null;
    this.canHold = true;
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.combo = 0;
    this.incomingGarbage = 0;
    this.alive = true;
    this.dropAcc = 0;
    this.aiTarget = null;
    this.aiStepAcc = 0;

    for (let i = 0; i < 4; i++) this.queue.push(this.drawFromBag());
    this.spawnPiece();
  }

  drawFromBag() {
    if (this.bag.length === 0) {
      this.bag = [...PIECE_KEYS];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }

  spawnPiece(keyOverride = null) {
    const key = keyOverride || this.queue.shift();
    if (!keyOverride) this.queue.push(this.drawFromBag());
    const matrix = cloneMatrix(SHAPES[key]);
    const x = Math.floor((COLS - matrix[0].length) / 2);
    const y = key === 'I' ? -1 : 0;

    this.current = { key, matrix, x, y };
    this.canHold = true;

    if (this.collides(matrix, x, y)) {
      this.alive = false;
      if (this.onGameOver) this.onGameOver(this);
    } else if (this.isAI) {
      this.aiTarget = this.computeBestAIMove();
    }
  }

  collides(matrix, offsetX, offsetY, boardRef = this.board) {
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix[r].length; c++) {
        if (!matrix[r][c]) continue;
        const nx = offsetX + c;
        const ny = offsetY + r;
        if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
        if (ny >= 0 && boardRef[ny][nx] !== 0) return true;
      }
    }
    return false;
  }

  move(dx, dy) {
    if (!this.alive) return false;
    if (!this.collides(this.current.matrix, this.current.x + dx, this.current.y + dy)) {
      this.current.x += dx;
      this.current.y += dy;
      return true;
    }
    return false;
  }

  rotate(dir = 1) {
    if (!this.alive) return false;
    const rotated = rotateMatrix(this.current.matrix, dir);
    const kicks = [0, -1, 1, -2, 2];
    for (const kick of kicks) {
      if (!this.collides(rotated, this.current.x + kick, this.current.y)) {
        this.current.matrix = rotated;
        this.current.x += kick;
        return true;
      }
    }
    return false;
  }

  hold() {
    if (!this.alive || !this.canHold) return false;
    const currentKey = this.current.key;
    if (this.holdKey) {
      const swap = this.holdKey;
      this.holdKey = currentKey;
      this.spawnPiece(swap);
    } else {
      this.holdKey = currentKey;
      this.spawnPiece();
    }
    this.canHold = false;
    return true;
  }

  getGhostY() {
    let y = this.current.y;
    while (!this.collides(this.current.matrix, this.current.x, y + 1)) {
      y++;
    }
    return y;
  }

  hardDrop() {
    if (!this.alive) return;
    let dist = 0;
    while (this.move(0, 1)) dist++;
    this.score += dist * 2;
    this.lockPiece();
  }

  lockPiece() {
    const { matrix, x, y } = this.current;
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix[r].length; c++) {
        if (!matrix[r][c]) continue;
        const by = y + r;
        const bx = x + c;
        if (by < 0) {
          this.alive = false;
          if (this.onGameOver) this.onGameOver(this);
          return;
        }
        this.board[by][bx] = matrix[r][c];
      }
    }

    const cleared = this.clearLines();
    if (cleared > 0) {
      this.combo++;
      const lineScores = [0, 100, 300, 500, 800];
      this.score += (lineScores[cleared] || 800) * this.level + (this.combo - 1) * 50;
      this.lines += cleared;
      this.level = Math.floor(this.lines / 10) + 1;

      let attack = cleared === 2 ? 1 : cleared === 3 ? 2 : cleared >= 4 ? 4 : 0;
      if (this.combo >= 2 && cleared >= 1) attack += Math.min(3, this.combo - 1);

      if (this.incomingGarbage > 0 && attack > 0) {
        const cancel = Math.min(this.incomingGarbage, attack);
        this.incomingGarbage -= cancel;
        attack -= cancel;
      }

      if (attack > 0 && this.onAttack) {
        this.onAttack(this, attack);
      }

      if (!this.isAI) Sound.clear(cleared);
    } else {
      this.combo = 0;
      if (this.incomingGarbage > 0) {
        this.applyGarbage();
      }
      if (!this.isAI) Sound.drop();
    }

    this.spawnPiece();
    if (this.onStateChange) this.onStateChange(this);
  }

  clearLines() {
    let count = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.board[r].every(cell => cell !== 0)) {
        this.board.splice(r, 1);
        this.board.unshift(Array(COLS).fill(0));
        count++;
        r++;
      }
    }
    return count;
  }

  applyGarbage() {
    const amount = Math.min(this.incomingGarbage, 8);
    this.incomingGarbage -= amount;
    const hole = Math.floor(Math.random() * COLS);

    for (let i = 0; i < amount; i++) {
      const topRow = this.board.shift();
      if (topRow.some(cell => cell !== 0)) {
        this.alive = false;
      }
      const gRow = Array(COLS).fill(8);
      gRow[hole] = 0;
      this.board.push(gRow);
    }

    if (!this.alive && this.onGameOver) {
      this.onGameOver(this);
    }
  }

  receiveGarbage(amount) {
    if (!this.alive) return;
    this.incomingGarbage = Math.min(16, this.incomingGarbage + amount);
    if (!this.isAI) Sound.attack();
  }

  update(dt) {
    if (!this.alive) return;

    if (this.isAI) {
      this.aiStepAcc += dt;
      if (this.aiStepAcc >= 140) {
        this.aiStepAcc = 0;
        this.stepAI();
      }
    }

    const dropInterval = this.isAI
      ? 650
      : Math.max(90, 800 - (this.level - 1) * 70);

    this.dropAcc += dt;
    if (this.dropAcc >= dropInterval) {
      this.dropAcc = 0;
      if (!this.move(0, 1)) {
        this.lockPiece();
      }
    }
  }

  computeBestAIMove() {
    let bestScore = -Infinity;
    let best = { rot: 0, x: this.current.x };
    let mat = cloneMatrix(this.current.matrix);

    for (let rot = 0; rot < 4; rot++) {
      for (let x = -2; x < COLS; x++) {
        if (this.collides(mat, x, this.current.y)) continue;
        let y = this.current.y;
        while (!this.collides(mat, x, y + 1)) y++;

        const testBoard = this.board.map(r => [...r]);
        let valid = true;
        for (let r = 0; r < mat.length; r++) {
          for (let c = 0; c < mat[r].length; c++) {
            if (mat[r][c]) {
              if (y + r < 0) { valid = false; break; }
              testBoard[y + r][x + c] = mat[r][c];
            }
          }
          if (!valid) break;
        }
        if (!valid) continue;

        const evalScore = this.evaluateBoard(testBoard);
        if (evalScore > bestScore) {
          bestScore = evalScore;
          best = { rot, x };
        }
      }
      mat = rotateMatrix(mat, 1);
    }
    return best;
  }

  evaluateBoard(b) {
    let cleared = 0;
    for (let r = 0; r < ROWS; r++) {
      if (b[r].every(v => v !== 0)) cleared++;
    }
    let aggHeight = 0;
    let holes = 0;
    let bumpiness = 0;
    const heights = Array(COLS).fill(0);

    for (let c = 0; c < COLS; c++) {
      let blockSeen = false;
      for (let r = 0; r < ROWS; r++) {
        if (b[r][c] !== 0) {
          if (!blockSeen) {
            heights[c] = ROWS - r;
            aggHeight += heights[c];
            blockSeen = true;
          }
        } else if (blockSeen) {
          holes++;
        }
      }
    }
    for (let c = 0; c < COLS - 1; c++) {
      bumpiness += Math.abs(heights[c] - heights[c + 1]);
    }
    return cleared * 3.5 - aggHeight * 0.52 - holes * 3.8 - bumpiness * 0.25;
  }

  stepAI() {
    if (!this.aiTarget) return;
    if (this.aiTarget.rot > 0) {
      if (this.rotate(1)) this.aiTarget.rot--;
      else this.aiTarget.rot = 0;
      return;
    }
    if (this.current.x < this.aiTarget.x) {
      this.move(1, 0);
      return;
    }
    if (this.current.x > this.aiTarget.x) {
      this.move(-1, 0);
      return;
    }
    this.hardDrop();
  }

  encodeBoard() {
    const snap = this.board.map(r => [...r]);
    if (this.alive && this.current) {
      const { matrix, x, y } = this.current;
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          if (matrix[r][c] && y + r >= 0 && y + r < ROWS && x + c >= 0 && x + c < COLS) {
            snap[y + r][x + c] = matrix[r][c];
          }
        }
      }
    }
    return snap.flat().join('');
  }
}

/* ----------------- 전역 앱 상태 & Supabase 연동 ----------------- */
const App = {
  mode: 'solo',
  isRunning: false,
  isPaused: false,
  lastTime: 0,
  rafId: null,

  player: null,
  aiEngines: [],
  remotePlayers: {},

  sbReady: false,
  sb: null,
  lobbyChannel: null,
  roomChannel: null,

  myId: 'p_' + Math.random().toString(36).slice(2, 9),
  myTeam: 'RED',
  myJoinedAt: 0,
  currentRoom: null,
  roomStatus: 'waiting',
  roomHostId: null,
  lastSyncTs: 0,

  init() {
    this.cacheDOM();
    this.bindEvents();
    this.loadSavedProfile();
    this.initSupabase();

    this.player = new TetroEngine({
      id: this.myId,
      name: this.getNickname(),
      team: 'RED',
      onAttack: (eng, amount) => this.handlePlayerAttack(eng, amount),
      onStateChange: () => this.syncOnlineState(),
      onGameOver: () => this.handlePlayerGameOver()
    });

    this.renderAll();
    this.loadRankings();
    this.addChatMessage('시스템', 'TETRO ARENA에 오신 것을 환영합니다! 모드를 선택하고 게임을 시작하세요.', true);
  },

  cacheDOM() {
    this.gameCanvas = document.getElementById('gameCanvas');
    this.ctx = this.gameCanvas.getContext('2d');
    this.holdCanvas = document.getElementById('holdCanvas');
    this.holdCtx = this.holdCanvas.getContext('2d');
    this.nextCanvas = document.getElementById('nextCanvas');
    this.nextCtx = this.nextCanvas.getContext('2d');

    this.overlay = document.getElementById('boardOverlay');
    this.overlayTitle = document.getElementById('overlayTitle');
    this.overlaySub = document.getElementById('overlaySub');
    this.startGameBtn = document.getElementById('startGameBtn');

    this.scoreEl = document.getElementById('scoreVal');
    this.linesEl = document.getElementById('linesVal');
    this.levelEl = document.getElementById('levelVal');
    this.comboEl = document.getElementById('comboVal');
    this.garbageBarEl = document.getElementById('garbageBar');
    this.garbageCountEl = document.getElementById('garbageCount');

    this.nicknameInput = document.getElementById('nicknameInput');
    this.connBadge = document.getElementById('connBadge');
    this.onlineLobbyCard = document.getElementById('onlineLobbyCard');
    this.arenaBoardsCard = document.getElementById('arenaBoardsCard');
    this.opponentsGrid = document.getElementById('opponentsGrid');

    this.chatMessages = document.getElementById('chatMessages');
    this.chatForm = document.getElementById('chatForm');
    this.chatInput = document.getElementById('chatInput');
    this.rankList = document.getElementById('rankList');
    this.rankScopeLabel = document.getElementById('rankScopeLabel');
  },

  bindEvents() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.isRunning && !confirm('진행 중인 게임을 종료하고 모드를 바꿀까요?')) return;
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.switchMode(btn.dataset.mode);
      });
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab + 'Tab').classList.add('active');
        if (btn.dataset.tab === 'rank') this.loadRankings();
      });
    });

    this.startGameBtn.addEventListener('click', () => {
      if (this.mode === 'online') {
        alert('온라인 모드에서는 왼쪽 "방 만들기" 또는 방에 입장한 후 시작 버튼을 눌러주세요!');
        return;
      }
      this.startMatch();
    });

    document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());
    document.getElementById('restartBtn').addEventListener('click', () => {
      if (this.mode === 'online') return;
      this.startMatch();
    });

    document.getElementById('soundToggleBtn').addEventListener('click', (e) => {
      Sound.enabled = !Sound.enabled;
      e.target.textContent = Sound.enabled ? '🔊 소리 ON' : '🔇 소리 OFF';
    });

    this.nicknameInput.addEventListener('change', () => {
      localStorage.setItem('tetro_nickname', this.getNickname());
      if (this.player) this.player.name = this.getNickname();
      if (this.roomChannel && this.currentRoom) this.trackRoomPresence();
    });

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.code === 'KeyP') {
        this.togglePause();
        return;
      }
      if (!this.isRunning || this.isPaused || !this.player?.alive) return;

      switch (e.code) {
        case 'ArrowLeft':
          e.preventDefault();
          if (this.player.move(-1, 0)) Sound.move();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (this.player.move(1, 0)) Sound.move();
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (this.player.move(0, 1)) this.player.score += 1;
          break;
        case 'ArrowUp':
        case 'KeyX':
          e.preventDefault();
          if (this.player.rotate(1)) Sound.rotate();
          break;
        case 'KeyZ':
          e.preventDefault();
          if (this.player.rotate(-1)) Sound.rotate();
          break;
        case 'Space':
          e.preventDefault();
          this.player.hardDrop();
          break;
        case 'KeyC':
        case 'ShiftLeft':
        case 'ShiftRight':
          e.preventDefault();
          if (this.player.hold()) Sound.rotate();
          break;
      }
      this.renderPlayerArea();
    });

    document.querySelectorAll('.touch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.isRunning || this.isPaused || !this.player?.alive) return;
        const act = btn.dataset.act;
        if (act === 'left' && this.player.move(-1, 0)) Sound.move();
        if (act === 'right' && this.player.move(1, 0)) Sound.move();
        if (act === 'down' && this.player.move(0, 1)) this.player.score += 1;
        if (act === 'rotate' && this.player.rotate(1)) Sound.rotate();
        if (act === 'hard') this.player.hardDrop();
        if (act === 'hold' && this.player.hold()) Sound.rotate();
        this.renderPlayerArea();
      });
    });

    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      if (!text) return;
      this.chatInput.value = '';
      this.sendChat(text);
    });

    document.getElementById('refreshRankBtn').addEventListener('click', () => this.loadRankings());

    // Supabase 설정 모달
    const modal = document.getElementById('configModal');
    document.getElementById('openConfigBtn').addEventListener('click', () => {
      const saved = JSON.parse(localStorage.getItem('tetro_supabase_cfg') || '{}');
      document.getElementById('supabaseUrlInput').value = saved.url || DEFAULT_SUPABASE_CONFIG.url || '';
      document.getElementById('supabaseKeyInput').value = saved.key || DEFAULT_SUPABASE_CONFIG.key || '';
      modal.classList.remove('hidden');
    });
    document.getElementById('closeConfigBtn').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('saveConfigBtn').addEventListener('click', () => {
      const url = document.getElementById('supabaseUrlInput').value.trim();
      const key = document.getElementById('supabaseKeyInput').value.trim();
      if (!url.startsWith('https://') || !key) {
        alert('올바른 Project URL(https://...)과 Key를 입력해주세요.');
        return;
      }
      localStorage.setItem('tetro_supabase_cfg', JSON.stringify({ url, key }));
      location.reload();
    });
    document.getElementById('resetConfigBtn').addEventListener('click', () => {
      localStorage.removeItem('tetro_supabase_cfg');
      location.reload();
    });

    // 온라인 방 버튼
    document.getElementById('createRoomBtn').addEventListener('click', () => this.createRoom());
    document.getElementById('joinRoomBtn').addEventListener('click', () => {
      const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
      if (code) this.joinRoom(code);
    });
    document.getElementById('leaveRoomBtn').addEventListener('click', () => this.leaveRoom());
    document.getElementById('pickRedBtn').addEventListener('click', () => this.setOnlineTeam('RED'));
    document.getElementById('pickBlueBtn').addEventListener('click', () => this.setOnlineTeam('BLUE'));
    document.getElementById('startOnlineMatchBtn').addEventListener('click', () => this.requestOnlineStart());
  },

  loadSavedProfile() {
    const savedName = localStorage.getItem('tetro_nickname');
    this.nicknameInput.value = savedName || '플레이어' + Math.floor(100 + Math.random() * 900);
  },

  getNickname() {
    return (this.nicknameInput.value || '익명').trim().slice(0, 12);
  },

  /* ----------------- 모드 전환 & 매치 시작 ----------------- */
  switchMode(mode) {
    this.stopLoop();
    if (this.currentRoom) this.leaveRoom();
    this.mode = mode;

    const descEl = document.getElementById('modeDesc');
    this.onlineLobbyCard.classList.add('hidden');
    this.arenaBoardsCard.classList.add('hidden');

    if (mode === 'solo') {
      descEl.textContent = '혼자 플레이하며 최고 기록을 세우고 명예의 전당에 도전하세요.';
      this.showOverlay('SOLO RANKING', '시작 버튼을 눌러 최고 점수에 도전하세요!', true);
    } else if (mode === 'ai_team') {
      descEl.textContent = '나 + AI 아군(RED) vs AI 적 2명(BLUE)! 2줄 이상 지우면 적 팀에게 방해 줄을 보냅니다.';
      this.arenaBoardsCard.classList.remove('hidden');
      this.showOverlay('AI 2:2 TEAM BATTLE', 'AI 팀과 함께 2:2 팀전을 연습해보세요!', true);
    } else if (mode === 'online') {
      descEl.textContent = '친구들과 방 코드를 공유해 실시간 개인전 또는 팀전(RED vs BLUE)을 즐기세요.';
      this.onlineLobbyCard.classList.remove('hidden');
      this.arenaBoardsCard.classList.remove('hidden');
      document.getElementById('onlineWarning').classList.toggle('hidden', this.sbReady);
      this.showOverlay('ONLINE ARENA', '왼쪽에서 방을 만들거나 입장하세요.', false);
    }
  },

  startMatch() {
    this.stopLoop();
    this.isPaused = false;
    this.isRunning = true;
    this.overlay.classList.add('hidden');

    this.player.name = this.getNickname();
    this.player.team = this.mode === 'online' ? this.myTeam : 'RED';
    this.player.reset();

    this.aiEngines = [];
    if (this.mode === 'ai_team') {
      this.aiEngines = [
        new TetroEngine({
          id: 'ai_ally', name: '🤖 AI-아군', team: 'RED', isAI: true,
          onAttack: (eng, amt) => this.handleAIAttack(eng, amt),
          onGameOver: () => this.checkTeamBattleEnd()
        }),
        new TetroEngine({
          id: 'ai_enemy1', name: '👾 AI-적1', team: 'BLUE', isAI: true,
          onAttack: (eng, amt) => this.handleAIAttack(eng, amt),
          onGameOver: () => this.checkTeamBattleEnd()
        }),
        new TetroEngine({
          id: 'ai_enemy2', name: '👾 AI-적2', team: 'BLUE', isAI: true,
          onAttack: (eng, amt) => this.handleAIAttack(eng, amt),
          onGameOver: () => this.checkTeamBattleEnd()
        })
      ];
      this.buildOpponentCards(this.aiEngines);
    }

    this.lastTime = performance.now();
    this.loop(this.lastTime);
  },

  stopLoop() {
    this.isRunning = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  },

  togglePause() {
    if (!this.isRunning || this.mode === 'online') return;
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      this.showOverlay('PAUSED', '계속하려면 P 키 또는 다시 시작을 누르세요.', false);
    } else {
      this.overlay.classList.add('hidden');
      this.lastTime = performance.now();
    }
  },

  loop(now) {
    if (!this.isRunning) return;
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;

    if (!this.isPaused) {
      this.player.update(dt);
      this.aiEngines.forEach(ai => ai.update(dt));
      if (this.mode === 'online' && now - this.lastSyncTs > 320) {
        this.lastSyncTs = now;
        this.syncOnlineState();
      }
      this.renderAll();
    }
    this.rafId = requestAnimationFrame((t) => this.loop(t));
  },

  /* ----------------- 공격 & 승패 처리 ----------------- */
  handlePlayerAttack(eng, amount) {
    if (this.mode === 'ai_team') {
      this.aiEngines.filter(a => a.team !== eng.team && a.alive).forEach(t => t.receiveGarbage(amount));
      this.addChatMessage('전투', `${eng.name}님이 BLUE 팀에 ${amount}줄 공격!`, true);
    } else if (this.mode === 'online' && this.roomChannel) {
      const oppTeam = this.myTeam === 'RED' ? 'BLUE' : 'RED';
      this.roomChannel.send({
        type: 'broadcast',
        event: 'attack',
        payload: {
          fromId: this.myId,
          fromName: this.getNickname(),
          targetTeam: oppTeam,
          amount
        }
      });
    }
  },

  handleAIAttack(ai, amount) {
    const targets = [this.player, ...this.aiEngines].filter(e => e.team !== ai.team && e.alive);
    targets.forEach(t => t.receiveGarbage(amount));
  },

  handlePlayerGameOver() {
    Sound.gameover();
    if (this.mode === 'solo') {
      this.stopLoop();
      this.saveScore(this.player.score, this.player.lines, this.player.level);
      this.showOverlay('GAME OVER', `최종 점수: ${this.player.score.toLocaleString()}점`, true, '다시 도전');
    } else if (this.mode === 'ai_team') {
      this.checkTeamBattleEnd();
    } else if (this.mode === 'online') {
      this.syncOnlineState();
      this.showOverlay('탈락!', '다른 팀원의 경기가 끝날 때까지 관전합니다.', false);
      this.checkOnlineWin();
    }
  },

  checkTeamBattleEnd() {
    const all = [this.player, ...this.aiEngines];
    const redAlive = all.some(e => e.team === 'RED' && e.alive);
    const blueAlive = all.some(e => e.team === 'BLUE' && e.alive);

    if (!redAlive || !blueAlive) {
      this.stopLoop();
      const win = redAlive && !blueAlive;
      this.showOverlay(win ? 'VICTORY! 🎉' : 'DEFEAT...', win ? 'RED 팀(내 팀)이 승리했습니다!' : 'BLUE 팀이 승리했습니다.', true, '다시 대결');
    } else if (!this.player.alive) {
      this.showOverlay('탈락 (관전 중)', '아군 AI가 끝까지 싸우고 있습니다...', false);
    }
  },

  showOverlay(title, sub, showBtn = true, btnText = '게임 시작') {
    this.overlayTitle.textContent = title;
    this.overlaySub.textContent = sub;
    this.startGameBtn.textContent = btnText;
    this.startGameBtn.classList.toggle('hidden', !showBtn);
    this.overlay.classList.remove('hidden');
  },

  /* ----------------- 캔버스 렌더링 ----------------- */
  renderAll() {
    this.renderPlayerArea();
    if (this.mode === 'ai_team') {
      this.aiEngines.forEach(ai => {
        this.renderMiniBoard(ai.id, ai.encodeBoard(), ai.alive, ai.score);
      });
    }
  },

  renderPlayerArea() {
    const ctx = this.ctx;
    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, this.gameCanvas.width, this.gameCanvas.height);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.strokeRect(c * BLOCK_SIZE, r * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
      }
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (this.player.board[r][c]) {
          this.drawBlock(ctx, c, r, COLORS[this.player.board[r][c]], BLOCK_SIZE);
        }
      }
    }

    if (this.player.alive && this.player.current) {
      const { matrix, x, y } = this.player.current;
      const ghostY = this.player.getGhostY();
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          if (!matrix[r][c]) continue;
          if (ghostY + r >= 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect((x + c) * BLOCK_SIZE + 1, (ghostY + r) * BLOCK_SIZE + 1, BLOCK_SIZE - 2, BLOCK_SIZE - 2);
          }
          if (y + r >= 0) {
            this.drawBlock(ctx, x + c, y + r, COLORS[matrix[r][c]], BLOCK_SIZE);
          }
        }
      }
    }

    this.drawPreview(this.holdCtx, this.holdCanvas, this.player.holdKey ? [this.player.holdKey] : []);
    this.drawPreview(this.nextCtx, this.nextCanvas, this.player.queue.slice(0, 3));

    this.scoreEl.textContent = this.player.score.toLocaleString();
    this.linesEl.textContent = this.player.lines;
    this.levelEl.textContent = this.player.level;
    this.comboEl.textContent = this.player.combo;
    this.garbageCountEl.textContent = `${this.player.incomingGarbage}줄`;
    this.garbageBarEl.style.height = `${Math.min(100, (this.player.incomingGarbage / 12) * 100)}%`;
  },

  drawBlock(ctx, gx, gy, color, size) {
    ctx.fillStyle = color;
    ctx.fillRect(gx * size + 1, gy * size + 1, size - 2, size - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(gx * size + 2, gy * size + 2, size - 4, 4);
  },

  drawPreview(ctx, canvas, keys) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cell = 18;
    keys.forEach((key, idx) => {
      const m = SHAPES[key];
      const offsetX = (canvas.width - m[0].length * cell) / 2;
      const offsetY = idx * 75 + 14;
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m[r].length; c++) {
          if (m[r][c]) {
            ctx.fillStyle = COLORS[m[r][c]];
            ctx.fillRect(offsetX + c * cell + 1, offsetY + r * cell + 1, cell - 2, cell - 2);
          }
        }
      }
    });
  },

  buildOpponentCards(list) {
    this.opponentsGrid.innerHTML = '';
    list.forEach(item => {
      const card = document.createElement('div');
      card.className = `opp-card team-${item.team}`;
      card.id = `opp-card-${item.id}`;

      const nameEl = document.createElement('div');
      nameEl.className = 'opp-name';
      nameEl.textContent = `[${item.team}] ${item.name}`;

      const canvas = document.createElement('canvas');
      canvas.className = 'opp-canvas';
      canvas.width = 100;
      canvas.height = 200;
      canvas.id = `opp-canvas-${item.id}`;

      const scoreEl = document.createElement('div');
      scoreEl.className = 'muted-text';
      scoreEl.id = `opp-score-${item.id}`;
      scoreEl.textContent = '0점';

      card.append(nameEl, canvas, scoreEl);
      this.opponentsGrid.appendChild(card);
    });
  },

  renderMiniBoard(id, encoded, alive, score) {
    const canvas = document.getElementById(`opp-canvas-${id}`);
    const card = document.getElementById(`opp-card-${id}`);
    const scoreEl = document.getElementById(`opp-score-${id}`);
    if (!canvas) return;

    card.classList.toggle('dead', !alive);
    scoreEl.textContent = alive ? `${Number(score || 0).toLocaleString()}점` : '탈락';

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, 100, 200);
    if (!encoded || encoded.length < 200) return;

    for (let i = 0; i < 200; i++) {
      const v = Number(encoded[i]);
      if (v > 0) {
        const r = Math.floor(i / COLS);
        const c = i % COLS;
        ctx.fillStyle = COLORS[v] || '#94a3b8';
        ctx.fillRect(c * 10 + 0.5, r * 10 + 0.5, 9, 9);
      }
    }
  },

  /* ----------------- 랭킹 & 채팅 (로컬 + Supabase) ----------------- */
  async initSupabase() {
    let cfg = DEFAULT_SUPABASE_CONFIG;
    const saved = localStorage.getItem('tetro_supabase_cfg');
    if (saved) {
      try { cfg = JSON.parse(saved); } catch (_) {}
    }

    if (!window.supabase || !cfg.url || !cfg.key) {
      this.sbReady = false;
      return;
    }

    try {
      this.sb = window.supabase.createClient(cfg.url, cfg.key);
      this.sbReady = true;
      this.connBadge.textContent = '온라인 연결됨';
      this.connBadge.className = 'badge badge-online';
      this.rankScopeLabel.textContent = '글로벌 실시간 Top 10';

      await this.loadRecentGlobalChat();
      this.connectLobbyChannel();
      this.loadRankings();
    } catch (e) {
      console.error('Supabase init failed:', e);
    }
  },

  async saveScore(score, lines, level) {
    if (score <= 0) return;
    const entry = { name: this.getNickname(), score, lines, level };

    if (this.sbReady) {
      await this.sb.from('leaderboard').insert([entry]);
    }
    const local = JSON.parse(localStorage.getItem('tetro_ranks') || '[]');
    local.push({ ...entry, ts: Date.now() });
    local.sort((a, b) => b.score - a.score);
    localStorage.setItem('tetro_ranks', JSON.stringify(local.slice(0, 10)));
    this.loadRankings();
  },

  async loadRankings() {
    if (this.sbReady) {
      const { data, error } = await this.sb
        .from('leaderboard')
        .select('name, score, lines, level')
        .order('score', { ascending: false })
        .limit(10);
      if (!error && data) {
        this.renderRankList(data);
        return;
      }
    }
    const local = JSON.parse(localStorage.getItem('tetro_ranks') || '[]');
    this.renderRankList(local);
  },

  renderRankList(rows) {
    this.rankList.innerHTML = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'muted-text';
      li.textContent = '아직 등록된 기록이 없습니다.';
      this.rankList.appendChild(li);
      return;
    }
    rows.forEach((r, idx) => {
      const li = document.createElement('li');
      li.className = 'rank-item';
      const left = document.createElement('span');
      left.textContent = `${idx + 1}위 · ${r.name} (Lv.${r.level || 1})`;
      const right = document.createElement('strong');
      right.textContent = `${Number(r.score).toLocaleString()}점`;
      li.append(left, right);
      this.rankList.appendChild(li);
    });
  },

  async loadRecentGlobalChat() {
    if (!this.sbReady) return;
    const { data, error } = await this.sb
      .from('global_chat')
      .select('sender, text')
      .order('created_at', { ascending: false })
      .limit(20);
    if (!error && data) {
      data.reverse().forEach(m => this.addChatMessage(m.sender, m.text, false));
    }
  },

  async sendChat(text) {
    const sender = this.getNickname();
    if (this.sbReady) {
      if (this.currentRoom && this.roomChannel) {
        this.roomChannel.send({ type: 'broadcast', event: 'chat', payload: { sender, text } });
      } else if (this.lobbyChannel) {
        this.lobbyChannel.send({ type: 'broadcast', event: 'chat', payload: { sender, text } });
        this.sb.from('global_chat').insert([{ sender, text }]).then(() => {});
      }
    } else {
      this.addChatMessage(sender, text, false);
    }
  },

  addChatMessage(sender, text, isSystem = false) {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (isSystem ? ' system' : '');
    const s = document.createElement('span');
    s.className = 'sender';
    s.textContent = `[${sender}]`;
    const t = document.createElement('span');
    t.textContent = text;
    div.append(s, t);
    this.chatMessages.appendChild(div);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  },

  /* ----------------- Supabase Realtime 로비 & 방 관리 ----------------- */
  connectLobbyChannel() {
    this.lobbyChannel = this.sb.channel('tetro:lobby', {
      config: { broadcast: { self: true }, presence: { key: this.myId } }
    });

    this.lobbyChannel
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        if (this.currentRoom) return;
        this.addChatMessage(payload.sender, payload.text, false);
      })
      .on('presence', { event: 'sync' }, () => {
        this.renderRoomListFromPresence();
      })
      .subscribe();
  },

  renderRoomListFromPresence() {
    if (!this.lobbyChannel) return;
    const state = this.lobbyChannel.presenceState();
    const roomsMap = {};

    Object.values(state).forEach(entries => {
      entries.forEach(p => {
        if (!p.roomCode) return;
        if (!roomsMap[p.roomCode]) {
          roomsMap[p.roomCode] = { count: 0, status: 'waiting' };
        }
        roomsMap[p.roomCode].count++;
        if (p.status === 'playing') roomsMap[p.roomCode].status = 'playing';
      });
    });

    const ul = document.getElementById('roomList');
    ul.innerHTML = '';
    const codes = Object.keys(roomsMap);
    if (codes.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted-text';
      li.textContent = '현재 열린 방이 없습니다.';
      ul.appendChild(li);
      return;
    }

    codes.forEach(code => {
      const infoData = roomsMap[code];
      const li = document.createElement('li');
      li.className = 'room-item';
      const info = document.createElement('span');
      info.textContent = `방 [${code}] · ${infoData.count}명 · ${infoData.status === 'playing' ? '게임 중' : '대기 중'}`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-xs';
      btn.textContent = '참여';
      btn.onclick = () => this.joinRoom(code);
      li.append(info, btn);
      ul.appendChild(li);
    });
  },

  createRoom() {
    if (!this.sbReady) return alert('먼저 오른쪽 상단 [⚙️ 온라인 설정]에서 Supabase를 연결해주세요!');
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.joinRoom(code);
  },

  joinRoom(code) {
    if (!this.sbReady) return alert('Supabase 연결이 필요합니다.');
    if (this.currentRoom) this.leaveRoom();

    this.currentRoom = code;
    this.roomStatus = 'waiting';
    this.myJoinedAt = Date.now();
    this.remotePlayers = {};

    document.getElementById('roomJoinArea').classList.add('hidden');
    document.getElementById('roomInsideArea').classList.remove('hidden');
    document.getElementById('currentRoomCode').textContent = code;
    this.chatMessages.innerHTML = '';
    this.addChatMessage('시스템', `[${code}] 방에 입장했습니다.`, true);

    this.roomChannel = this.sb.channel(`tetro:room:${code}`, {
      config: { broadcast: { self: true }, presence: { key: this.myId } }
    });

    this.roomChannel
      .on('presence', { event: 'sync' }, () => this.syncRoomPresence())
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        this.addChatMessage(payload.sender, payload.text, false);
      })
      .on('broadcast', { event: 'start' }, () => {
        this.roomStatus = 'playing';
        if (this.lobbyChannel) {
          this.lobbyChannel.track({ roomCode: this.currentRoom, status: 'playing' });
        }
        Object.values(this.remotePlayers).forEach(p => {
          p.alive = true;
          p.score = 0;
          p.board = '0'.repeat(200);
        });
        document.getElementById('startOnlineMatchBtn').classList.add('hidden');
        this.startMatch();
      })
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        if (payload.id === this.myId) return;
        const target = this.remotePlayers[payload.id];
        if (target) {
          target.alive = payload.alive;
          target.score = payload.score;
          target.board = payload.board;
          target.team = payload.team;
          this.renderMiniBoard(payload.id, payload.board, payload.alive, payload.score);
          if (this.isRunning) this.checkOnlineWin();
        }
      })
      .on('broadcast', { event: 'attack' }, ({ payload }) => {
        if (!this.isRunning || !this.player.alive) return;
        if (payload.fromId !== this.myId && payload.targetTeam === this.myTeam) {
          this.player.receiveGarbage(payload.amount);
          this.addChatMessage('공격', `${payload.fromName}님이 ${payload.amount}줄 공격!`, true);
        }
      })
      .on('broadcast', { event: 'reset' }, () => {
        this.roomStatus = 'waiting';
        if (this.lobbyChannel) {
          this.lobbyChannel.track({ roomCode: this.currentRoom, status: 'waiting' });
        }
        this.updateHostButton();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.trackRoomPresence();
          if (this.lobbyChannel) {
            await this.lobbyChannel.track({ roomCode: code, status: 'waiting' });
          }
        }
      });
  },

  async trackRoomPresence() {
    if (!this.roomChannel) return;
    await this.roomChannel.track({
      id: this.myId,
      name: this.getNickname(),
      team: this.myTeam,
      joinedAt: this.myJoinedAt
    });
  },

  syncRoomPresence() {
    if (!this.roomChannel) return;
    const state = this.roomChannel.presenceState();
    const presentList = [];
    Object.values(state).forEach(entries => {
      if (entries && entries.length > 0) presentList.push(entries[0]);
    });

    // 가장 먼저 입장한 사람을 방장으로 자동 지정 (방장이 나가도 자동 인계)
    presentList.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    this.roomHostId = presentList[0]?.id || this.myId;
    this.updateHostButton();
    this.renderRoomPlayers(presentList, this.roomHostId);

    const others = presentList.filter(p => p.id !== this.myId);
    const prevIds = Object.keys(this.remotePlayers).sort().join(',');
    const nextIds = others.map(o => o.id).sort().join(',');

    const nextMap = {};
    others.forEach(o => {
      const prev = this.remotePlayers[o.id];
      nextMap[o.id] = {
        id: o.id,
        name: o.name,
        team: o.team,
        alive: prev ? prev.alive : true,
        score: prev ? prev.score : 0,
        board: prev ? prev.board : '0'.repeat(200)
      };
    });
    this.remotePlayers = nextMap;

    if (prevIds !== nextIds) {
      this.buildOpponentCards(Object.values(this.remotePlayers));
    }
    Object.values(this.remotePlayers).forEach(o => {
      const card = document.getElementById(`opp-card-${o.id}`);
      if (card) {
        card.className = `opp-card team-${o.team}` + (o.alive ? '' : ' dead');
        const nameEl = card.querySelector('.opp-name');
        if (nameEl) nameEl.textContent = `[${o.team}] ${o.name}`;
      }
      this.renderMiniBoard(o.id, o.board, o.alive, o.score);
    });
  },

  updateHostButton() {
    const show = this.roomHostId === this.myId && this.roomStatus !== 'playing';
    document.getElementById('startOnlineMatchBtn').classList.toggle('hidden', !show);
  },

  async leaveRoom() {
    if (!this.currentRoom) return;
    this.stopLoop();
    if (this.roomChannel) {
      await this.roomChannel.untrack();
      await this.sb.removeChannel(this.roomChannel);
      this.roomChannel = null;
    }
    if (this.lobbyChannel) {
      await this.lobbyChannel.untrack();
    }
    this.currentRoom = null;
    this.remotePlayers = {};
    this.opponentsGrid.innerHTML = '';
    document.getElementById('roomJoinArea').classList.remove('hidden');
    document.getElementById('roomInsideArea').classList.add('hidden');
  },

  setOnlineTeam(team) {
    this.myTeam = team;
    document.getElementById('pickRedBtn').classList.toggle('active', team === 'RED');
    document.getElementById('pickBlueBtn').classList.toggle('active', team === 'BLUE');
    if (this.roomChannel && this.currentRoom) {
      this.trackRoomPresence();
    }
  },

  renderRoomPlayers(players, hostId) {
    const ul = document.getElementById('roomPlayersList');
    ul.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const name = document.createElement('span');
      name.textContent = `${p.id === hostId ? '👑 ' : ''}${p.name}`;
      const badge = document.createElement('span');
      badge.textContent = p.team;
      badge.style.color = p.team === 'RED' ? '#f87171' : '#60a5fa';
      badge.style.fontWeight = '700';
      li.append(name, badge);
      ul.appendChild(li);
    });
  },

  requestOnlineStart() {
    if (!this.roomChannel || !this.currentRoom) return;
    const allTeams = new Set([this.myTeam, ...Object.values(this.remotePlayers).map(p => p.team)]);
    if (Object.keys(this.remotePlayers).length >= 1 && allTeams.size < 2) {
      alert('양 팀(RED / BLUE)에 최소 1명씩 있어야 팀전을 시작할 수 있습니다!');
      return;
    }
    this.roomChannel.send({ type: 'broadcast', event: 'start', payload: { startedAt: Date.now() } });
  },

  syncOnlineState() {
    if (this.mode !== 'online' || !this.roomChannel || !this.currentRoom) return;
    this.roomChannel.send({
      type: 'broadcast',
      event: 'state',
      payload: {
        id: this.myId,
        name: this.getNickname(),
        team: this.myTeam,
        alive: this.player.alive,
        score: this.player.score,
        board: this.player.encodeBoard()
      }
    });
  },

  checkOnlineWin() {
    const list = [
      { id: this.myId, team: this.myTeam, alive: this.player.alive },
      ...Object.values(this.remotePlayers)
    ];
    if (list.length < 2) return;
    const redAlive = list.some(p => p.team === 'RED' && p.alive);
    const blueAlive = list.some(p => p.team === 'BLUE' && p.alive);
    const teamsPresent = new Set(list.map(p => p.team)).size;

    if (teamsPresent >= 2 && (!redAlive || !blueAlive)) {
      this.stopLoop();
      const myWin = (this.myTeam === 'RED' && redAlive) || (this.myTeam === 'BLUE' && blueAlive);
      this.showOverlay(myWin ? 'TEAM VICTORY! 🎉' : 'DEFEAT...', `${redAlive ? 'RED' : 'BLUE'} 팀 승리!`, false);
      if (this.roomHostId === this.myId && this.roomChannel) {
        setTimeout(() => {
          if (this.roomChannel) {
            this.roomChannel.send({ type: 'broadcast', event: 'reset', payload: {} });
          }
        }, 2500);
      }
    }
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());