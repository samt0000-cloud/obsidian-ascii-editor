"use strict";

const {
  Plugin,
  ItemView,
  MarkdownView,
  Notice,
  PluginSettingTab,
  Setting,
  Menu,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "ascii-diagram-editor";

/* ========== 罫線の接続マスク ========== */
/* 上=1, 右=2, 下=4, 左=8 のビットで罫線の接続方向を表す */
const U = 1, R = 2, D = 4, L = 8;

const STYLE_TABLES = {
  thin: {
    1: "│", 2: "─", 3: "└", 4: "│", 5: "│", 6: "┌", 7: "├",
    8: "─", 9: "┘", 10: "─", 11: "┴", 12: "┐", 13: "┤", 14: "┬", 15: "┼",
  },
  bold: {
    1: "┃", 2: "━", 3: "┗", 4: "┃", 5: "┃", 6: "┏", 7: "┣",
    8: "━", 9: "┛", 10: "━", 11: "┻", 12: "┓", 13: "┫", 14: "┳", 15: "╋",
  },
  double: {
    1: "║", 2: "═", 3: "╚", 4: "║", 5: "║", 6: "╔", 7: "╠",
    8: "═", 9: "╝", 10: "═", 11: "╩", 12: "╗", 13: "╣", 14: "╦", 15: "╬",
  },
};

const CHAR_TO_MASK = {};
for (const style of Object.keys(STYLE_TABLES)) {
  for (const [mask, ch] of Object.entries(STYLE_TABLES[style])) {
    const m = Number(mask);
    if (m === 1 || m === 2 || m === 4 || m === 8) continue; // 端点用の重複を除く
    if (!(ch in CHAR_TO_MASK)) CHAR_TO_MASK[ch] = m;
  }
}

/* ========== 文字パレット ========== */
const PALETTE = [
  { label: "罫線 細", chars: ["─", "│", "┌", "┐", "└", "┘", "┼", "├", "┤", "┬", "┴"] },
  { label: "罫線 太", chars: ["━", "┃", "┏", "┓", "┗", "┛", "╋", "┣", "┫", "┳", "┻"] },
  { label: "罫線 二重", chars: ["═", "║", "╔", "╗", "╚", "╝", "╬", "╠", "╣", "╦", "╩"] },
  { label: "矢印", chars: ["←", "→", "↑", "↓", "↔", "↕", "⇐", "⇒", "⇔", "↖", "↗", "↘", "↙"] },
  { label: "図形", chars: ["□", "■", "◇", "◆", "○", "●", "◎", "△", "▲", "▽", "▼", "☆", "★"] },
  { label: "カッコ", chars: ["「", "」", "『", "』", "【", "】", "［", "］", "（", "）", "〈", "〉", "《", "》", "｛", "｝"] },
  { label: "記号", chars: ["・", "：", "＝", "＋", "－", "×", "／", "＼", "％", "＃", "＊", "！", "？", "〜", "…", "※"] },
];

/* 複数マスをまとめて置けるスタンプ */
const STAMPS = [
  { label: "［　］", lines: ["［　］"] },
  { label: "「　」", lines: ["「　」"] },
  { label: "【　】", lines: ["【　】"] },
  { label: "箱 小", lines: ["┌─┐", "│　│", "└─┘"] },
  { label: "箱 中", lines: ["┌───┐", "│　　　│", "└───┘"] },
  { label: "箱 大", lines: ["┌─────┐", "│　　　　　│", "└─────┘"] },
  { label: "──→", lines: ["──→"] },
  { label: "←──", lines: ["←──"] },
];

/* ========== ユーティリティ ========== */
function toFullWidth(ch) {
  const code = ch.codePointAt(0);
  if (code === 0x20) return "　";
  if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code + 0xfee0);
  return ch;
}

const DEFAULT_SETTINGS = {
  cols: 40,
  rows: 20,
  cellPx: 26,
  convertFullWidth: true,
  copyAsCodeBlock: true,
  trimTrailing: true,
  savedGrid: null,
};

const TOOL_HINTS = {
  select: "ドラッグで範囲選択 ／ ドラッグまたは矢印キーで移動（Ctrl+ドラッグで複製）／ Ctrl+C・X・V ／ Delete で削除 ／ 右クリックでメニュー",
  pen: "クリック・ドラッグで配置 ／ 右クリックで消去 ／ Alt+クリックでセルの文字を取得",
  eraser: "クリック・ドラッグで消去",
  line: "ドラッグで直線・L字線を描画（Shiftで縦優先）／ 既存の罫線と自動接続",
  rect: "ドラッグで四角形の枠を描画 ／ 既存の罫線と自動接続",
  text: "セルをクリックして入力（日本語入力対応）／ Enterで改行 ／ Escで終了",
  stamp: "クリックでスタンプを配置（連続配置可）／ Escで解除",
};

