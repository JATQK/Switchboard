/**
 * Launches a real VS Code (downloaded into .vscode-test/) with an isolated profile and temporary
 * Switchboard / Claude folders, and runs ./suite.ts inside it. Nothing of the real user setup is touched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-it-'));
  // Set when this runs from a VS Code terminal or task; it would make Code.exe start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [
        '--disable-extensions',
        '--user-data-dir',
        path.join(tmp, 'user-data'),
        '--extensions-dir',
        path.join(tmp, 'extensions'),
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
      extensionTestsEnv: {
        SWITCHBOARD_HOME: path.join(tmp, 'home'),
        CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-default'),
        SWITCHBOARD_CLAUDE_PATH: path.join(tmp, 'no-claude-here'),
        // Keep a real ~/.local/bin/claude out of the test (it would report the test accounts as logged out).
        HOME: path.join(tmp, 'user-home'),
        USERPROFILE: path.join(tmp, 'user-home'),
      },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
