# progress（任務進度條）

同時開多個 session 各跑各的任務時，在輸入框上方看到每個 session **正在執行的任務**做到幾成、約剩幾分鐘，免得逐一切換視窗查看。

## 安裝

**需要 Claude Code（付費方案）；Codex 免費版不能安裝。** 還沒裝 Claude Code，見[官方安裝說明](https://code.claude.com/docs/zh-TW/setup)。

本 Mod 另需 Claude Code **v2.1.287 以上**（Mods 的 API 仍屬 early access，也就是搶先體驗版，引擎更新可能使 Mod 失效）。查版本，會顯示像 `2.1.292 (Claude Code)` 的一行；版本太舊就執行 `claude update`：

```bash
claude --version
```

Windows：Windows 版 Claude Code 也能安裝；本 Mod 不呼叫外部指令，不需另裝工具（作者尚未在 Windows 實機測試）。

下面兩行指令貼在**終端機**（Mac：「終端機」App；Windows：PowerShell），貼上後按 Enter；不是貼在 Claude Code 的對話框。已經在 Claude Code 對話框裡的話，改打 `/plugin marketplace add …` 與 `/plugin install …`（去掉開頭的 `claude`，改成斜線）。

```bash
claude plugin marketplace add SynchronicEros/claude-code-progress-zh
```

```bash
claude plugin install progress@claude-code-progress-zh
```

安裝時若出現英文訊息「SSH not configured, cloning via HTTPS」或「userConfig options not yet set」，可以忽略（沒設定就用預設值）。

裝好後要**開新的 session（一次新對話）**才會生效：終端機版先打 `/exit` 離開，再打 `claude`；桌面版開一個新對話。

**總目錄與單一 repo 二擇一**：同一個 Mod 或 skill 只從一處安裝（skill 兩處都裝會出現兩份）。用 `claude plugin list` 檢查；若同時看到 `progress@claude-code-progress-zh` 與 `progress@claude-code-mods-zh`，移除其中一份：

```bash
claude plugin uninstall progress@claude-code-mods-zh
```

全部 Mod 與 skill 見總目錄 [claude-code-mods-zh](https://github.com/SynchronicEros/claude-code-mods-zh)。

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

**Install / License (English):** Requires Claude Code (a paid plan); the free Codex tier cannot install it. Claude Code v2.1.287+ (check with `claude --version`); works on Windows without extra tools (not yet tested there). `claude plugin marketplace add SynchronicEros/claude-code-progress-zh`, then `claude plugin install progress@claude-code-progress-zh`; takes effect in new sessions. Install from either this repo or the index, not both. All mods and skills: [claude-code-mods-zh](https://github.com/SynchronicEros/claude-code-mods-zh). MIT.