/* ========== ビュー ========== */
class DiagramView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;

    this.tool = "pen";
    this.currentChar = "─";
    this.currentStamp = null;
    this.lineStyle = "thin";

    this.cols = plugin.settings.cols;
    this.rows = plugin.settings.rows;
    this.cells = [];
    this.cellEls = [];

    this.history = [];
    this.redoStack = [];

    this.ghost = new Map();      // "r,c" -> プレビュー文字
    this.hoverCell = null;       // {r,c}
    this.selection = null;       // {r1,c1,r2,c2} 正規化済み
    this.drag = null;            // 進行中のドラッグ操作
    this.pendingPaste = null;    // Ctrl+V 後の配置待ちリージョン
    this.clipboardRegion = null; // 内部クリップボード
    this.dragPayload = null;     // HTML5 DnD 中のリージョン
    this.caret = null;           // テキストツールのカーソル {r,c,startCol}
    this.saveTimer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "ASCII図解エディタ"; }
  getIcon() { return "grid-3x3"; }

  async onOpen() {
    this.restoreSavedGrid();
    this.buildUi();
    this.refreshAll();
  }

  async onClose() {
    this.flushSave();
  }

  /* ---------- 状態 ---------- */
  restoreSavedGrid() {
    const saved = this.plugin.settings.savedGrid;
    if (saved && Array.isArray(saved.cells) && saved.cols > 0 && saved.rows > 0) {
      this.cols = saved.cols;
      this.rows = saved.rows;
      this.cells = [];
      for (let r = 0; r < this.rows; r++) {
        const row = [];
        for (let c = 0; c < this.cols; c++) {
          row.push((saved.cells[r] && typeof saved.cells[r][c] === "string") ? saved.cells[r][c] : "");
        }
        this.cells.push(row);
      }
    } else {
      this.cells = this.emptyCells(this.rows, this.cols);
    }
  }

  emptyCells(rows, cols) {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  }

  serializeModel() {
    return JSON.stringify({ cols: this.cols, rows: this.rows, cells: this.cells });
  }

  scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 800);
  }

  flushSave() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.plugin.settings.savedGrid = { cols: this.cols, rows: this.rows, cells: this.cells };
    this.plugin.saveSettings();
  }

  pushHistory() {
    this.history.push(this.serializeModel());
    if (this.history.length > 200) this.history.shift();
    this.redoStack = [];
    this._lastNudge = 0; // 矢印キー移動の履歴まとめをリセット
  }

  undo() {
    if (!this.history.length) return;
    this.redoStack.push(this.serializeModel());
    this.restoreModel(this.history.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.history.push(this.serializeModel());
    this.restoreModel(this.redoStack.pop());
  }

  restoreModel(json) {
    try {
      const data = JSON.parse(json);
      this._lastNudge = 0;
      const resized = data.cols !== this.cols || data.rows !== this.rows;
      this.cols = data.cols;
      this.rows = data.rows;
      this.cells = data.cells;
      this.selection = null;
      this.ghost.clear();
      if (resized) this.buildGridDom();
      this.refreshAll();
      this.scheduleSave();
    } catch (e) {
      console.error("ASCII図解エディタ: 履歴の復元に失敗", e);
    }
  }

  /* ---------- UI 構築 ---------- */
  buildUi() {
    const content = this.contentEl;
    content.empty();
    content.addClass("aae-content");

    this.rootEl = content.createDiv({ cls: "aae-root" });

    this.buildToolbar(this.rootEl);
    this.buildPalette(this.rootEl);

    this.gridWrapEl = this.rootEl.createDiv({ cls: "aae-grid-wrap" });
    this.gridWrapEl.tabIndex = 0;
    this.gridEl = this.gridWrapEl.createDiv({ cls: "aae-grid" });
    this.buildGridDom();

    this.imeInput = this.gridEl.createEl("input", { cls: "aae-ime-input", type: "text" });
    this.imeInput.style.display = "none";
    this.bindImeInput();

    this.statusEl = this.rootEl.createDiv({ cls: "aae-status" });
    this.statusPosEl = this.statusEl.createSpan({ cls: "aae-status-pos" });
    this.statusHintEl = this.statusEl.createSpan({ cls: "aae-status-hint" });

    this.bindGridEvents();
    // フォーカスがビューコンテナや body に移ってもショートカットが効くよう document で受ける
    this.registerDomEvent(document, "keydown", (e) => {
      if (!this.isKeyboardTarget()) return;
      this.onKeyDown(e);
    });
    this.applyZoom();
    this.updateStatus();
  }

  makeBtn(parent, { icon, label, tooltip, cls, onClick }) {
    const btn = parent.createEl("button", { cls: "aae-btn" + (cls ? " " + cls : "") });
    if (icon) {
      const ic = btn.createSpan({ cls: "aae-btn-icon" });
      setIcon(ic, icon);
    }
    if (label) btn.createSpan({ text: label });
    if (tooltip) btn.setAttribute("aria-label", tooltip), btn.setAttribute("title", tooltip);
    btn.addEventListener("click", (e) => { e.preventDefault(); onClick(e); });
    return btn;
  }

  buildToolbar(parent) {
    const bar = parent.createDiv({ cls: "aae-toolbar" });

    // ツール
    const tools = [
      { id: "select", icon: "box-select", tip: "選択（範囲選択・移動・コピペ）" },
      { id: "pen", icon: "pencil", tip: "ペン（選択中の文字を置く）" },
      { id: "eraser", icon: "eraser", tip: "消しゴム" },
      { id: "line", icon: "minus", tip: "直線（罫線を自動接続）" },
      { id: "rect", icon: "square", tip: "四角形の枠" },
      { id: "text", icon: "type", tip: "テキスト入力" },
    ];
    const toolSeg = bar.createDiv({ cls: "aae-seg" });
    this.toolBtns = {};
    for (const t of tools) {
      this.toolBtns[t.id] = this.makeBtn(toolSeg, {
        icon: t.icon, tooltip: t.tip, cls: "aae-tool-btn",
        onClick: () => this.setTool(t.id),
      });
    }

    // 線種
    const styleSeg = bar.createDiv({ cls: "aae-seg" });
    this.styleBtns = {};
    for (const [id, label] of [["thin", "細"], ["bold", "太"], ["double", "二重"]]) {
      this.styleBtns[id] = this.makeBtn(styleSeg, {
        label, tooltip: "直線・四角形の線種: " + label, cls: "aae-style-btn",
        onClick: () => {
          this.lineStyle = id;
          this.updateToolbarState();
        },
      });
    }

    // 現在の文字
    this.currentCharEl = bar.createDiv({ cls: "aae-current", attr: { title: "ペンで置く文字" } });

    // 履歴・クリア
    const editSeg = bar.createDiv({ cls: "aae-seg" });
    this.makeBtn(editSeg, { icon: "undo-2", tooltip: "元に戻す (Ctrl+Z)", onClick: () => this.undo() });
    this.makeBtn(editSeg, { icon: "redo-2", tooltip: "やり直す (Ctrl+Y)", onClick: () => this.redo() });
    this.makeBtn(editSeg, {
      icon: "trash-2", tooltip: "全体をクリア", onClick: () => {
        this.pushHistory();
        this.cells = this.emptyCells(this.rows, this.cols);
        this.setSelection(null);
        this.refreshAll();
        this.scheduleSave();
        new Notice("クリアしました（Ctrl+Zで戻せます）");
      },
    });

    // グリッドサイズ
    const sizeWrap = bar.createDiv({ cls: "aae-size" });
    sizeWrap.createSpan({ text: "幅", cls: "aae-size-label" });
    this.colsInput = sizeWrap.createEl("input", { type: "number", cls: "aae-size-input" });
    this.colsInput.min = "5"; this.colsInput.max = "200";
    sizeWrap.createSpan({ text: "高さ", cls: "aae-size-label" });
    this.rowsInput = sizeWrap.createEl("input", { type: "number", cls: "aae-size-input" });
    this.rowsInput.min = "5"; this.rowsInput.max = "200";
    const applySize = () => {
      const c = Math.max(5, Math.min(200, Number(this.colsInput.value) || this.cols));
      const r = Math.max(5, Math.min(200, Number(this.rowsInput.value) || this.rows));
      if (c !== this.cols || r !== this.rows) this.resizeGrid(c, r);
    };
    this.colsInput.addEventListener("change", applySize);
    this.rowsInput.addEventListener("change", applySize);

    // ズーム
    const zoomSeg = bar.createDiv({ cls: "aae-seg" });
    this.makeBtn(zoomSeg, { icon: "zoom-out", tooltip: "縮小", onClick: () => this.zoom(-2) });
    this.makeBtn(zoomSeg, { icon: "zoom-in", tooltip: "拡大", onClick: () => this.zoom(2) });

    bar.createDiv({ cls: "aae-spacer" });

    // 出力系
    this.makeBtn(bar, {
      icon: "copy", label: "全体コピー",
      tooltip: "図全体をクリップボードへコピー（設定でコードブロックを付与）",
      cls: "aae-primary", onClick: () => this.copyAll(),
    });
    this.makeBtn(bar, {
      icon: "file-input", label: "ノートへ挿入",
      tooltip: "最後に開いていたノートのカーソル位置に挿入",
      onClick: () => this.insertIntoNote(),
    });
    this.makeBtn(bar, {
      icon: "clipboard-paste", label: "読み込み",
      tooltip: "クリップボードのテキストをグリッドに読み込む",
      onClick: () => this.importFromClipboard(),
    });
  }

  buildPalette(parent) {
    const pal = parent.createDiv({ cls: "aae-palette" });
    for (const group of PALETTE) {
      const row = pal.createDiv({ cls: "aae-pal-row" });
      row.createDiv({ cls: "aae-pal-label", text: group.label });
      const wrap = row.createDiv({ cls: "aae-pal-chars" });
      for (const ch of group.chars) {
        const btn = wrap.createEl("button", { cls: "aae-pal-char", text: ch });
        btn.setAttribute("title", ch + " — クリックで選択 / グリッドへドラッグで配置");
        btn.draggable = true;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          this.setCurrentChar(ch);
        });
        btn.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", ch);
          e.dataTransfer.effectAllowed = "copy";
          this.dragPayload = { w: 1, h: 1, cells: [[ch]] };
        });
        btn.addEventListener("dragend", () => {
          this.dragPayload = null;
          this.clearGhost();
        });
      }
    }
    // スタンプ
    const row = pal.createDiv({ cls: "aae-pal-row" });
    row.createDiv({ cls: "aae-pal-label", text: "スタンプ" });
    const wrap = row.createDiv({ cls: "aae-pal-chars" });
    for (const stamp of STAMPS) {
      const btn = wrap.createEl("button", { cls: "aae-pal-stamp", text: stamp.label });
      btn.setAttribute("title", "クリックでスタンプツール / グリッドへドラッグで配置");
      btn.draggable = true;
      const region = this.linesToRegion(stamp.lines);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.currentStamp = region;
        this.setTool("stamp");
      });
      btn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", stamp.lines.join("\n"));
        e.dataTransfer.effectAllowed = "copy";
        this.dragPayload = region;
      });
      btn.addEventListener("dragend", () => {
        this.dragPayload = null;
        this.clearGhost();
      });
    }
  }

  buildGridDom() {
    this.gridEl.empty();
    this.gridEl.style.gridTemplateColumns = `repeat(${this.cols}, var(--aae-cell))`;
    this.cellEls = [];
    for (let r = 0; r < this.rows; r++) {
      const rowEls = [];
      for (let c = 0; c < this.cols; c++) {
        const cell = this.gridEl.createDiv({ cls: "aae-cell" });
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        if ((c + 1) % 5 === 0) cell.addClass("aae-g5r");
        if ((r + 1) % 5 === 0) cell.addClass("aae-g5b");
        rowEls.push(cell);
      }
      this.cellEls.push(rowEls);
    }
    if (this.imeInput) this.gridEl.appendChild(this.imeInput);
    if (this.colsInput) {
      this.colsInput.value = String(this.cols);
      this.rowsInput.value = String(this.rows);
    }
  }

  applyZoom() {
    const px = this.plugin.settings.cellPx;
    this.gridWrapEl.style.setProperty("--aae-cell", px + "px");
  }

  zoom(delta) {
    const s = this.plugin.settings;
    s.cellPx = Math.max(14, Math.min(48, s.cellPx + delta));
    this.plugin.saveSettings();
    this.applyZoom();
    if (this.caret) this.positionImeInput();
  }

  /* ---------- 表示更新 ---------- */
  cellKey(r, c) { return r + "," + c; }
  inBounds(r, c) { return r >= 0 && r < this.rows && c >= 0 && c < this.cols; }

  inSelection(r, c) {
    const s = this.selection;
    return !!s && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
  }

  refreshCell(r, c) {
    if (!this.inBounds(r, c)) return;
    const el = this.cellEls[r][c];
    const k = this.cellKey(r, c);
    let ch = this.cells[r][c];
    let ghost = false;
    if (this.ghost.has(k)) {
      ch = this.ghost.get(k);
      ghost = true;
    }
    el.textContent = ch || "";
    el.classList.toggle("aae-ghost", ghost);
    el.classList.toggle("aae-selected", this.inSelection(r, c));
    el.classList.toggle("aae-caret", !!this.caret && this.caret.r === r && this.caret.c === c);
  }

  refreshAll() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        this.refreshCell(r, c);
  }

  refreshRect(rect) {
    if (!rect) return;
    for (let r = Math.max(0, rect.r1); r <= Math.min(this.rows - 1, rect.r2); r++)
      for (let c = Math.max(0, rect.c1); c <= Math.min(this.cols - 1, rect.c2); c++)
        this.refreshCell(r, c);
  }

  setCell(r, c, ch) {
    if (!this.inBounds(r, c)) return;
    this.cells[r][c] = ch;
    this.refreshCell(r, c);
    this.scheduleSave();
  }

  setSelection(rect) {
    const old = this.selection;
    if (rect) {
      rect = {
        r1: Math.max(0, Math.min(rect.r1, rect.r2)),
        c1: Math.max(0, Math.min(rect.c1, rect.c2)),
        r2: Math.min(this.rows - 1, Math.max(rect.r1, rect.r2)),
        c2: Math.min(this.cols - 1, Math.max(rect.c1, rect.c2)),
      };
    }
    this.selection = rect;
    this.refreshRect(old);
    this.refreshRect(rect);
  }

  setGhostMap(map) {
    const touched = new Set([...this.ghost.keys(), ...map.keys()]);
    this.ghost = map;
    for (const k of touched) {
      const [r, c] = k.split(",").map(Number);
      this.refreshCell(r, c);
    }
  }

  clearGhost() {
    if (!this.ghost.size) return;
    this.setGhostMap(new Map());
  }

  updateToolbarState() {
    for (const [id, btn] of Object.entries(this.toolBtns)) {
      btn.classList.toggle("is-active", this.tool === id);
    }
    for (const [id, btn] of Object.entries(this.styleBtns)) {
      btn.classList.toggle("is-active", this.lineStyle === id);
    }
    this.currentCharEl.textContent = this.currentChar;
  }

  updateStatus() {
    const pos = this.hoverCell ? `行 ${this.hoverCell.r + 1} ・ 列 ${this.hoverCell.c + 1}` : "";
    this.statusPosEl.textContent = pos;
    let hint = TOOL_HINTS[this.tool] || "";
    if (this.pendingPaste) hint = "クリックで貼り付け位置を確定 ／ Escでキャンセル";
    this.statusHintEl.textContent = hint;
    this.updateToolbarState();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== "text") this.setCaret(null);
    if (tool !== "stamp") this.currentStamp = null;
    this.clearGhost();
    this.updateStatus();
  }

  setCurrentChar(ch) {
    this.currentChar = ch;
    if (this.tool !== "pen") this.setTool("pen");
    else this.updateStatus();
  }

  /* ---------- リージョン（矩形領域）操作 ---------- */
  linesToRegion(lines) {
    const cells = lines.map((line) =>
      Array.from(line).map((ch) => (ch === "　" || ch === " " ? "" : ch))
    );
    const w = Math.max(...cells.map((row) => row.length), 1);
    for (const row of cells) while (row.length < w) row.push("");
    return { w, h: cells.length, cells };
  }

  textToRegion(text) {
    if (!text) return null;
    let lines = text.replace(/\r/g, "").split("\n");
    // コードフェンスを取り除く
    if (lines.length && /^```/.test(lines[0])) lines = lines.slice(1);
    if (lines.length && /^```/.test(lines[lines.length - 1])) lines = lines.slice(0, -1);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) return null;
    const convert = this.plugin.settings.convertFullWidth;
    const cells = lines.map((line) =>
      Array.from(line).map((raw) => {
        const ch = convert ? toFullWidth(raw) : raw;
        return ch === "　" || ch === " " ? "" : ch;
      })
    );
    const w = Math.max(...cells.map((row) => row.length), 1);
    for (const row of cells) while (row.length < w) row.push("");
    return { w, h: cells.length, cells };
  }

  regionFromSelection() {
    const s = this.selection;
    if (!s) return null;
    const cells = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const row = [];
      for (let c = s.c1; c <= s.c2; c++) row.push(this.cells[r][c]);
      cells.push(row);
    }
    return { w: s.c2 - s.c1 + 1, h: s.r2 - s.r1 + 1, cells };
  }

  regionToText(region) {
    return region.cells
      .map((row) => row.map((ch) => ch || "　").join(""))
      .join("\n");
  }

  ghostForRegion(anchorR, anchorC, region) {
    const map = new Map();
    for (let r = 0; r < region.h; r++) {
      for (let c = 0; c < region.w; c++) {
        const ch = region.cells[r][c];
        if (!ch) continue; // 空白は透過
        const rr = anchorR + r, cc = anchorC + c;
        if (this.inBounds(rr, cc)) map.set(this.cellKey(rr, cc), ch);
      }
    }
    return map;
  }

  stampRegion(anchorR, anchorC, region) {
    for (let r = 0; r < region.h; r++) {
      for (let c = 0; c < region.w; c++) {
        const ch = region.cells[r][c];
        if (!ch) continue; // 空白は透過（下の内容を残す）
        this.setCell(anchorR + r, anchorC + c, ch);
      }
    }
  }

  clearRect(rect) {
    for (let r = rect.r1; r <= rect.r2; r++)
      for (let c = rect.c1; c <= rect.c2; c++)
        this.setCell(r, c, "");
  }

  async copySelection(cut) {
    const region = this.regionFromSelection();
    if (!region) {
      new Notice("選択範囲がありません");
      return;
    }
    this.clipboardRegion = region;
    try {
      await navigator.clipboard.writeText(this.regionToText(region));
    } catch (e) { /* システムクリップボードは失敗しても内部コピーは有効 */ }
    if (cut) {
      this.pushHistory();
      this.clearRect(this.selection);
      new Notice("切り取りました");
    } else {
      new Notice("選択範囲をコピーしました");
    }
  }

  deleteSelection() {
    if (!this.selection) return;
    this.pushHistory();
    this.clearRect(this.selection);
  }

  async startPastePending() {
    let region = this.clipboardRegion;
    if (!region) {
      try {
        const text = await navigator.clipboard.readText();
        region = this.textToRegion(text);
      } catch (e) { /* ignore */ }
    }
    if (!region) {
      new Notice("貼り付ける内容がありません");
      return;
    }
    this.pendingPaste = region;
    if (this.hoverCell) {
      this.setGhostMap(this.ghostForRegion(this.hoverCell.r, this.hoverCell.c, region));
    }
    this.updateStatus();
  }

  commitPaste(r, c) {
    if (!this.pendingPaste) return;
    this.pushHistory();
    this.stampRegion(r, c, this.pendingPaste);
    const region = this.pendingPaste;
    this.pendingPaste = null;
    this.clearGhost();
    this.setSelection({ r1: r, c1: c, r2: r + region.h - 1, c2: c + region.w - 1 });
    this.updateStatus();
  }

  /* ---------- 罫線描画 ---------- */
  addMask(map, r, c, m) {
    if (!this.inBounds(r, c)) return;
    const k = this.cellKey(r, c);
    map.set(k, (map.get(k) || 0) | m);
  }

  hSegment(map, r, ca, cb) {
    const lo = Math.min(ca, cb), hi = Math.max(ca, cb);
    for (let c = lo; c <= hi; c++) {
      let m = 0;
      if (c > lo) m |= L;
      if (c < hi) m |= R;
      if (m === 0) m = L | R;
      this.addMask(map, r, c, m);
    }
  }

  vSegment(map, c, ra, rb) {
    const lo = Math.min(ra, rb), hi = Math.max(ra, rb);
    for (let r = lo; r <= hi; r++) {
      let m = 0;
      if (r > lo) m |= U;
      if (r < hi) m |= D;
      if (m === 0) m = U | D;
      this.addMask(map, r, c, m);
    }
  }

  computeLineMasks(r1, c1, r2, c2, vFirst) {
    const map = new Map();
    if (r1 === r2) {
      this.hSegment(map, r1, c1, c2);
    } else if (c1 === c2) {
      this.vSegment(map, c1, r1, r2);
    } else if (vFirst) {
      // 縦→横のL字
      const vMap = new Map();
      this.vSegment(vMap, c1, r1, r2);
      this.hSegment(vMap, r2, c1, c2);
      return vMap;
    } else {
      // 横→縦のL字
      this.hSegment(map, r1, c1, c2);
      this.vSegment(map, c2, r1, r2);
    }
    return map;
  }

  computeRectMasks(r1, c1, r2, c2) {
    const map = new Map();
    const rlo = Math.min(r1, r2), rhi = Math.max(r1, r2);
    const clo = Math.min(c1, c2), chi = Math.max(c1, c2);
    if (rlo === rhi) { this.hSegment(map, rlo, clo, chi); return map; }
    if (clo === chi) { this.vSegment(map, clo, rlo, rhi); return map; }
    this.hSegment(map, rlo, clo, chi);
    this.hSegment(map, rhi, clo, chi);
    this.vSegment(map, clo, rlo, rhi);
    this.vSegment(map, chi, rlo, rhi);
    return map;
  }

  masksToChars(masks) {
    const table = STYLE_TABLES[this.lineStyle];
    const result = new Map();
    for (const [k, m] of masks) {
      const [r, c] = k.split(",").map(Number);
      const existing = CHAR_TO_MASK[this.cells[r][c]] || 0;
      result.set(k, table[(m | existing) & 15] || table[m & 15]);
    }
    return result;
  }

  commitMasks(masks) {
    const chars = this.masksToChars(masks);
    this.pushHistory();
    for (const [k, ch] of chars) {
      const [r, c] = k.split(",").map(Number);
      this.setCell(r, c, ch);
    }
  }

  /* ---------- ペン・消しゴム ---------- */
  paintCell(r, c) {
    this.setCell(r, c, this.currentChar);
  }

  eraseCell(r, c) {
    this.setCell(r, c, "");
  }

  /* 高速ドラッグでセルが飛んでも間を補間する */
  applyAlong(from, to, fn) {
    if (!from) { fn(to.r, to.c); return; }
    const steps = Math.max(Math.abs(to.r - from.r), Math.abs(to.c - from.c), 1);
    for (let i = 1; i <= steps; i++) {
      const r = Math.round(from.r + ((to.r - from.r) * i) / steps);
      const c = Math.round(from.c + ((to.c - from.c) * i) / steps);
      fn(r, c);
    }
  }

  /* ---------- グリッドイベント ---------- */
  bindGridEvents() {
    this.registerDomEvent(this.gridEl, "mousedown", (e) => this.onGridMouseDown(e));
    this.registerDomEvent(this.gridEl, "mouseover", (e) => this.onGridMouseOver(e));
    this.registerDomEvent(this.gridEl, "mouseleave", () => {
      this.hoverCell = null;
      this.updateStatus();
    });
    this.registerDomEvent(document, "mouseup", (e) => this.onDocMouseUp(e));
    this.registerDomEvent(this.gridEl, "contextmenu", (e) => this.onContextMenu(e));
    // HTML5 ドラッグ&ドロップ（パレット・外部テキスト）
    this.registerDomEvent(this.gridEl, "dragover", (e) => {
      e.preventDefault();
      const cell = this.cellFromEvent(e);
      if (!cell) return;
      this.hoverCell = cell;
      if (this.dragPayload) {
        this.setGhostMap(this.ghostForRegion(cell.r, cell.c, this.dragPayload));
      }
    });
    this.registerDomEvent(this.gridEl, "dragleave", (e) => {
      if (e.target === this.gridEl) this.clearGhost();
    });
    this.registerDomEvent(this.gridEl, "drop", (e) => {
      e.preventDefault();
      const cell = this.cellFromEvent(e);
      if (!cell) return;
      const region = this.dragPayload || this.textToRegion(e.dataTransfer.getData("text/plain"));
      this.dragPayload = null;
      this.clearGhost();
      if (!region) return;
      this.pushHistory();
      this.stampRegion(cell.r, cell.c, region);
    });
  }

  cellFromEvent(e) {
    const el = e.target instanceof HTMLElement ? e.target.closest(".aae-cell") : null;
    if (!el) return null;
    return { r: Number(el.dataset.r), c: Number(el.dataset.c) };
  }

  onGridMouseDown(e) {
    const cell = this.cellFromEvent(e);
    if (!cell) return;
    e.preventDefault();
    this.gridWrapEl.focus({ preventScroll: true });
    this.hoverCell = cell;

    // 貼り付け待ちならどのツールでも確定
    if (this.pendingPaste && e.button === 0) {
      this.commitPaste(cell.r, cell.c);
      return;
    }

    // 右クリック: 選択ツールはメニュー、それ以外は消去ドラッグ
    if (e.button === 2) {
      if (this.tool === "select") return; // contextmenu 側で処理
      this.pushHistory();
      this.eraseCell(cell.r, cell.c);
      this.drag = { mode: "erase", last: cell };
      return;
    }
    if (e.button !== 0) return;

    switch (this.tool) {
      case "select": {
        if (this.inSelection(cell.r, cell.c)) {
          const region = this.regionFromSelection();
          this.drag = {
            mode: "move",
            region,
            srcRect: { ...this.selection },
            grabDR: cell.r - this.selection.r1,
            grabDC: cell.c - this.selection.c1,
            copyMode: e.ctrlKey || e.altKey,
            last: cell,
          };
        } else {
          this.setSelection({ r1: cell.r, c1: cell.c, r2: cell.r, c2: cell.c });
          this.drag = { mode: "select", start: cell, last: cell };
        }
        break;
      }
      case "pen": {
        if (e.altKey) {
          const picked = this.cells[cell.r][cell.c];
          if (picked) this.setCurrentChar(picked);
          break;
        }
        this.pushHistory();
        this.paintCell(cell.r, cell.c);
        this.drag = { mode: "paint", last: cell };
        break;
      }
      case "eraser": {
        this.pushHistory();
        this.eraseCell(cell.r, cell.c);
        this.drag = { mode: "erase", last: cell };
        break;
      }
      case "line": {
        this.drag = { mode: "line", start: cell, last: cell, vFirst: e.shiftKey };
        this.setGhostMap(this.masksToChars(this.computeLineMasks(cell.r, cell.c, cell.r, cell.c, e.shiftKey)));
        break;
      }
      case "rect": {
        this.drag = { mode: "rect", start: cell, last: cell };
        this.setGhostMap(this.masksToChars(this.computeRectMasks(cell.r, cell.c, cell.r, cell.c)));
        break;
      }
      case "text": {
        this.setCaret({ r: cell.r, c: cell.c, startCol: cell.c });
        break;
      }
      case "stamp": {
        if (this.currentStamp) {
          this.pushHistory();
          this.stampRegion(cell.r, cell.c, this.currentStamp);
        }
        break;
      }
    }
    this.updateStatus();
  }

  onGridMouseOver(e) {
    const cell = this.cellFromEvent(e);
    if (!cell) return;
    this.hoverCell = cell;

    if (this.pendingPaste) {
      this.setGhostMap(this.ghostForRegion(cell.r, cell.c, this.pendingPaste));
      this.updateStatus();
      return;
    }
    if (this.tool === "stamp" && this.currentStamp && !this.drag) {
      this.setGhostMap(this.ghostForRegion(cell.r, cell.c, this.currentStamp));
    }

    const d = this.drag;
    if (d) {
      switch (d.mode) {
        case "paint":
          this.applyAlong(d.last, cell, (r, c) => this.paintCell(r, c));
          d.last = cell;
          break;
        case "erase":
          this.applyAlong(d.last, cell, (r, c) => this.eraseCell(r, c));
          d.last = cell;
          break;
        case "select":
          d.last = cell;
          this.setSelection({ r1: d.start.r, c1: d.start.c, r2: cell.r, c2: cell.c });
          break;
        case "move": {
          d.last = cell;
          const ar = cell.r - d.grabDR, ac = cell.c - d.grabDC;
          this.setGhostMap(this.ghostForRegion(ar, ac, d.region));
          break;
        }
        case "line":
          d.last = cell;
          d.vFirst = e.shiftKey;
          this.setGhostMap(this.masksToChars(this.computeLineMasks(d.start.r, d.start.c, cell.r, cell.c, d.vFirst)));
          break;
        case "rect":
          d.last = cell;
          this.setGhostMap(this.masksToChars(this.computeRectMasks(d.start.r, d.start.c, cell.r, cell.c)));
          break;
      }
    }
    this.updateStatus();
  }

  onDocMouseUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    // ドラッグ操作後にフォーカスが奪われても矢印キー等が効くよう戻す
    window.setTimeout(() => this.gridWrapEl.focus({ preventScroll: true }), 0);
    switch (d.mode) {
      case "line": {
        this.clearGhost();
        this.commitMasks(this.computeLineMasks(d.start.r, d.start.c, d.last.r, d.last.c, d.vFirst));
        break;
      }
      case "rect": {
        this.clearGhost();
        this.commitMasks(this.computeRectMasks(d.start.r, d.start.c, d.last.r, d.last.c));
        break;
      }
      case "move": {
        this.clearGhost();
        const ar = d.last.r - d.grabDR, ac = d.last.c - d.grabDC;
        if (!d.copyMode && ar === d.srcRect.r1 && ac === d.srcRect.c1) break; // 移動なし
        this.pushHistory();
        if (!d.copyMode) this.clearRect(d.srcRect);
        this.stampRegion(ar, ac, d.region);
        this.setSelection({ r1: ar, c1: ac, r2: ar + d.region.h - 1, c2: ac + d.region.w - 1 });
        break;
      }
    }
    this.updateStatus();
  }

  onContextMenu(e) {
    e.preventDefault();
    if (this.tool !== "select") return;
    const cell = this.cellFromEvent(e);
    const menu = new Menu();
    if (this.selection) {
      menu.addItem((i) => i.setTitle("コピー").setIcon("copy").onClick(() => this.copySelection(false)));
      menu.addItem((i) => i.setTitle("切り取り").setIcon("scissors").onClick(() => this.copySelection(true)));
      menu.addItem((i) => i.setTitle("削除").setIcon("trash-2").onClick(() => this.deleteSelection()));
    }
    if ((this.clipboardRegion || this.pendingPaste) && cell) {
      menu.addItem((i) => i.setTitle("ここに貼り付け").setIcon("clipboard-paste").onClick(() => {
        this.pendingPaste = this.pendingPaste || this.clipboardRegion;
        this.commitPaste(cell.r, cell.c);
      }));
    }
    if (this.selection) {
      menu.addItem((i) => i.setTitle("選択解除").setIcon("x").onClick(() => this.setSelection(null)));
    }
    menu.showAtMouseEvent(e);
  }

  /* ---------- キーボード ---------- */
  /* このビューがアクティブで、フォーカスが他の入力欄に無いときだけキーを処理する */
  isKeyboardTarget() {
    if (this.app.workspace.activeLeaf !== this.leaf) return false;
    const ae = document.activeElement;
    if (ae && ae !== document.body && !this.containerEl.contains(ae)) return false;
    return true;
  }

  onKeyDown(e) {
    const isIme = e.target === this.imeInput;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === "Escape") {
      this.pendingPaste = null;
      this.clearGhost();
      if (this.drag) this.drag = null;
      if (!isIme) this.setSelection(null);
      this.updateStatus();
      return;
    }
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (isIme) return; // 以降のショートカットはテキスト入力中は無効

    if (mod && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      if (this.selection) this.copySelection(false);
      else this.copyAll();
      return;
    }
    if (mod && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      if (this.selection) this.copySelection(true);
      return;
    }
    if (mod && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      this.startPastePending();
      return;
    }
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      this.setTool("select");
      this.setSelection({ r1: 0, c1: 0, r2: this.rows - 1, c2: this.cols - 1 });
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selection) {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (!mod && this.selection &&
      (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      this.nudgeSelection(e.key);
      return;
    }
  }

  /* 選択範囲を矢印キーで1マス移動する */
  nudgeSelection(key) {
    const s = this.selection;
    if (!s) return;
    const dr = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
    const dc = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    const h = s.r2 - s.r1 + 1;
    const w = s.c2 - s.c1 + 1;
    const nr = s.r1 + dr;
    const nc = s.c1 + dc;
    if (nr < 0 || nc < 0 || nr + h > this.rows || nc + w > this.cols) return;
    // 連続して押した分は1つの履歴にまとめる
    const now = Date.now();
    const coalesce = this._lastNudge && now - this._lastNudge <= 800;
    if (!coalesce) this.pushHistory();
    this._lastNudge = now;
    const region = this.regionFromSelection();
    this.clearRect(s);
    this.stampRegion(nr, nc, region);
    this.setSelection({ r1: nr, c1: nc, r2: nr + h - 1, c2: nc + w - 1 });
  }

  /* ---------- テキストツール ---------- */
  bindImeInput() {
    const input = this.imeInput;
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", (e) => {
      composing = false;
      if (e.data) this.commitText(e.data);
      input.value = "";
    });
    input.addEventListener("input", (e) => {
      if (composing || e.isComposing) return;
      if (input.value) {
        this.commitText(input.value);
        input.value = "";
      }
    });
    input.addEventListener("keydown", (e) => {
      if (composing) return;
      const caret = this.caret;
      if (!caret) return;
      switch (e.key) {
        case "Enter":
          e.preventDefault();
          this.setCaret({ r: Math.min(caret.r + 1, this.rows - 1), c: caret.startCol, startCol: caret.startCol });
          break;
        case "Backspace":
          if (!input.value) {
            e.preventDefault();
            const c = Math.max(0, caret.c - 1);
            this.pushHistory();
            this.setCell(caret.r, c, "");
            this.setCaret({ r: caret.r, c, startCol: caret.startCol });
          }
          break;
        case "Delete":
          e.preventDefault();
          this.pushHistory();
          this.setCell(caret.r, caret.c, "");
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.setCaret({ r: caret.r, c: Math.max(0, caret.c - 1), startCol: caret.startCol });
          break;
        case "ArrowRight":
          e.preventDefault();
          this.setCaret({ r: caret.r, c: Math.min(this.cols - 1, caret.c + 1), startCol: caret.startCol });
          break;
        case "ArrowUp":
          e.preventDefault();
          this.setCaret({ r: Math.max(0, caret.r - 1), c: caret.c, startCol: caret.startCol });
          break;
        case "ArrowDown":
          e.preventDefault();
          this.setCaret({ r: Math.min(this.rows - 1, caret.r + 1), c: caret.c, startCol: caret.startCol });
          break;
        case "Escape":
          e.preventDefault();
          this.setCaret(null);
          break;
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => {
      // IME確定直後のフォーカス移動を考慮して少し待ってから解除
      window.setTimeout(() => {
        if (document.activeElement !== input) this.setCaret(null);
      }, 150);
    });
  }

  setCaret(caret) {
    const old = this.caret;
    this.caret = caret;
    if (old) this.refreshCell(old.r, old.c);
    if (caret) {
      this.refreshCell(caret.r, caret.c);
      this.positionImeInput();
      this.imeInput.style.display = "block";
      this.imeInput.focus({ preventScroll: true });
    } else {
      this.imeInput.style.display = "none";
      this.imeInput.value = "";
    }
  }

  positionImeInput() {
    if (!this.caret) return;
    const px = this.plugin.settings.cellPx;
    this.imeInput.style.left = this.caret.c * px + "px";
    this.imeInput.style.top = this.caret.r * px + "px";
    this.imeInput.style.width = px * 6 + "px";
    this.imeInput.style.height = px + "px";
    this.imeInput.style.fontSize = Math.round(px * 0.7) + "px";
  }

  commitText(str) {
    if (!this.caret) return;
    const convert = this.plugin.settings.convertFullWidth;
    this.pushHistory();
    let { r, c, startCol } = this.caret;
    for (const raw of Array.from(str)) {
      if (raw === "\r") continue;
      if (raw === "\n") {
        r = Math.min(r + 1, this.rows - 1);
        c = startCol;
        continue;
      }
      const ch = convert ? toFullWidth(raw) : raw;
      if (ch === "　") {
        // 全角スペースは空セルとして進める
        if (this.inBounds(r, c)) this.setCell(r, c, "");
      } else if (this.inBounds(r, c)) {
        this.setCell(r, c, ch);
      }
      c++;
      if (c >= this.cols) {
        r = Math.min(r + 1, this.rows - 1);
        c = startCol;
      }
    }
    this.setCaret({ r, c, startCol });
  }

  /* ---------- グリッドサイズ ---------- */
  resizeGrid(cols, rows) {
    this.pushHistory();
    const next = this.emptyCells(rows, cols);
    for (let r = 0; r < Math.min(rows, this.rows); r++)
      for (let c = 0; c < Math.min(cols, this.cols); c++)
        next[r][c] = this.cells[r][c];
    this.cols = cols;
    this.rows = rows;
    this.cells = next;
    this.selection = null;
    this.ghost.clear();
    this.caret = null;
    this.buildGridDom();
    this.refreshAll();
    this.scheduleSave();
  }

  /* ---------- 入出力 ---------- */
  buildText() {
    let lines = this.cells.map((row) => row.map((ch) => ch || "　").join(""));
    if (this.plugin.settings.trimTrailing) {
      lines = lines.map((l) => l.replace(/　+$/g, ""));
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  wrapForOutput(text) {
    if (this.plugin.settings.copyAsCodeBlock) {
      return "```\n" + text + "\n```";
    }
    return text;
  }

  async copyAll() {
    const text = this.buildText();
    if (!text) {
      new Notice("グリッドが空です");
      return;
    }
    try {
      await navigator.clipboard.writeText(this.wrapForOutput(text));
      new Notice("図全体をコピーしました");
    } catch (e) {
      new Notice("コピーに失敗しました");
    }
  }

  insertIntoNote() {
    const text = this.buildText();
    if (!text) {
      new Notice("グリッドが空です");
      return;
    }
    let view = this.plugin.lastMarkdownView;
    if (!view || !view.editor) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      view = leaves.length ? leaves[0].view : null;
    }
    if (!view || !view.editor) {
      new Notice("挿入先のノートが見つかりません。先にノートを開いてください");
      return;
    }
    view.editor.replaceSelection(this.wrapForOutput(text) + "\n");
    new Notice(`「${view.file ? view.file.basename : "ノート"}」に挿入しました`);
  }

  async importFromClipboard() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (e) { /* ignore */ }
    const region = this.textToRegion(text);
    if (!region) {
      new Notice("クリップボードに読み込めるテキストがありません");
      return;
    }
    this.pushHistory();
    const cols = Math.min(200, Math.max(this.cols, region.w));
    const rows = Math.min(200, Math.max(this.rows, region.h));
    if (cols !== this.cols || rows !== this.rows) {
      // resizeGrid は履歴を積むので直接組み替える
      const next = this.emptyCells(rows, cols);
      this.cols = cols;
      this.rows = rows;
      this.cells = next;
      this.buildGridDom();
    } else {
      this.cells = this.emptyCells(rows, cols);
    }
    this.stampRegion(0, 0, region);
    this.setSelection(null);
    this.refreshAll();
    this.scheduleSave();
    new Notice("クリップボードから読み込みました");
  }
}

