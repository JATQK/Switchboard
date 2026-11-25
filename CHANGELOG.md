# Changelog

## 0.4.0 (2026-11-25)

Public preview.

### Accounts

- Each Claude account is a Claude Code config folder (`CLAUDE_CONFIG_DIR`). Logins are created and kept by Claude Code itself; Switchboard never reads, stores, or sends credentials and makes no network requests.
- Overview of every account's 5-hour session and 7-day weekly usage, from Claude Code's status line data ("live usage"), usage limits hit in running chats (including panel chats), or Claude Code's own usage cache. Cards show how old the numbers are.
- One-click switching for new Claude Code sessions: VS Code terminals, the Claude Code extension, and, through a shell snippet, external terminals. The active account is shared by all VS Code windows.
- Auto-switch with session and weekly thresholds, a cooldown, per-account skipping, and three strategies: `mostHeadroom`, `priority`, `soonestWeeklyReset`.
- **Move running chats.** A running chat keeps the account it started with. After a switch, Switchboard offers to move chats that still run on the previous account: it waits until each is idle, ends its process, and the conversation continues on the new account (panel chats with your next message, terminal chats in a new terminal). Setting: `switchboard.moveChatsOnSwitch` (`ask`, `always`, `never`).
- New accounts share your settings, `CLAUDE.md`, skills, agents, commands, plugins and project history through links, so `claude --continue` works across accounts.

### Queues

- Lists of tasks that real Claude Code chats work through, one turn per task in the same conversation. When a queue is empty, its chats wait and start again as soon as you add a task.
- **Start chats…** opens one or more chats for a queue: in an editor tab (fully automatic, with the model and permission mode you pick) or in the Claude Code panel (press Enter once for the first task). Several chats share a queue's tasks.
- **Add a chat…** lets a chat that is already running work on a queue.
- A chat follows one or more queues in order and moves on to the next when one runs dry, keeping its context. The **Chats** section shows what each chat is doing; reorder, unfollow or pause.
- Each task shows which chat ran it and Claude's answer; copy one, or all of a queue's answers as Markdown.
- Uses a background Stop hook (Claude Code's `asyncRewake`) that Switchboard adds to Claude Code's settings only while a queue needs it, after asking once. It never holds up a turn or interrupts a chat you are talking to.

### Snippets and copying

- **Snippets**: saved prompts with `${selection}`, `${file}`, `${clipboard}` and `${input:Question}` variables. Insert one into the Claude Code chat in front, start a new chat with it, add it to a queue, copy it, or save it as a Claude Code slash command. Save one of your recent prompts as a snippet.
- **Copy from Claude Code**: the last answer, last prompt, resume command or a link of a conversation in the open folder.
