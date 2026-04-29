import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // React 18 Strict Mode double-invokes effects in dev to surface bugs, which
  // shows up as duplicate API calls everywhere (logs, accounts, usage, the
  // OAuth flow, etc.). Production behavior is unchanged regardless — strict
  // mode is dev-only — so we turn it off here to stop the double-fetch noise.
  reactStrictMode: false,
};

export default nextConfig;
