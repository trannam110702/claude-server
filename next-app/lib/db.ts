// Re-export the shared modules from the project root.
// SQLite is used only for request_logs; Claude accounts live in
// accountsStore.js (LowDB + lockfile, like 9router).
// @ts-ignore - JS module without bundled types
export {
  getDb,
  insertRequestLog,
  queryLogs,
  getStats,
  getUsageStats,
} from "../../lib/db.js";

// @ts-ignore - JS module without bundled types
export {
  listAccounts,
  getAccount,
  countAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  pickActiveAccount,
  markAccountUsed,
  markAccountError,
  getSettings,
  updateSettings,
  ACCOUNTS_DB_FILE,
} from "../../lib/accountsStore.js";

// @ts-ignore - JS module without bundled types
export {
  generateAuthData,
  exchangeCode,
  refreshAccessToken,
  ensureFreshAccount,
  CLAUDE_CLIENT_ID,
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_SCOPES,
} from "../../lib/claudeOAuth.js";

// @ts-ignore - JS module without bundled types
export {
  createToken as createUserToken,
  listTokensForUser,
  revokeToken as revokeUserToken,
  validateToken as validateUserToken,
  USER_TOKENS_DB_FILE,
} from "../../lib/userTokens.js";

export interface UserToken {
  id: string;
  userId: string;
  userEmail: string | null;
  name: string;
  secret: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface RequestLog {
  id?: number;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  tokens_used?: number;
  model?: string;
  error?: string;
}

export interface ClaudeAccount {
  id: string;
  name: string;
  email: string | null;
  fullName: string | null;
  organizationName: string | null;
  organizationId: string | null;
  accountUuid: string | null;
  plan: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}
