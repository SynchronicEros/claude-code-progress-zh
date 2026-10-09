# progress（任務進度條）

同時開多個 session 各跑各的任務時，在輸入框上方看到每個 session **正在執行的任務**做到幾成、約剩幾分鐘，免得逐一切換視窗查看。

## 安裝

**需要 Claude Code（付費方案）；Codex 免費版不能安裝。**

本 Mod 另需 Claude Code **v2.1.287 以上**（Mods API 仍屬 early access，引擎更新可能使 Mod 失效）。查版本：

```bash
claude --version
```

Windows：Windows 版 Claude Code 也能安裝；本 Mod 不呼叫外部指令，不需另裝工具（作者尚未在 Windows 實機測試）。

```bash
claude plugin marketplace add SynchronicEros/claude-code-progress-zh
```

```bash
claude plugin install progress@claude-code-progress-zh
```

安裝或更新後，**新開的 session 才會生效**。全部 Mod 與 skill 一起管理，見總目錄 [claude-code-mods-zh](https://github.com/SynchronicEros/claude-code-mods-zh)。

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

**Install / License (English):** Requires Claude Code (a paid plan); the free Codex tier cannot install it. Claude Code v2.1.287+ (check with `claude --version`); works on Windows without extra tools (not yet tested there). `claude plugin marketplace add SynchronicEros/claude-code-progress-zh`, then `claude plugin install progress@claude-code-progress-zh`; takes effect in new sessions. All mods and skills: [claude-code-mods-zh](https://github.com/SynchronicEros/claude-code-mods-zh). MIT.
