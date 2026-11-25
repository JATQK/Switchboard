/**
 * Prompt snippets in VS Code: the "Snippets" view, an editor for a snippet's text (a `switchboard-snippet:` document
 * that saves back into the store), and the actions (insert into Claude Code, new chat, queue, copy, slash command).
 */
import { watch, type FSWatcher } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { insertIntoChat, newChat } from './claudeCode';
import { defaultConfigDir, snippetsFile } from './paths';
import type { Queues } from './queuesView';
import { expandSnippet, loadSnippets, newSnippet, saveSnippets, suggestName, toSlashCommand, variablesIn, writeSlashCommand, type Snippet } from './snippets';
import type { Switchboard } from './switchboard';
import { recentPrompts } from './transcripts';

const SCHEME = 'switchboard-snippet';

export class SnippetStore implements vscode.Disposable {
  private list: Snippet[] = [];
  private watcher: FSWatcher | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly file = snippetsFile();

  async start(): Promise<void> {
    await this.reload();
    try {
      // Other windows (or the user, by hand) may change the file.
      this.watcher = watch(path.dirname(this.file), (_e, name) => {
        if (name?.toString() === path.basename(this.file)) void this.reload();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // folder doesn't exist yet; it is created on the first save
    }
  }

  private async reload(): Promise<void> {
    this.list = await loadSnippets(this.file);
    this.changed.fire();
  }

  get all(): Snippet[] {
    return this.list;
  }

  get(id: string): Snippet | undefined {
    return this.list.find((s) => s.id === id);
  }

  async update(fn: (list: Snippet[]) => Snippet[]): Promise<void> {
    this.list = fn(await loadSnippets(this.file));
    await saveSnippets(this.file, this.list);
    if (!this.watcher) await this.start();
    this.changed.fire();
  }

  dispose(): void {
    this.watcher?.close();
    this.changed.dispose();
  }
}

/** `switchboard-snippet:/<id>/<name>.md`: a snippet's text as an editable document. */
class SnippetFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly store: SnippetStore) {}

