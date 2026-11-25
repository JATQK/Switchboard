import { watch, type FSWatcher } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Applier } from './applier';
import { decide, type Candidate, type Strategy } from './autoSwitch';
import { latestLimitHit, readRunningChats, withLimitHit, type RunningChat } from './chats';
import { newest, readConfigSnapshot, readStatusDump, type StatusDump } from './claudeData';
import { authStatus, claudeTerminalOptions, findClaudeExecutable, runClaude, type AuthStatus } from './cli';
import { formatDuration } from './format';
import { exists } from './fsutil';
import { Mutex } from './mutex';
import { configDirOf, defaultConfigDir, globalConfigFileOf, isInside, pathKey, profilesRoot, switchboardHome } from './paths';
import { DEFAULT_ID, defaultProfile, loadProfiles, loadState, newProfileId, saveProfiles, saveState, slugify, type SharedState } from './profiles';
import { removeProfileDir, seedGlobalConfig, shareConfig } from './sharing';
import * as statusline from './statusline';
import { effectivePct, planLabel, upcomingReset } from './usage';
import type { Profile, ProfileStatus, UsageReading, UsageWindow } from './types';

/** Usage of the active account older than this is not trusted for switching away. */
const ACTIVE_STALE_MS = 30 * 60_000;
/** How long a `claude auth status` answer is reused. */
const AUTH_TTL_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const BANNER_DISMISSED_KEY = 'switchboard.liveUsageBannerDismissed';

export interface Settings {
  autoSwitch: {
    enabled: boolean;
    sessionThreshold: number;
    weeklyThreshold: number;
    strategy: Strategy;
    cooldownMinutes: number;
    notify: boolean;
  };
  /** What to do with chats still running on the previous account after a switch. */
  moveChats: 'ask' | 'always' | 'never';
  refreshIntervalSeconds: number;
  statusBar: boolean;
  applyToClaudeCodeExtension: boolean;
  shareConfig: boolean;
  claudePath: string;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('switchboard');
  return {
    autoSwitch: {
      enabled: c.get('autoSwitch.enabled', false),
      sessionThreshold: c.get('autoSwitch.sessionThreshold', 90),
      weeklyThreshold: c.get('autoSwitch.weeklyThreshold', 95),
      strategy: c.get<Strategy>('autoSwitch.strategy', 'mostHeadroom'),
      cooldownMinutes: c.get('autoSwitch.cooldownMinutes', 5),
      notify: c.get('autoSwitch.notify', true),
    },
    moveChats: c.get<Settings['moveChats']>('moveChatsOnSwitch', 'ask'),
    refreshIntervalSeconds: Math.max(5, c.get('refreshIntervalSeconds', 15)),
    statusBar: c.get('statusBar.enabled', true),
    applyToClaudeCodeExtension: c.get('applyToClaudeCodeExtension', true),
    shareConfig: c.get('shareConfig', true),
    claudePath: c.get('claudePath', ''),
  };
}

export interface WindowView {
  pct: number;
  resetsAt?: string;
}

export interface AccountView {
  id: string;
  label: string;
  email?: string;
  organizationName?: string;
  plan?: string;
  isDefault: boolean;
  configDir: string;
  active: boolean;
  excluded: boolean;
  loggedIn?: boolean;
  usageAt?: number;
  usageSource?: UsageReading['source'];
  session?: WindowView;
  weekly?: WindowView;
  /** Claude Code chats running on this account right now. */
  chats: number;
}

export interface SwitchEvent {
  fromId: string;
  toId: string;
  source: 'manual' | 'auto';
  /** Why auto-switch moved, e.g. "session usage at 93%". */
  reason?: string;
}

