import * as vscode from 'vscode';
import { Applier } from './applier';
import { ChatMover } from './chatMover';
import { registerCommands } from './commands';
import { registerFeatureCommands } from './featureCommands';
import { SwitchboardPanel } from './panel';
import { Queues, QueuesViewProvider } from './queuesView';
import { Snippets } from './snippetsView';
import { StatusBar } from './statusBar';
import { Switchboard } from './switchboard';

/** Returned only when VS Code runs the extension's tests: lets them drive the queues and snippets directly. */
export interface TestHooks {
  queues: Queues;
  snippets: Snippets;
}

export function activate(ctx: vscode.ExtensionContext): TestHooks | undefined {
  const log = vscode.window.createOutputChannel('Switchboard', { log: true });
  const sb = new Switchboard(new Applier(ctx.environmentVariableCollection, log), log, ctx.globalState);
  const mover = new ChatMover(sb, log);
  const panel = new SwitchboardPanel(ctx.extensionUri, sb);
  const queues = new Queues(ctx.globalState, sb, log);
  const snippets = new Snippets(sb, queues);
  const queuesView = new QueuesViewProvider(ctx.extensionUri, queues, () => snippets.pickText());

  ctx.subscriptions.push(
    log,
    sb,
    mover,
    panel,
    queues,
    queuesView,
    snippets,
    vscode.window.registerWebviewViewProvider(SwitchboardPanel.viewId, panel),
    vscode.window.registerWebviewViewProvider(QueuesViewProvider.viewId, queuesView),
    new StatusBar(sb),
  );
  registerCommands(ctx, sb, mover, log);
  registerFeatureCommands(ctx, sb, queues, snippets, log);

  sb.start().catch((err) => log.error(`Startup failed: ${err instanceof Error ? err.message : String(err)}`));
  snippets.start().catch((err) => log.error(`Could not load snippets: ${err instanceof Error ? err.message : String(err)}`));
  queues.start().catch((err) => log.error(`Could not read the queues: ${err instanceof Error ? err.message : String(err)}`));
  return ctx.extensionMode === vscode.ExtensionMode.Test ? { queues, snippets } : undefined;
}

export function deactivate(): void {
  // Everything is disposed through ctx.subscriptions. Queue chats keep working without VS Code (the hook does the work).
}
