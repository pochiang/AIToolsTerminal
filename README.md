# AI Tools Terminal

管理 Claude Code 與 Codex 的桌面終端機（Electron + xterm.js + ConPTY）。

- **上方用量列**：Claude（5 小時／每週）與 Codex（5 小時／每週）額度、進度條、重置倒數；每 1.5～2 分鐘自動更新，⟳ 手動更新。尚未登入時卡片改顯示「登入」按鈕，按下會開一個 Terminal 分頁執行 `claude auth login`／`codex login`，完成後自動重新讀取額度。
- **正在播放**：右上角顯示 Windows 媒體控制目前的媒體（Spotify、瀏覽器等）的封面、歌名與歌手，可上一首／播放暫停／下一首；沒有媒體時隱藏。封面由 `src/media-cover.cs` 讀取，第一次啟動時以內建的 .NET Framework `csc.exe` 編譯到 `%APPDATA%\AI Tools Terminal\media`。
- **啟動時自動更新**：每次開啟都在背景執行 `claude update` 與 `codex update`，版本顯示在額度卡片的方案下方（更新中／已更新／失敗）。更新期間按開新對話會等更新完成才啟動。
- **一鍵開新對話**：選擇工作資料夾後按「＋ Claude Code」或「＋ Codex」，每個對話一個分頁。
- **自動命名**：分頁名稱取自 Claude Code／Codex 根據對話內容產生的主題（終端機標題），並附上作業資料夾名稱；尚未產生前先顯示資料夾名稱。雙擊名稱、在分頁按右鍵或按卡片上的 ✎ 可改名，清空後恢復自動名稱。
- **自動信任資料夾**：在新資料夾開啟時，自動選擇 Claude 的「Yes, I trust this folder」與 Codex 的「Trust and continue」。
- **右下 Git 面板**：目前分頁（或選定資料夾）是 git 儲存庫時自動出現，顯示分支、未提交變更與提交樹（含分支、遠端、標籤），每 4 秒自動更新；符合 .gitignore 的檔案（包含已被追蹤的）不會列出。點提交、變更檔案或「未提交變更」會在中間顯示提交資訊與差異內容（Esc 關閉）；按 ▾ 收起成右下角的一條（點一下展開），與上方工作狀況之間的分隔線可拖拉調整高度。
  - **拉取／推送**：按鈕上的數字是落後／領先的提交數；新分支第一次推送會自動 `push -u origin <分支>`。
  - **提交**：勾選要提交的檔案（預設全選），輸入訊息後按「提交」或 `Ctrl+Enter`，只會提交勾選的檔案。
- **右側工作狀況**：依 **工作中／等待中／完成** 分組，顯示經過時間、最後指令或回覆；點卡片切換到該對話。對話在背景完成或需要核准時會跳 Windows 通知並閃爍工作列。

## 安裝

僅支援 Windows 10 1809 以上 / Windows 11。

| 項目 | 用途 | 必要 |
|---|---|---|
| Claude Code（`claude`，已登入） | 開 Claude 對話、讀取 Claude 額度 | 要用 Claude 才需要 |
| Codex CLI（`codex`，以 ChatGPT 帳號登入） | 開 Codex 對話、讀取 Codex 額度 | 要用 Codex 才需要 |
| Git | 右下 Git 面板 | 選用 |

### 用安裝包（建議）

執行 `dist\AI-Tools-Terminal-Setup-<版本>.exe`，可選安裝位置，會建立桌面與開始功能表捷徑。不需要另外安裝 Node.js。
安裝包沒有數位簽章，第一次執行時 Windows SmartScreen 會警告，按「其他資訊 → 仍要執行」。

### 更新

- 安裝包版本（0.3.0 起）：在背景從 GitHub Releases 下載新版，右上角出現「⬆ 更新到 v…」，按下立即安裝並重開；不按的話會在關閉 App 時安裝。
- 原始碼版本（`.git` 資料夾存在時）：GitHub 有新 commit 時出現同一個按鈕，按下執行 `git pull --ff-only` 後重開；`package-lock.json` 有變動時會在另一個視窗跑 `npm ci`。有未提交改動或未推送的 commit 時不會更新。

