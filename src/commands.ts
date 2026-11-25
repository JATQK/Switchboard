import * as vscode from 'vscode';
import type { ChatMover } from './chatMover';
import { pct, untilReset } from './format';
import { activeDirFile } from './paths';
import type { Switchboard } from './switchboard';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Commands get an account id either directly or, from the panel's context menu, as `{ accountId }`. */
function idFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && typeof (arg as { accountId?: unknown }).accountId === 'string') {
    return (arg as { accountId: string }).accountId;
  }
  return undefined;
}

async function pickAccount(sb: Switchboard, title: string, filter: (a: ReturnType<Switchboard['getState']>['accounts'][number]) => boolean = () => true) {
  const accounts = sb.getState().accounts.filter(filter);
  if (!accounts.length) {
    void vscode.window.showInformationMessage('No matching accounts.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    accounts.map((a) => ({ label: a.label, description: a.email, id: a.id })),
    { title },
  );
  return pick?.id;
}

function shellSnippet(kind: 'posix' | 'powershell'): string {
  const file = activeDirFile().replace(/\\/g, '/');
  return kind === 'powershell'
    ? `# Switchboard: use the Claude account selected in VS Code\n$sbDir = Get-Content -Raw -ErrorAction SilentlyContinue '${file}'\nif ($sbDir -and $sbDir.Trim()) { $env:CLAUDE_CONFIG_DIR = $sbDir.Trim() }\n`
    : `# Switchboard: use the Claude account selected in VS Code\nif [ -s '${file}' ]; then export CLAUDE_CONFIG_DIR="$(cat '${file}')"; fi\n`;
}

export function registerCommands(ctx: vscode.ExtensionContext, sb: Switchboard, mover: ChatMover, log: vscode.LogOutputChannel): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          log.error(errorText(err));
          void vscode.window.showErrorMessage(`Switchboard: ${errorText(err)}`);
        }
      }),
    );
  const withId = (title: string, fn: (id: string) => unknown) => async (arg: unknown) => {
    const id = idFrom(arg) ?? (await pickAccount(sb, title));
    if (id) await fn(id);
  };

  const addAccount = async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(log-in) Log in another account…', detail: "Signs in through Claude Code's own login, in a separate profile. Your current login is not touched.", action: 'login' },
        { label: '$(folder-opened) Use an existing Claude config folder…', detail: 'A folder you already use with CLAUDE_CONFIG_DIR.', action: 'folder' },
      ],
      { title: 'Add a Claude account' },
    );
    if (pick?.action === 'login') await sb.loginNewAccount();
    if (pick?.action === 'folder') await sb.addExistingFolder();
  };

  const switchAccount = async (arg?: unknown) => {
    const id = idFrom(arg);
    if (id) {
      // Chats still running on the previous account are offered a move (see ChatMover).
      await sb.switchTo(id, 'manual');
      return;
    }
    const state = sb.getState();
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = state.accounts.map((a) => {
      const reset = untilReset(a.session?.resetsAt);
      const running = a.chats ? ` · ${a.chats === 1 ? '1 chat' : `${a.chats} chats`} running` : '';
      return {
        label: `${a.active ? '$(check)' : '$(blank)'} ${a.label}`,
        description:
          a.loggedIn === false
            ? 'not logged in'
            : `5h ${pct(a.session?.pct)} · 7d ${pct(a.weekly?.pct)}${reset && (a.session?.pct ?? 0) > 0 ? ` · session resets in ${reset}` : ''}${running}`,
        detail: [a.email, a.plan].filter(Boolean).join(' · ') || undefined,
        run: a.active ? undefined : a.loggedIn === false ? () => sb.relogin(a.id) : () => switchAccount(a.id),
      };
    });
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(zap) ${state.auto.enabled ? 'Turn auto-switch off' : 'Turn auto-switch on'}`, run: () => vscode.commands.executeCommand('switchboard.toggleAutoSwitch') },
      { label: '$(terminal) New Claude terminal (active account)', run: () => sb.openTerminal() },
      ...(state.accounts.some((a) => !a.active && a.chats > 0)
        ? [{ label: '$(arrow-right) Move running chats to the active account', run: () => mover.moveChats() }]
        : []),
      { label: '$(add) Add account…', run: addAccount },
      { label: '$(layout-sidebar-left) Open Switchboard', run: () => vscode.commands.executeCommand('switchboard.panel.focus') },
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'Switchboard', placeHolder: 'New Claude Code sessions use…' });
    await pick?.run?.();
  };

  register('switchboard.switchAccount', switchAccount);
  register('switchboard.addAccount', addAccount);
  register('switchboard.loginNew', () => sb.loginNewAccount());
  register('switchboard.addFolder', () => sb.addExistingFolder());
  register('switchboard.login', withId('Log in to which account?', (id) => sb.relogin(id)));
  register('switchboard.refresh', () => sb.refresh(true));
  register('switchboard.openTerminal', () => sb.openTerminal());
  register('switchboard.moveChats', (arg?: unknown) => mover.moveChats(idFrom(arg)));
  register('switchboard.toggleAutoSwitch', async () => {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('autoSwitch.enabled', !config.get('autoSwitch.enabled', false), vscode.ConfigurationTarget.Global);
  });
  register('switchboard.enableLiveUsage', () => sb.setLiveUsage(true));
  register('switchboard.disableLiveUsage', () => sb.setLiveUsage(false));
  register('switchboard.dismissLiveUsage', () => sb.dismissLiveUsageBanner());
  register(
    'switchboard.renameAccount',
    withId('Rename which account?', async (id) => {
      const p = sb.getProfile(id);
      if (!p) return;
      const label = await vscode.window.showInputBox({ title: 'Rename account', value: p.label, validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty') });
      if (label?.trim()) await sb.rename(id, label.trim());
    }),
  );
  register(
    'switchboard.removeAccount',
    withId('Remove which account?', async (id) => {
      const p = sb.getProfile(id);
      if (!p) return;
      if (p.isDefault) {
        void vscode.window.showInformationMessage('The default account is the one Claude Code uses without Switchboard; it cannot be removed. Use "Skip in Auto-Switch" instead.');
        return;
      }
      const canDelete = sb.canDeleteFolder(id);
      const choice = await vscode.window.showWarningMessage(
        `Remove "${p.label}" from Switchboard?`,
        {
          modal: true,
          detail: canDelete
            ? `"Log Out and Delete" logs this account out of Claude Code and deletes its folder:\n${p.configDir}\nShared settings, skills and history are not affected.`
            : `The folder stays where it is:\n${p.configDir}`,
        },
        ...(canDelete ? ['Remove from List', 'Log Out and Delete'] : ['Remove']),
      );
      if (choice) await sb.remove(id, choice === 'Log Out and Delete');
    }),
  );
  register('switchboard.moveUp', withId('Move which account?', (id) => sb.move(id, -1)));
  register('switchboard.moveDown', withId('Move which account?', (id) => sb.move(id, 1)));
  register('switchboard.pauseAuto', withId('Skip which account?', (id) => sb.setExcluded(id, true)));
  register('switchboard.resumeAuto', withId('Use which account?', (id) => sb.setExcluded(id, false)));
  register(
    'switchboard.revealFolder',
    withId('Show which account folder?', (id) => {
      const dir = sb.getState().accounts.find((a) => a.id === id)?.configDir;
      if (dir) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }),
  );
  register('switchboard.copyShellSetup', async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'bash / zsh', description: '~/.bashrc, ~/.zshrc', shell: 'posix' as const },
        { label: 'PowerShell', description: '$PROFILE', shell: 'powershell' as const },
      ],
      { title: 'Follow the Switchboard account in terminals outside VS Code', placeHolder: 'Which shell?' },
    );
    if (!pick) return;
    await vscode.env.clipboard.writeText(shellSnippet(pick.shell));
    void vscode.window.showInformationMessage(`Copied. Paste it into your ${pick.description} so new shells start Claude Code with the selected account.`);
  });
  register('switchboard.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`));
  register('switchboard.showLog', () => log.show());
}
