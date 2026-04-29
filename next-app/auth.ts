import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAdmin } from "@/lib/admin";

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
});