export interface ViewState {
  accounts: AccountView[];
  activeId: string;
  auto: Settings['autoSwitch'];
  refreshing: boolean;
  lastRefresh?: number;
  liveUsage: statusline.LiveUsageState;
  showLiveUsageBanner: boolean;
  claudeFound: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function windowView(w: UsageWindow | undefined, now: number): WindowView | undefined {
  const pct = effectivePct(w, now);
  return pct === undefined ? undefined : { pct, resetsAt: upcomingReset(w, now) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Switchboard implements vscode.Disposable {
  /** Starts with just the default profile so the UI can render before start() has read the registry. */
  private profiles: Profile[] = [defaultProfile()];
  private state: SharedState = { activeId: DEFAULT_ID, switchedAt: 0, manualHold: false };
  private readonly statuses = new Map<string, ProfileStatus>();
  /** Chats running on each account (by profile id), as of the last refresh. */
  private chats = new Map<string, RunningChat[]>();
  private readonly authCache = new Map<string, { at: number; status?: AuthStatus }>();
  private liveUsage: statusline.LiveUsageState = 'off';
  private claudePath: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private watchers: FSWatcher[] = [];
  private watchKey = '';
  private debounce: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private refreshing = false;
  private lastRefresh: number | undefined;
  private appliedKey: string | undefined;
  private readonly lock = new Mutex();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly switched = new vscode.EventEmitter<SwitchEvent>();
  /** Fires after the active account changed in this window. */
  readonly onDidSwitch = this.switched.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly applier: Applier,
    private readonly log: vscode.LogOutputChannel,
    private readonly memento: vscode.Memento,
  ) {
    this.subs.push(
      this.changed,
      this.switched,
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (!e.affectsConfiguration('switchboard')) return;
        if (e.affectsConfiguration('switchboard.refreshIntervalSeconds')) this.schedule();
        if (e.affectsConfiguration('switchboard.claudePath')) this.claudePath = await findClaudeExecutable(readSettings().claudePath);
        if (e.affectsConfiguration('switchboard.applyToClaudeCodeExtension')) {
          this.appliedKey = undefined;
          await this.applyActive();
        }
        this.changed.fire();
        if (e.affectsConfiguration('switchboard.autoSwitch')) void this.evaluateAutoSwitch();
      }),
    );
  }

  async start(): Promise<void> {
    await fs.mkdir(profilesRoot(), { recursive: true });
    await statusline.ensureScripts().catch((err) => this.log.warn(`Could not write status line script: ${message(err)}`));
    this.claudePath = await findClaudeExecutable(readSettings().claudePath);
    this.log.info(this.claudePath ? `Using Claude Code at ${this.claudePath}` : 'Claude Code executable not found; login status comes from config files only');
    await this.reload();
    await this.applyActive();
    this.schedule();
    await this.refresh(true);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watchers.forEach((w) => w.close());
    this.subs.forEach((d) => d.dispose());
  }

  // ---------------------------------------------------------------- state

