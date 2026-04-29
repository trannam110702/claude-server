import fs from "fs/promises";
import path from "path";

const TOKENS_PATH = path.join(process.cwd(), "..", "data", "tokens.json");

export interface Tokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  lastRefresh?: string;
}

export async function readTokens(): Promise<Tokens | null> {
  try {
    const content = await fs.readFile(TOKENS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
