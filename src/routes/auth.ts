import { Router } from "express";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

import { User } from "@models/User";
import { generateToken, authenticateToken } from "@middleware/auth";
import { validateBody, registerSchema, loginSchema } from "@middleware/validate";
import { logger } from "@utils/logger";
import { config } from "@config/index";
import type { ApiResponse } from "../types";

const router = Router();

/**
 * Build Google OAuth client only if configured.
 */
const GOOGLE_CLIENT_ID = config.google.clientId?.trim() || "";
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

logger.info("Auth router loaded", {
  googleConfigured: Boolean(googleClient),
  googleClientIdPrefix: GOOGLE_CLIENT_ID ? `${GOOGLE_CLIENT_ID.slice(0, 12)}...` : null,
});

function userResponse(user: any) {
  return {
    id: user._id.toString(),
    email: user.email,
    tier: user.tier || null,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionExpiresAt: user.subscriptionExpiresAt?.toISOString() || null,
    maxAgents: user.maxAgents,
    authProvider: user.authProvider,
  };
}

/**
 * POST /register
 */
router.post("/register", validateBody(registerSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (await User.findByEmail(email)) {
      res
        .status(409)
        .json({
          success: false,
          error: { code: "EMAIL_EXISTS", message: "Account already exists" },
        } as ApiResponse);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = new User({
      email,
      passwordHash,
      authProvider: "email",
      subscriptionStatus: "inactive",
      maxAgents: 0,
    });
    await user.save();

    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || "none" });
    logger.info("User registered (email)", { userId: user._id, email });

    res.status(201).json({ success: true, data: { user: userResponse(user), token } } as ApiResponse);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /login
 */
router.post("/login", validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);

    if (!user || !user.passwordHash) {
      res
        .status(401)
        .json({
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        } as ApiResponse);
      return;
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      res
        .status(401)
        .json({
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        } as ApiResponse);
      return;
    }

    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || "none" });
    logger.info("User logged in", { userId: user._id });

    res.json({ success: true, data: { user: userResponse(user), token } } as ApiResponse);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /google
 * Accepts GIS credential (ID token).
 */
const googleAuthSchema = z.object({ credential: z.string().min(1) });

router.post("/google", validateBody(googleAuthSchema), async (req, res) => {
  try {
    if (!googleClient || !GOOGLE_CLIENT_ID) {
      res.status(501).json({
        success: false,
        error: { code: "GOOGLE_NOT_CONFIGURED", message: "Google Sign-In not configured." },
      } as ApiResponse);
      return;
    }

    const { credential } = req.body as { credential: string };

    // Verify ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email || !payload.sub) {
      res.status(401).json({
        success: false,
        error: { code: "INVALID_GOOGLE_TOKEN", message: "Could not verify Google token." },
      } as ApiResponse);
      return;
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase();

    let user = await (User as any).findByGoogleId?.(googleId);

    if (!user) {
      user = await User.findByEmail(email);

      if (user) {
        // Link existing email account
        user.googleId = googleId;
        user.authProvider = "google";
        await user.save();
      } else {
        // Create new user
        user = new User({
          email,
          googleId,
          authProvider: "google",
          subscriptionStatus: "inactive",
          maxAgents: 0,
        });

        await user.save();
        logger.info("User registered (Google)", { userId: user._id, email });
      }
    }

    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || "none" });

    res.json({ success: true, data: { user: userResponse(user), token } } as ApiResponse);
  } catch (error: any) {
    // Log the real reason instead of returning a generic 500
    logger.error("Google auth failed", {
      message: error?.message,
      name: error?.name,
      code: error?.code,
      stack: error?.stack,
    });

    // Common token issues (expired/invalid, clock skew, wrong audience/client_id)
    const msg = (error?.message || "").toLowerCase();

    if (msg.includes("token used too late") || msg.includes("token used too early")) {
      res.status(401).json({
        success: false,
        error: { code: "GOOGLE_TOKEN_TIME_INVALID", message: "Google token time invalid. Check server clock and try again." },
      } as ApiResponse);
      return;
    }

    if (msg.includes("wrong issuer") || msg.includes("audience") || msg.includes("wrong") || msg.includes("invalid token")) {
      res.status(401).json({
        success: false,
        error: { code: "INVALID_GOOGLE_TOKEN", message: "Invalid Google token (client_id/audience mismatch or token invalid)." },
      } as ApiResponse);
      return;
    }

    // Default: still avoid 500, give safe error to client
    res.status(401).json({
      success: false,
      error: { code: "GOOGLE_AUTH_FAILED", message: error?.message || "Google auth failed" },
    } as ApiResponse);
  }
});

/**
 * GET /me
 */
router.get("/me", authenticateToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) {
      res.status(404).json({ success: false, error: { code: "USER_NOT_FOUND", message: "User not found" } } as ApiResponse);
      return;
    }
    res.json({ success: true, data: { ...userResponse(user), createdAt: user.createdAt } } as ApiResponse);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /refresh
 */
router.post("/refresh", authenticateToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) {
      res.status(404).json({ success: false, error: { code: "USER_NOT_FOUND", message: "User not found" } } as ApiResponse);
      return;
    }
    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || "none" });
    res.json({ success: true, data: { token } } as ApiResponse);
  } catch (error) {
    next(error);
  }
});

export default router;