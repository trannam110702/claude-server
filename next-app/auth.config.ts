import GoogleProvider from "next-auth/providers/google";
import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe NextAuth config. Imported by both `auth.ts` (Node runtime,
 * extended with DB-touching callbacks/events) and `middleware.ts` (Edge
 * runtime, used as-is). Anything that pulls in better-sqlite3 or other
 * Node-only modules MUST live in `auth.ts`, not here.
 */
export default {
  // Sits behind the Express proxy on :8080. Trust x-forwarded-* so callback
  // URLs are built against the public host the browser actually used.
  trustHost: true,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
  },
} satisfies NextAuthConfig;
