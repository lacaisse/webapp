import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/services/auth/better-auth";

// Mounts every Better Auth endpoint under /api/auth/* (sign-in, sign-up,
// sign-out, password reset, verification, passkey ceremonies, etc.). The
// path is the Better Auth default — clients (browser + plugin) assume it.

export const { GET, POST } = toNextJsHandler(auth);
