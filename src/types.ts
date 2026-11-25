export interface UsageWindow {
  /** Percent, 0–100. */
  utilization: number;
  /** ISO timestamp when the window resets. */
  resetsAt?: string;
}

export interface Usage {
  /** Rolling 5-hour session window. */
  session?: UsageWindow;
  /** 7-day window across all models. */
  weekly?: UsageWindow;
}

/**
 * One Claude account = one Claude Code config directory. Claude Code itself keeps the login
 * (and refreshes it) inside that directory; Switchboard never reads or stores credentials.
 */
export interface Profile {
  id: string;
  label: string;
  /** Absolute config directory. Empty for the default profile, which uses whatever Claude Code uses without an override. */
  configDir: string;
  isDefault: boolean;
  /** Position in the list; lower comes first (and wins with the "priority" strategy). */
  order: number;
  /** Never chosen as an auto-switch target. */
  excluded?: boolean;
  addedAt: number;
}

export interface AccountInfo {
  /** undefined = not known yet. */
  loggedIn?: boolean;
  email?: string;
  organizationName?: string;
  accountUuid?: string;
  plan?: string;
}

export interface UsageReading {
  usage: Usage;
  /** Epoch ms the data was produced. */
  at: number;
  /** 'limit': a running chat on this account hit a usage limit (see chats.ts). */
  source: 'statusline' | 'cache' | 'limit';
}

export interface ProfileStatus {
  account: AccountInfo;
  reading?: UsageReading;
}