  private profile(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  private get active(): Profile {
    return this.profile(this.state.activeId) ?? this.profiles.find((p) => p.isDefault)!;
  }

  getProfile(id: string): Profile | undefined {
    return this.profile(id);
  }

  /** The account new Claude Code sessions use (config dir undefined = Claude Code's default). */
  activeAccount(): { id: string; label: string; configDir?: string } {
    const p = this.active;
    return { id: p.id, label: p.label, configDir: p.isDefault ? undefined : p.configDir };
  }

  /** Every account's config dir, active one first (transcripts can be in any of them). */
  configDirs(): string[] {
    return [...new Set([configDirOf(this.active), ...this.profiles.map(configDirOf)])];
  }

  /** Interactive chats running on an account, as of the last refresh. */
  chatsOn(id: string): RunningChat[] {
    return (this.chats.get(id) ?? []).filter((c) => c.kind === 'interactive');
  }

  /** Every account with its folder, for reading what runs on it right now. */
  accounts(): { id: string; label: string; configDir: string; isDefault: boolean }[] {
    return this.profiles.map((p) => ({ id: p.id, label: p.label, configDir: configDirOf(p), isDefault: p.isDefault }));
  }

  /** The `claude` executable, or undefined after telling the user it is missing. */
  claudeExecutable(): Promise<string | undefined> {
    return this.requireClaude();
  }

  getState(): ViewState {
    const now = Date.now();
    return {
      accounts: this.profiles.map((p) => {
        const st = this.statuses.get(p.id);
        return {
          id: p.id,
          label: p.label,
          email: st?.account.email,
          organizationName: st?.account.organizationName,
          plan: st?.account.plan,
          isDefault: p.isDefault,
          configDir: configDirOf(p),
          active: p.id === this.active.id,
          excluded: !!p.excluded,
          loggedIn: st?.account.loggedIn,
          usageAt: st?.reading?.at,
          usageSource: st?.reading?.source,
          session: windowView(st?.reading?.usage.session, now),
          weekly: windowView(st?.reading?.usage.weekly, now),
          chats: this.chatsOn(p.id).length,
        };
      }),
      activeId: this.active.id,
      auto: readSettings().autoSwitch,
      refreshing: this.refreshing,
      lastRefresh: this.lastRefresh,
      liveUsage: this.liveUsage,
      showLiveUsageBanner: this.liveUsage !== 'on' && !this.memento.get(BANNER_DISMISSED_KEY, false),
      claudeFound: !!this.claudePath,
    };
  }

  /** Re-reads the profile list and shared state (another window may have changed them). */
  private async reload(): Promise<void> {
    this.profiles = await loadProfiles();
    this.state = await loadState();
    if (!this.profile(this.state.activeId)) this.state.activeId = DEFAULT_ID;
    this.ensureWatchers();
  }

  /** Points new Claude Code sessions at the active profile, if that changed since we last did it. */
  private async applyActive(): Promise<void> {
    const p = this.active;
    const key = `${p.id}|${configDirOf(p)}|${p.label}`;
    if (key === this.appliedKey) return;
    await this.applier.apply(p.isDefault ? undefined : p.configDir, p.label, readSettings().applyToClaudeCodeExtension);
    this.appliedKey = key;
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(false), readSettings().refreshIntervalSeconds * 1000);
  }

  /** Watches Switchboard's own folder (profiles/state from other windows) and every config dir (status dumps). */
  private ensureWatchers(): void {
    const dirs = [switchboardHome(), ...this.profiles.map(configDirOf)];
    const key = dirs.map(pathKey).join('|');
    if (key === this.watchKey) return;
    this.watchKey = key;
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
    for (const dir of dirs) {
      try {
        const w = watch(dir, (_e, file) => {
          const name = file?.toString() ?? '';
          if (name && !/^(profiles|state)\.json$|^switchboard-status\.json$|^\.claude\.json$/.test(name)) return;
          // Claude Code rewrites .claude.json often during a session; batch those into one refresh.
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(() => void this.refresh(false), 2000);
        });
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        // folder doesn't exist (yet); polling covers it
      }
    }
  }

  // ---------------------------------------------------------------- reading usage

  private async readAuth(p: Profile, force: boolean): Promise<AuthStatus | undefined> {
    if (!this.claudePath) return undefined;
    const cached = this.authCache.get(p.id);
    if (!force && cached && Date.now() - cached.at < AUTH_TTL_MS) return cached.status;
    const status = await authStatus(this.claudePath, p.isDefault ? undefined : p.configDir);
    this.authCache.set(p.id, { at: Date.now(), status });
    return status;
  }