### 從原始碼執行／重新打包

需要 Node.js 20 以上。複製整個資料夾（不含 `node_modules`、`dist`），然後：

```
npm ci           # 依 package-lock.json 安裝（會下載 Electron）
npm start        # 開發模式執行，或雙擊 start.cmd
npm run dist     # 產生 dist\AI-Tools-Terminal-Setup-<版本>.exe
```

發布新版：改 `package.json` 版本、`npm run dist`，再把 `dist` 裡的安裝包、`.blockmap` 與 `latest.yml` 一起上傳到同版本的 GitHub Release（例如 `gh release create v0.3.0 dist\AI-Tools-Terminal-Setup-0.3.0.exe dist\AI-Tools-Terminal-Setup-0.3.0.exe.blockmap dist\latest.yml`）。少了 `latest.yml`，已安裝的 App 不會偵測到新版。

設定（最近資料夾、協作限制）存在 `%APPDATA%\AI Tools Terminal\config.json`，不會跟著專案搬，新電腦會用預設值。

## 狀態偵測方式

| | 工作中 | 等待中 | 完成 |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` hook | 剛開啟、`Notification` hook（權限確認／閒置） | `Stop` hook |
| Codex | session log `task_started` | 剛開啟、畫面出現核准提示 | `task_complete`／`turn_aborted` |

- Claude 的 hook 以 Windows 內建的 `curl.exe` 回報，透過 `--settings` 只注入給本程式開的對話，不會修改 `~/.claude/settings.json`；同一份設定也會在這些對話裡停用 `usage-bars` 額度列（上方已顯示）。
- Codex 從 `~/.codex/sessions/` 對應的 rollout 檔即時讀取事件；核准提示沒有寫入 log，因此以畫面文字判斷。

## AI 協作

本程式開啟的每個對話都會自動掛上 `aitt` MCP 服務（`src/mcp-bridge.js`），提供兩個工具：

- `list_sessions`：列出其他對話（id、名稱、資料夾、狀態）
- `ask_session(session_id, message)`：把訊息貼進另一個對話，等它這一回合完成，回傳它的最後回覆

例如對 Claude 說「寫完後請用 ask_session 請 Codex review」。對方忙碌時會排隊，等它閒下來才送出。右側卡片會顯示 `⇄ 正在詢問…` 和 `⇄ 正在回覆…的請求`。

防止無限輪巡的限制（`src/collab.js`，由程式強制，AI 無法繞過；可在右上「⇄ 協作」調整）：

| 限制 | 預設 | 說明 |
|---|---|---|
| 禁止循環 | 永遠 | 不能詢問正在等自己回覆的對話（包含間接的 A→B→C→A） |
| 每回合最多詢問 | 3 次 | 只有你在該對話按 Enter，或它收到新請求時才重新計算 |
| 最多轉介層數 | 2 層 | A→B→C 可以，C 不能再轉問 |
| 等待逾時 | 10 分鐘 | 超過就放棄並回報 |
| 總開關／停止全部 | — | 關閉協作或按「停止所有進行中的協作」立即中止 |

Codex 因為用了 `-c` 設定覆寫，會以獨立模式執行（啟動時有一則「Running without the shared background server」警告），這是讓每個對話能被正確識別的必要條件。

## 用量來源

- Claude：`~/.claude/.credentials.json` 的 OAuth 權杖呼叫 `api.anthropic.com/api/oauth/usage`（非公開 API，未來可能變動）。
- Codex：`codex app-server` 的 `account/rateLimits/read`，失敗時改讀最近一份 session log；對話進行中也會即時更新。

## 快捷鍵

- 滑鼠拖曳選取文字（Codex 也可以），右鍵選單：複製／貼上／全選／清除畫面
- `Ctrl+C`（有選取時）、`Ctrl+Shift+C`、`Ctrl+Insert` 複製；`Ctrl+V`、`Ctrl+Shift+V`、`Shift+Insert` 貼上（剪貼簿沒有文字時交給 CLI 貼圖片）
- `Shift+Enter` 換行不送出
- `Ctrl+Tab`／`Ctrl+Shift+Tab` 切換分頁、中鍵關閉分頁
