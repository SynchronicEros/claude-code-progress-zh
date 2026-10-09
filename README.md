# progress（任務進度條）

同時開多個 session 各跑各的任務時，在輸入框上方看到每個 session **正在執行的任務**做到幾成、約剩幾分鐘，免得逐一切換視窗查看。

## 安裝

在 Claude Code 裡貼上這段話：

> 請幫我安裝 https://github.com/SynchronicEros/claude-code-mods-zh 裡的 progress（照該 README「給協助安裝的 AI」一節），遇到問題幫我處理，裝好告訴我怎麼讓它生效。

要更新時說「請幫我把 progress 更新到最新版」。

<details>
<summary>給協助安裝的 AI</summary>

- 需要 Claude Code（付費方案）；只有 Codex 的使用者無法安裝。
- 安裝（user scope，在終端機或 Bash 工具執行）：`claude plugin marketplace add SynchronicEros/claude-code-mods-zh`，再 `claude plugin install progress@claude-code-mods-zh`。
- 更新：`claude plugin marketplace update claude-code-mods-zh`，再 `claude plugin update progress@claude-code-mods-zh`；顯示 already at the latest version 即為最新。
- 一律保留總目錄那份；若同時裝了 `progress@claude-code-progress-zh`，執行 `claude plugin uninstall progress@claude-code-progress-zh`。
- 安裝或更新後須開新的 session 才生效（終端機版 `/exit` 後重打 `claude`；桌面版開新對話）。桌面版 Code 分頁不能用 `/plugin` 指令。
- 需要 Claude Code v2.1.287 以上（`claude --version` 查詢，太舊執行 `claude update`）。

</details>

## 畫面

- 每列＝專案名＋任務名（取你交代那句話的前段）＋百分比＋「剩約 N 分」；本 session 標 ★。
- 最多 3 列，其餘折成「另 N 個執行中」；名稱依實際欄寬截斷（中文算 2 格）。
- 顏色：藍＝執行中；黃＝等你回應（「等待裁定」＝選項或計畫核准對話框、「等待授權」＝權限對話框）；紅＝回合因 API 錯誤或模型拒答結束，留到該 session 下個任務開始。
- 任務完成、你自行中斷、或 session 逾 20 秒沒有心跳（程序被關掉），就不再顯示。

## 百分比怎麼來

- Claude 有待辦清單（至少 2 項）時，以完成比例為準。
- 否則由 Mod 以分身（共用 prompt cache）估「整個任務完成幾成」：第一步、其後每 3 步或每 1 分鐘重估一次；只升不降，執行中上限 95%。
- 子代理的工具呼叫不計入主任務。

## 額度與資料

- 每個任務多花分身呼叫：短任務約 2–3 次，長任務約每分鐘 1 次；等你回應時不重估。
- 各 session 狀態寫在 `~/.claude/claude-mods-data/progress/<session id>.json`（有設 `CLAUDE_CONFIG_DIR` 時改在該目錄下，不同設定目錄的 session 互不顯示），12 小時無更新者不再讀取。只看得到本機的 session。

## 限制

Mod API 屬 early access；百分比為估計值。

## 授權

MIT（見 [LICENSE](LICENSE)）。

---

**English:** A band above the prompt listing every local session's running task with percent done and minutes left. Percent comes from Claude's todo list when there is one, otherwise from a forked estimate (first step, then every 3 steps or minute; never decreases; capped at 95% while running). Blue = running, yellow = waiting for you, red = ended on an API error or refusal. Costs about 2–3 forks per short task and about one per minute on long ones. State files live under `~/.claude/claude-mods-data/progress/`.

**Install / License (English):** Requires Claude Code (a paid plan). Ask Claude Code to install `progress` from https://github.com/SynchronicEros/claude-code-mods-zh, or run `claude plugin marketplace add SynchronicEros/claude-code-mods-zh`, then `claude plugin install progress@claude-code-mods-zh`; takes effect in new sessions. MIT.
