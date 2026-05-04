import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
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

export const { handlers, signIn, signOut, auth } = NextAuth({
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
  callbacks: {
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