  /** Re-reads everything Claude Code wrote. `forceAuth` also re-asks `claude auth status`. */
  refresh(forceAuth = false): Promise<void> {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = (async () => {
      let force = forceAuth;
      do {
        this.pending = false;
        await this.refreshOnce(force);
        force = false;
      } while (this.pending);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private async refreshOnce(forceAuth: boolean): Promise<void> {
    this.refreshing = true;
    this.changed.fire();
    try {
      await this.reload();
      await this.applyActive();

      const dumps = new Map<string, StatusDump>();
      for (const p of this.profiles) {
        const dump = await readStatusDump(configDirOf(p));
        if (dump) dumps.set(p.id, dump);
      }
      this.attributeDefaultDump(dumps);

      // Each account keeps its own list of running chats; their transcripts show when one hits a usage limit, which
      // panel chats report nowhere else (they don't run the status line).
      const chats = new Map<string, RunningChat[]>();
      for (const p of this.profiles) chats.set(p.id, await readRunningChats(configDirOf(p)));
      this.chats = chats;

      for (const p of this.profiles) {
        const snap = await readConfigSnapshot(globalConfigFileOf(p));
        const auth = await this.readAuth(p, forceAuth);
        const loggedIn = auth ? auth.loggedIn : snap.account ? true : false;
        const cached = snap.cached && (!snap.cached.accountUuid || snap.cached.accountUuid === snap.account?.accountUuid) ? snap.cached : undefined;
        this.statuses.set(p.id, {
          account: {
            loggedIn,
            email: snap.account?.email ?? auth?.email,
            organizationName: snap.account?.organizationName ?? auth?.orgName,
            accountUuid: snap.account?.accountUuid,
            plan: planLabel(auth?.subscriptionType),
          },
          reading: loggedIn ? withLimitHit(newest(dumps.get(p.id), cached), await latestLimitHit(this.chatsOn(p.id))) : undefined,
        });
      }

      const files = await statusline.settingsFiles(this.profiles.map(configDirOf));
      this.liveUsage = (await statusline.inspect(files)).state;
      this.lastRefresh = Date.now();
    } catch (err) {
      this.log.error(`Refresh failed: ${message(err)}`);
    } finally {
      this.refreshing = false;
      this.changed.fire();
    }
    await this.evaluateAutoSwitch();
  }

  /**
   * If a status line process didn't inherit CLAUDE_CONFIG_DIR, it writes into the default dir. Its transcript path
   * still names the profile it ran in, so move such a reading to that profile.
   */
  private attributeDefaultDump(dumps: Map<string, StatusDump>): void {
    const def = this.profiles.find((p) => p.isDefault);
    const dump = def && dumps.get(def.id);
    if (!def || !dump?.transcriptPath) return;
    const owner = this.profiles.find((p) => !p.isDefault && isInside(dump.transcriptPath!, p.configDir));
    if (!owner) return;
    dumps.delete(def.id);
    const own = dumps.get(owner.id);
    if (!own || own.at < dump.at) dumps.set(owner.id, dump);
  }

  // ---------------------------------------------------------------- auto-switch

  private candidates(): Candidate[] {
    const now = Date.now();
    const activeId = this.active.id;
    return this.profiles.map((p) => {
      const st = this.statuses.get(p.id);
      const usable = st?.account.loggedIn === true;
      const r = st?.reading;
      return {
        id: p.id,
        order: p.order,
        excluded: p.excluded,
        healthy: usable && !!r && (p.id !== activeId || now - r.at < ACTIVE_STALE_MS),
        unknownUsage: usable && !r,
        session: effectivePct(r?.usage.session, now),
        weekly: effectivePct(r?.usage.weekly, now),
        sessionResetsAt: upcomingReset(r?.usage.session, now),
        weeklyResetsAt: upcomingReset(r?.usage.weekly, now),
      };
    });
  }

  private async evaluateAutoSwitch(): Promise<void> {
    const { autoSwitch } = readSettings();
    if (!autoSwitch.enabled) return;
    if (Date.now() - this.state.switchedAt < autoSwitch.cooldownMinutes * 60_000) return;
    const activeId = this.active.id;
    const decision = decide(activeId, this.candidates(), {
      sessionThreshold: autoSwitch.sessionThreshold,
      weeklyThreshold: autoSwitch.weeklyThreshold,
      strategy: autoSwitch.strategy,
      allowReturn: !this.state.manualHold,
    });

    if (decision.kind === 'switch') {
      try {
        await this.switchTo(decision.targetId, 'auto', decision.reason);
      } catch (err) {
        this.log.error(`Auto-switch to ${this.profile(decision.targetId)?.label ?? 'another account'} failed: ${message(err)}`);
      }
    } else if (decision.kind === 'exhausted') {
      await this.lock.run(async () => {
        this.state = await loadState();
        if (this.state.exhaustedNotice === activeId) return; // already warned (maybe by another window)
        this.state.exhaustedNotice = activeId;
        await saveState(this.state);
        const when = decision.nextResetAt ? ` Next reset in ${formatDuration(Date.parse(decision.nextResetAt) - Date.now())}.` : '';
        void vscode.window.showWarningMessage(`Switchboard: ${decision.reason}, and no other account has capacity left.${when}`);
      });
    } else if (this.state.exhaustedNotice) {
      await this.lock.run(async () => {
        this.state = await loadState();
        if (!this.state.exhaustedNotice) return;
        this.state.exhaustedNotice = undefined;
        await saveState(this.state);
      });
    }
  }

  // ---------------------------------------------------------------- switching

  /** Makes `id` the account new Claude Code sessions use. Returns false if it already was. */
  async switchTo(id: string, source: 'manual' | 'auto', reason?: string): Promise<boolean> {
    let fromId = this.active.id;
    const switched = await this.lock.run(async () => {
      await this.reload();
      fromId = this.active.id;
      if (this.state.activeId === id) return false;
      const target = this.profile(id);
      if (!target) throw new Error('That account is no longer in Switchboard.');
      if (this.statuses.get(id)?.account.loggedIn === false) throw new Error(`"${target.label}" is not logged in. Log in to it first.`);
      this.state = { activeId: id, switchedAt: Date.now(), manualHold: source === 'manual' };
      await saveState(this.state);
      await this.applyActive();
      this.log.info(`Switched (${source}) to ${target.label}${reason ? ` (${reason})` : ''}`);
      return true;
    });
    this.changed.fire();
    if (switched) this.switched.fire({ fromId, toId: id, source, reason });
    return switched;
  }

  /** New terminal running `claude <args>` with the active account (in `cwd`, if given). */
  async openTerminal(args: string[] = [], cwd?: string): Promise<void> {
    const claude = await this.requireClaude();
    if (!claude) return;
    const p = this.active;
    vscode.window.createTerminal({ ...claudeTerminalOptions(claude, args, p.isDefault ? undefined : p.configDir, `Claude · ${p.label}`), cwd }).show();
  }

  // ---------------------------------------------------------------- live usage (status line)

  async setLiveUsage(on: boolean): Promise<void> {
    const files = await statusline.settingsFiles(this.profiles.map(configDirOf));
    if (on) {
      const { foreign } = await statusline.inspect(files);
      if (foreign.length) {
        const ok = await vscode.window.showWarningMessage(
          'Replace your Claude Code status line?',
          {
            modal: true,
            detail: `Live usage works through Claude Code's status line, and you already have one in:\n${foreign.join('\n')}\n\nIt is saved and restored when you turn live usage off.`,
          },
          'Replace',
        );
        if (ok !== 'Replace') return;
      }
      const { changed, failed } = await statusline.enable(files);
      this.log.info(`Live usage on: ${changed.join(', ') || 'already set'}`);
      if (failed.length) void vscode.window.showWarningMessage(`Switchboard could not update ${failed.join(', ')} (not valid JSON).`);
      void vscode.window.showInformationMessage('Live usage is on. Claude Code sessions report usage after every reply; sessions already running pick it up after a restart.');
    } else {
      const changed = await statusline.disable(files);
      this.log.info(`Live usage off: ${changed.join(', ') || 'nothing to change'}`);
    }
    await this.refresh(false);
  }

  async dismissLiveUsageBanner(): Promise<void> {
    await this.memento.update(BANNER_DISMISSED_KEY, true);
    this.changed.fire();
  }

  // ---------------------------------------------------------------- adding & logging in

  private async requireClaude(): Promise<string | undefined> {
    this.claudePath ??= await findClaudeExecutable(readSettings().claudePath);
    if (this.claudePath) return this.claudePath;
    const choice = await vscode.window.showErrorMessage('Switchboard could not find the `claude` executable. Install Claude Code or set its path.', 'Set Path');
    if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'switchboard.claudePath');
    return undefined;
  }

  /**
   * Runs Claude Code's own `claude auth login` against a config dir and waits until it reports a login.
   * On success the login process is left to finish writing; on cancel/timeout its terminal is closed.
   */
  private async runLogin(claude: string, configDir: string | undefined, email: string | undefined, title: string): Promise<boolean> {
    const globalConfig = configDir ? path.join(configDir, '.claude.json') : globalConfigFileOf({ isDefault: true, configDir: '' });
    const before = (await readConfigSnapshot(globalConfig)).account?.accountUuid;
    const args = ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])];
    const terminal = vscode.window.createTerminal({ ...claudeTerminalOptions(claude, args, configDir, title), isTransient: true });
    terminal.show();
    let closed = false;
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) closed = true;
    });
    const finished = () => closed || terminal.exitStatus !== undefined;
    try {
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Finish signing in to Claude in your browser…', cancellable: true },
        async (_p, cancel) => {
          const deadline = Date.now() + LOGIN_TIMEOUT_MS;
          while (!cancel.isCancellationRequested && Date.now() < deadline) {
            await sleep(1500);
            const acct = (await readConfigSnapshot(globalConfig)).account?.accountUuid;
            if (acct && acct !== before) return true;
            // The login command finished: ask Claude Code whether it worked (also covers re-logging in to the same account).
            if (finished()) return (await authStatus(claude, configDir))?.loggedIn === true;
          }
          return false;
        },
      );
      if (ok) {
        // Let `claude auth login` finish writing everything before anything else touches the folder.
        for (let i = 0; i < 20 && !finished(); i++) await sleep(500);
      } else {
        terminal.dispose();
        await sleep(1000); // give the process time to exit and release its files (Windows)
      }
      return ok;
    } finally {
      sub.dispose();
    }
  }

  /** Deletes a half-created profile folder; failures are logged, not thrown. */
  private async discardProfileDir(dir: string): Promise<void> {
    try {
      await removeProfileDir(dir, profilesRoot());
    } catch (err) {
      this.log.warn(`Could not remove ${dir}: ${message(err)}. You can delete it by hand.`);
    }
  }

  async loginNewAccount(): Promise<void> {
    const claude = await this.requireClaude();
    if (!claude) return;
    const email = await vscode.window.showInputBox({
      title: 'Add a Claude account',
      prompt: 'Email of the account (optional; it pre-fills the sign-in page). In the browser, sign in as this account.',
      placeHolder: 'name@example.com',
      ignoreFocusOut: true,
    });
    if (email === undefined) return;

    await this.reload();
    const base = slugify(email.split('@')[0] || 'account');
    let dir = path.join(profilesRoot(), base);
    for (let n = 2; (await exists(dir)) || this.profiles.some((p) => pathKey(configDirOf(p)) === pathKey(dir)); n++) dir = path.join(profilesRoot(), `${base}-${n}`);
    await fs.mkdir(dir, { recursive: true });

    try {
      if (readSettings().shareConfig) {
        const shared = await shareConfig(dir, defaultConfigDir());
        if (shared.copied.length) this.log.warn(`Could not link ${shared.copied.join(', ')} into ${dir}; copied instead.`);
        await seedGlobalConfig(path.join(dir, '.claude.json'), globalConfigFileOf({ isDefault: true, configDir: '' }));
      }
      const ok = await this.runLogin(claude, dir, email.trim() || undefined, 'Claude login (Switchboard)');
      if (!ok) {
        await this.discardProfileDir(dir);
        void vscode.window.showWarningMessage('The Claude login was cancelled or did not finish; no account was added.');
        return;
      }
      const snap = await readConfigSnapshot(path.join(dir, '.claude.json'));
      const uuid = snap.account?.accountUuid;
      const duplicate = uuid ? this.profiles.find((p) => this.statuses.get(p.id)?.account.accountUuid === uuid) : undefined;
      if (duplicate) {
        // Same account twice would only confuse usage and auto-switch. Drop the new folder (no logout: tokens are per login).
        await this.discardProfileDir(dir);
        void vscode.window.showWarningMessage(
          `That is the account already in Switchboard as "${duplicate.label}" (${snap.account?.email ?? 'same account'}). In the browser, sign in as a different account and try again.`,
        );
        return;
      }
      const label = snap.account?.email?.split('@')[0] || email.split('@')[0] || path.basename(dir);
      await this.lock.run(async () => {
        await this.reload();
        const profile: Profile = { id: newProfileId(), label, configDir: dir, isDefault: false, order: this.profiles.length, addedAt: Date.now() };
        await saveProfiles([...this.profiles, profile]);
        await this.reload();
      });
      if (this.liveUsage !== 'off') await statusline.enable(await statusline.settingsFiles([dir]));
      void vscode.window.showInformationMessage(`Added Claude account "${label}".`);
    } catch (err) {
      await this.discardProfileDir(dir);
      throw err;
    }
    await this.refresh(true);
  }

  async relogin(id: string): Promise<void> {
    const p = this.profile(id);
    const claude = p && (await this.requireClaude());
    if (!p || !claude) return;
    const ok = await this.runLogin(claude, p.isDefault ? undefined : p.configDir, this.statuses.get(id)?.account.email, `Claude login · ${p.label}`);
    void (ok
      ? vscode.window.showInformationMessage(`Logged in to "${p.label}".`)
      : vscode.window.showWarningMessage(`The login for "${p.label}" was cancelled or did not finish.`));
    this.authCache.delete(id);
    await this.refresh(true);
  }

  /** Adds an existing Claude Code config folder (e.g. one you already use with CLAUDE_CONFIG_DIR). */
  async addExistingFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use This Claude Config Folder' });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return;
    await this.reload();
    if (this.profiles.some((p) => pathKey(configDirOf(p)) === pathKey(dir))) {
      void vscode.window.showInformationMessage('That folder is already in Switchboard.');
      return;
    }
    if (!(await exists(path.join(dir, '.claude.json'))) && !(await exists(path.join(dir, 'settings.json')))) {
      const ok = await vscode.window.showWarningMessage(`${dir} doesn't look like a Claude Code config folder. Add it anyway?`, { modal: true }, 'Add');
      if (ok !== 'Add') return;
    }
    const snap = await readConfigSnapshot(path.join(dir, '.claude.json'));
    const label = snap.account?.email?.split('@')[0] || path.basename(dir);
    await this.lock.run(async () => {
      await this.reload();
      await saveProfiles([...this.profiles, { id: newProfileId(), label, configDir: path.resolve(dir), isDefault: false, order: this.profiles.length, addedAt: Date.now() }]);
    });
    await this.refresh(true);
  }

  // ---------------------------------------------------------------- managing

  private async updateProfiles(fn: (list: Profile[]) => Profile[]): Promise<void> {
    await this.lock.run(async () => {
      await this.reload();
      await saveProfiles(fn(this.profiles));
      await this.reload();
      this.appliedKey = undefined;
      await this.applyActive();
    });
    this.changed.fire();
  }

  rename(id: string, label: string): Promise<void> {
    return this.updateProfiles((list) => list.map((p) => (p.id === id ? { ...p, label } : p)));
  }

  setExcluded(id: string, excluded: boolean): Promise<void> {
    return this.updateProfiles((list) => list.map((p) => (p.id === id ? { ...p, excluded } : p)));
  }

  move(id: string, delta: number): Promise<void> {
    return this.updateProfiles((list) => {
      const next = [...list];
      const from = next.findIndex((p) => p.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= next.length) return next;
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next.map((p, i) => ({ ...p, order: i }));
    });
  }

  /** Removes a profile; optionally logs it out and deletes its folder (only folders Switchboard created). */
  async remove(id: string, deleteFolder: boolean): Promise<void> {
    const p = this.profile(id);
    if (!p || p.isDefault) return;
    if (this.active.id === id) await this.switchTo(DEFAULT_ID, 'manual');
    await this.updateProfiles((list) => list.filter((q) => q.id !== id));
    this.statuses.delete(id);
    this.authCache.delete(id);
    if (deleteFolder && isInside(p.configDir, profilesRoot())) {
      if (this.claudePath) await runClaude(this.claudePath, ['auth', 'logout'], p.configDir);
      await removeProfileDir(p.configDir, profilesRoot());
      this.log.info(`Deleted ${p.configDir}`);
    }
    await this.refresh(false);
  }

  canDeleteFolder(id: string): boolean {
    const p = this.profile(id);
    return !!p && !p.isDefault && isInside(p.configDir, profilesRoot());
  }
}
