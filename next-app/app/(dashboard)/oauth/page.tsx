"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function OAuthPage() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  if (session) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">OAuth Status</h1>
        <Card>
          <CardHeader>
            <CardTitle>Authenticated</CardTitle>
            <CardDescription>You are logged in via Google OAuth</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="font-medium">{session.user?.email}</p>
            </div>
            <Button variant="destructive" onClick={() => signOut()}>
              Sign Out
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">OAuth Login</h1>
      <Card>
        <CardHeader>
          <CardTitle>Sign In</CardTitle>
          <CardDescription>Authenticate with Google to access the dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => signIn("google")}>Login with Google</Button>
        </CardContent>
      </Card>
    </div>
  );
}