/* ========== 設定タブ ========== */
class AsciiDiagramSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("半角文字を全角に自動変換")
      .setDesc("テキスト入力・読み込み時に半角英数記号を全角へ変換します。1マス=全角1文字に統一することで、コピペ時の位置ずれを防ぎます。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.convertFullWidth)
        .onChange(async (v) => {
          this.plugin.settings.convertFullWidth = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("コピー時にコードブロックで囲む")
      .setDesc("``` で囲むことで、AIチャットやMarkdownに貼り付けたときに等幅表示され、配置が保たれます。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.copyAsCodeBlock)
        .onChange(async (v) => {
          this.plugin.settings.copyAsCodeBlock = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("行末の空白を削除してコピー")
      .setDesc("各行の末尾の全角スペースを取り除きます（配置には影響しません）。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.trimTrailing)
        .onChange(async (v) => {
          this.plugin.settings.trimTrailing = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("新規グリッドの幅（マス数）")
      .addText((t) => t
        .setValue(String(this.plugin.settings.cols))
        .onChange(async (v) => {
          const n = Number(v);
          if (n >= 5 && n <= 200) {
            this.plugin.settings.cols = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName("新規グリッドの高さ（マス数）")
      .addText((t) => t
        .setValue(String(this.plugin.settings.rows))
        .onChange(async (v) => {
          const n = Number(v);
          if (n >= 5 && n <= 200) {
            this.plugin.settings.rows = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }));
  }
}

/* ========== プラグイン本体 ========== */
module.exports = class AsciiDiagramPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.lastMarkdownView = null;

    this.registerView(VIEW_TYPE, (leaf) => new DiagramView(leaf, this));

    this.addRibbonIcon("grid-3x3", "ASCII図解エディタを開く", () => this.activateView());

    this.addCommand({
      id: "open-editor",
      name: "エディタを開く",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new AsciiDiagramSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const v = leaf && leaf.view;
        if (v instanceof MarkdownView) this.lastMarkdownView = v;
      })
    );
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
