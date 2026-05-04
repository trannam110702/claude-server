import NextAuth from "next-auth";
import authConfig from "./auth.config";
import { isAdmin } from "@/lib/admin";
import { upsertUserOnLogin } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      isAdmin?: boolean;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

/**
 * Full NextAuth config — runs in Node runtime only. Pulls in better-sqlite3
 * via the session callback (`isAdmin` → `isAdminInDb`) and the signIn event
 * (`upsertUserOnLogin`). The Edge-runtime middleware uses `auth.config.ts`
 * directly to avoid bundling these.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    jwt({ token, user }) {
      // Pin token.sub to a stable identifier. Auth.js v5 assigns a fresh
      // crypto.randomUUID() to user.id on every OAuth sign-in (see
      // @auth/core's getUserAndAccount), which would otherwise orphan
      // everything keyed off session.user.id — notably user-issued API
      // tokens — every time the user signs out and back in.
      if (user?.email) token.sub = user.email.toLowerCase();
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        if (token.sub) session.user.id = token.sub;
        session.user.isAdmin = isAdmin(session.user.email);
      }
      return session;
    },
  },
  events: {
    // Record every successful sign-in. Failures here must not block sign-in
    // (transient DB errors shouldn't lock people out), so we log and swallow.
    async signIn({ user }) {
      if (!user?.email) return;
      try {
        upsertUserOnLogin({
          email: user.email,
          name: user.name ?? null,
          image: user.image ?? null,
        });
      } catch (err) {
        console.error("[auth] upsertUserOnLogin failed:", (err as Error).message);
      }
    },
  },
});
