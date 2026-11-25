/** Environment for running Claude Code against a config dir (undefined = Claude Code's default). */
export function envFor(configDir: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
