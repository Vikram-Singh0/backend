import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";
import { env } from "../config/env";
import { FRONTEND_URLS } from "../config/frontend-urls";

export const auth = betterAuth({
  baseURL: env.BACKEND_URL,
  database: prismaAdapter(prisma, {
    provider: "postgresql", // or "mysql", "postgresql", ...etc
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  secret: process.env.SESSION_SECRET,
  trustedOrigins: FRONTEND_URLS,
  advanced: {
    defaultCookieAttributes: {
      secure: process.env.NODE_ENV === "production", // true for prod, false for dev
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    },
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // Cache duration in seconds
    },
  },
});
