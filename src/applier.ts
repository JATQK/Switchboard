/**
 * Points Claude Code at the active profile by setting CLAUDE_CONFIG_DIR where Claude Code starts:
 * new integrated terminals, the Claude Code VS Code extension, and (opt-in, via the shell snippet) any shell.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { activeDirFile } from './paths';

const VAR = 'CLAUDE_CONFIG_DIR';
const CLAUDE_CODE_SETTING = 'environmentVariables';

type EnvEntry = { name: string; value: string };

export class Applier {
  constructor(
    private readonly collection: vscode.EnvironmentVariableCollection,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** `configDir` undefined means the default profile: remove every override. */
  async apply(configDir: string | undefined, label: string, applyToClaudeCodeExtension: boolean): Promise<void> {
    // 1. New VS Code terminals (this window; every window applies the shared state itself).
    if (configDir) this.collection.replace(VAR, configDir);
    else this.collection.delete(VAR);
    this.collection.description = new vscode.MarkdownString(`Switchboard: Claude Code uses the **${label}** account`);

    // 2. Shell snippet target for terminals outside VS Code.
    try {
      await fs.mkdir(path.dirname(activeDirFile()), { recursive: true });
      const current = await fs.readFile(activeDirFile(), 'utf8').catch(() => undefined);
      if (current?.trim() !== (configDir ?? '')) await fs.writeFile(activeDirFile(), configDir ?? '', 'utf8');
    } catch (err) {
      this.log.warn(`Could not write ${activeDirFile()}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. The Claude Code extension's own environment setting (a user/machine setting shared by all windows).
    if (applyToClaudeCodeExtension) await this.applyToClaudeCodeExtension(configDir);
  }

  private async applyToClaudeCodeExtension(configDir: string | undefined): Promise<void> {
    // The setting only exists (and can only be written) when the Claude Code extension is installed.
    if (!vscode.extensions.getExtension('anthropic.claude-code')) return;
    const config = vscode.workspace.getConfiguration('claudeCode');
    const inspected = config.inspect<EnvEntry[]>(CLAUDE_CODE_SETTING);
    const current = Array.isArray(inspected?.globalValue) ? inspected.globalValue : [];
    const others = current.filter((e) => e && e.name !== VAR);
    const next = configDir ? [...others, { name: VAR, value: configDir }] : others;
    const same = JSON.stringify(next) === JSON.stringify(current);
    if (same) return;
    try {
      await config.update(CLAUDE_CODE_SETTING, next.length ? next : undefined, vscode.ConfigurationTarget.Global);
    } catch (err) {
      this.log.warn(`Could not update claudeCode.environmentVariables: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The profile the Claude Code extension setting currently points at (to pick up manual edits). */
  static claudeCodeConfigDir(): string | undefined {
    const value = vscode.workspace.getConfiguration('claudeCode').inspect<EnvEntry[]>(CLAUDE_CODE_SETTING)?.globalValue;
    return Array.isArray(value) ? value.find((e) => e?.name === VAR)?.value : undefined;
  }
}