  static uri(s: Snippet): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${s.id}/${s.name.replace(/[\\/:*?"<>|]/g, '-')}.md` });
  }

  private snippet(uri: vscode.Uri): Snippet {
    const s = this.store.get(uri.path.split('/')[1] ?? '');
    if (!s) throw vscode.FileSystemError.FileNotFound(uri);
    return s;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const s = this.snippet(uri);
    return { type: vscode.FileType.File, ctime: s.createdAt, mtime: s.updatedAt, size: Buffer.byteLength(s.text) };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return Buffer.from(this.snippet(uri).text, 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const id = this.snippet(uri).id;
    const text = Buffer.from(content).toString('utf8');
    await this.store.update((list) => list.map((s) => (s.id === id ? { ...s, text, updatedAt: Date.now() } : s)));
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

class SnippetsTree implements vscode.TreeDataProvider<Snippet> {
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(private readonly store: SnippetStore) {
    this.onDidChangeTreeData = store.onDidChange;
  }

  getChildren(): Snippet[] {
    return [...this.store.all].sort((a, b) => a.name.localeCompare(b.name));
  }

  getTreeItem(s: Snippet): vscode.TreeItem {
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.id = s.id;
    item.description = s.description || suggestName(s.text, 60);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${s.name.replace(/[*_`[\]]/g, '\\$&')}**\n\n`);
    md.appendCodeblock(s.text.length > 1500 ? `${s.text.slice(0, 1500)}…` : s.text, 'markdown');
    md.appendMarkdown('\nClick to insert into Claude Code.');
    item.tooltip = md;
    item.iconPath = new vscode.ThemeIcon(variablesIn(s.text).inputs.length ? 'symbol-variable' : 'symbol-snippet');
    item.contextValue = 'snippet';
    item.command = { command: 'switchboard.snippets.insert', title: 'Insert into Claude Code', arguments: [s.id] };
    return item;
  }
}

const idFrom = (arg: unknown): string | undefined =>
  typeof arg === 'string' ? arg : typeof arg === 'object' && arg !== null && typeof (arg as Snippet).id === 'string' ? (arg as Snippet).id : undefined;

export class Snippets implements vscode.Disposable {
  readonly store = new SnippetStore();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly sb: Switchboard,
    private readonly queues: Queues,
  ) {
    this.subs.push(
      this.store,
      vscode.workspace.registerFileSystemProvider(SCHEME, new SnippetFs(this.store), { isCaseSensitive: true }),
      vscode.window.registerTreeDataProvider('switchboard.snippets', new SnippetsTree(this.store)),
    );
  }

  start(): Promise<void> {
    return this.store.start();
  }

  // ------------------------------------------------------------ picking & filling in

  async pick(title = 'Snippets'): Promise<Snippet | undefined> {
    type Item = vscode.QuickPickItem & { snippet?: Snippet; create?: boolean };
    const items: Item[] = [...this.store.all]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ label: s.name, description: s.description, detail: suggestName(s.text, 100), snippet: s }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(add) New snippet…', create: true });
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: this.store.all.length ? 'Pick a snippet' : 'No snippets yet', matchOnDetail: true });
    if (pick?.create) {
      await this.create();
      return undefined;
    }
    return pick?.snippet;
  }

  /** The snippet's text with its variables filled in; undefined if the user cancels. */
  async expand(s: Snippet): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    const needs = variablesIn(s.text).context;
    return expandSnippet(s.text, {
      selection: editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '',
      file: editor ? vscode.workspace.asRelativePath(editor.document.uri) : '',
      clipboard: needs.includes('clipboard') ? await vscode.env.clipboard.readText() : '',
      ask: async (q) => vscode.window.showInputBox({ title: s.name, prompt: q, ignoreFocusOut: true }),
    });
  }

  /** For the queue view's "Snippet…" button. */
  async pickText(): Promise<string | undefined> {
    const s = await this.pick('Insert a snippet into the task');
    return s ? this.expand(s) : undefined;
  }

  private async resolve(arg: unknown, title: string): Promise<Snippet | undefined> {
    const id = idFrom(arg);
    return id ? this.store.get(id) : this.pick(title);
  }

  // ------------------------------------------------------------ actions

  async insert(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Insert a snippet into Claude Code');
    const text = s && (await this.expand(s));
    if (!text) return;
    const how = await insertIntoChat(text);
    if (how === 'newChat') void vscode.window.setStatusBarMessage('$(comment-discussion) Started a Claude Code chat with the snippet', 4000);
  }

  async newChat(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Start a Claude Code chat with a snippet');
    const text = s && (await this.expand(s));
    if (text) await newChat(text);
  }

  async enqueue(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Add a snippet to a queue');
    const text = s && (await this.expand(s));
    if (text) await this.queues.addTask(undefined, text);
  }

  async copy(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Copy a snippet');
    const text = s && (await this.expand(s));
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage('$(check) Snippet copied', 3000);
  }

  /** Writes the snippet as a Claude Code custom command into the default config dir (shared by every account). */
  async saveAsCommand(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Save a snippet as a Claude Code slash command');
    if (!s) return;
    const cmd = toSlashCommand(s, path.join(defaultConfigDir(), 'commands'));
    if (cmd.unsupported.length) {
      const ok = await vscode.window.showWarningMessage(
        `Slash commands can't fill in ${cmd.unsupported.join(', ')}; ${cmd.unsupported.length === 1 ? 'it stays' : 'they stay'} as plain text. Save anyway?`,
        { modal: true },
        'Save',
      );
      if (ok !== 'Save') return;
    }
    let result = await writeSlashCommand(cmd, false);
    if (result === 'exists') {
      const ok = await vscode.window.showWarningMessage(`/${cmd.name} already exists. Replace it?`, { modal: true, detail: cmd.file }, 'Replace');
      if (ok !== 'Replace') return;
      result = await writeSlashCommand(cmd, true);
    }
    const pick = await vscode.window.showInformationMessage(
      `Saved as /${cmd.name}. Type it in Claude Code (chat or terminal)${variablesIn(s.text).inputs.length ? ' followed by your text' : ''}; new sessions pick it up.`,
      'Open File',
    );
    if (pick) await vscode.window.showTextDocument(vscode.Uri.file(cmd.file));
  }

  async create(text?: string): Promise<void> {
    const body = text ?? '';
    const name = await vscode.window.showInputBox({
      title: 'New snippet',
      prompt: 'Name',
      value: body ? suggestName(body) : '',
      validateInput: (v) => (v.trim() ? undefined : 'Give the snippet a name'),
    });
    if (!name?.trim()) return;
    const s = newSnippet(name, body || 'Describe the task here. Variables: ${selection}, ${file}, ${clipboard}, ${input:Question}');
    await this.store.update((list) => [...list, s]);
    // Without text yet, open it for writing.
    if (!body) await this.edit(s.id);
    else void vscode.window.setStatusBarMessage(`$(check) Saved snippet "${s.name}"`, 3000);
  }

  async createFromSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const text = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
    if (!text.trim()) {
      void vscode.window.showInformationMessage('Select the text to save as a snippet first.');
      return;
    }
    await this.create(text);
  }

  /** Saves one of the prompts you sent Claude Code in this folder. */
  async createFromHistory(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const prompts = cwd ? await recentPrompts(this.sb.configDirs(), cwd) : [];
    if (!prompts.length) {
      void vscode.window.showInformationMessage('No Claude Code prompts found for this folder yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      prompts.map((p) => ({ label: suggestName(p, 80), detail: p.length > 200 ? `${p.slice(0, 200)}…` : p, text: p })),
      { title: 'Save a recent prompt as a snippet', matchOnDetail: true, placeHolder: 'Your prompts in this folder, newest first' },
    );
    if (pick) await this.create(pick.text);
  }

  async edit(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Edit a snippet');
    if (s) await vscode.window.showTextDocument(SnippetFs.uri(s), { preview: false });
  }

  async rename(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Rename a snippet');
    if (!s) return;
    const name = await vscode.window.showInputBox({ title: 'Rename snippet', value: s.name, validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty') });
    if (name?.trim()) await this.store.update((list) => list.map((x) => (x.id === s.id ? { ...x, name: name.trim(), updatedAt: Date.now() } : x)));
  }

  async describe(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Describe a snippet');
    if (!s) return;
    const description = await vscode.window.showInputBox({ title: `Description of "${s.name}"`, value: s.description ?? '', prompt: 'Shown next to the name' });
    if (description !== undefined) await this.store.update((list) => list.map((x) => (x.id === s.id ? { ...x, description: description.trim() || undefined } : x)));
  }

  async remove(arg?: unknown): Promise<void> {
    const s = await this.resolve(arg, 'Delete a snippet');
    if (!s) return;
    const ok = await vscode.window.showWarningMessage(`Delete the snippet "${s.name}"?`, { modal: true }, 'Delete');
    if (ok === 'Delete') await this.store.update((list) => list.filter((x) => x.id !== s.id));
  }

  /** Quick pick: a snippet, then what to do with it. */
  async use(): Promise<void> {
    const s = await this.pick('Use a snippet');
    if (!s) return;
    const actions: (vscode.QuickPickItem & { run: () => Promise<void> })[] = [
      { label: '$(insert) Insert into Claude Code', description: 'into the chat in front, or a new one', run: () => this.insert(s.id) },
      { label: '$(comment-discussion) New Claude Code chat with it', run: () => this.newChat(s.id) },
      { label: '$(list-ordered) Add to a queue…', description: 'Claude Code chats work through it', run: () => this.enqueue(s.id) },
      { label: '$(copy) Copy', run: () => this.copy(s.id) },
      { label: '$(terminal) Save as slash command', description: `/${toSlashCommand(s, '').name}`, run: () => this.saveAsCommand(s.id) },
      { label: '$(pencil) Edit text', run: () => this.edit(s.id) },
    ];
    const pick = await vscode.window.showQuickPick(actions, { title: s.name, placeHolder: 'What should happen with the snippet?' });
    await pick?.run();
  }

  async openFile(): Promise<void> {
    if (!this.store.all.length) await this.store.update((l) => l);
    await vscode.window.showTextDocument(vscode.Uri.file(this.store.file));
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }
}
