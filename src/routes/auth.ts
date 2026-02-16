import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { User } from '@models/User';
import { generateToken, authenticateToken } from '@middleware/auth';
import { validateBody, registerSchema, loginSchema } from '@middleware/validate';
import { logger } from '@utils/logger';
import { config } from '@config/index';
import { ApiResponse } from '../types';
import { z } from 'zod';

const router = Router();

const googleClient = config.google.clientId
  ? new OAuth2Client(config.google.clientId)
  : null;

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

// POST /register
router.post('/register', validateBody(registerSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const maxSignups = config.capacity.maxSignups;
    const currentUsers = await User.countDocuments();
    if (currentUsers >= maxSignups) {
      res.status(403).json({ success: false, error: { code: 'SIGNUPS_CLOSED', message: `All ${maxSignups} seats are taken!` } } as ApiResponse);
      return;
    }

    if (await User.findByEmail(email)) {
      res.status(409).json({ success: false, error: { code: 'EMAIL_EXISTS', message: 'Account already exists' } } as ApiResponse);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = new User({ email, passwordHash, authProvider: 'email', subscriptionStatus: 'inactive', maxAgents: 0 });
    await user.save();

    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || 'none' });
    logger.info('User registered (email)', { userId: user._id, email });

    res.status(201).json({ success: true, data: { user: userResponse(user), token } } as ApiResponse);
  } catch (error) { next(error); }
});

// POST /login
router.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);

    if (!user || !user.passwordHash) {
      res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } } as ApiResponse);
      return;
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } } as ApiResponse);
      return;
    }

    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || 'none' });
    logger.info('User logged in', { userId: user._id });

    res.json({ success: true, data: { user: userResponse(user), token } } as ApiResponse);
  } catch (error) { next(error); }
});

// POST /google
const googleAuthSchema = z.object({ credential: z.string().min(1) });

router.post('/google', validateBody(googleAuthSchema), async (req, res, next) => {
  try {
    if (!googleClient || !config.google.clientId) {
      res.status(501).json({ success: false, error: { code: 'GOOGLE_NOT_CONFIGURED', message: 'Google Sign-In not configured.' } } as ApiResponse);
      return;
    }

    const { credential } = req.body;
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.google.clientId });
    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      res.status(401).json({ success: false, error: { code: 'INVALID_GOOGLE_TOKEN', message: 'Could not verify Google token.' } } as ApiResponse);
      return;
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase();

    let user = await (User as any).findByGoogleId(googleId);

    if (!user) {
      user = await User.findByEmail(email);
      if (user) {
        user.googleId = googleId;
        user.authProvider = 'google';
        await user.save();
      } else {
        const maxSignups = config.capacity.maxSignups;
        const currentUsers = await User.countDocuments();
        if (currentUsers >= maxSignups) {
          res.status(403).json({ success: false, error: { code: 'SIGNUPS_CLOSED', message: `All ${maxSignups} seats are taken!` } } as ApiResponse);
          return;
        }
        user = new User({ email, googleId, authProvider: 'google', subscriptionStatus: 'inactive', maxAgents: 0 });
        await user.save();
        logger.info('User registered (Google)', { userId: user._id, email });
      }
    }

    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || 'none' });
    res.json({ success: true, data: { user: userResponse(user), token } } as ApiResponse);
  } catch (error: any) {
    if (error.message?.includes('Token used too late') || error.message?.includes('Invalid token')) {
      res.status(401).json({ success: false, error: { code: 'INVALID_GOOGLE_TOKEN', message: 'Google token expired. Try again.' } } as ApiResponse);
      return;
    }
    next(error);
  }
});

// GET /me
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } } as ApiResponse); return; }
    res.json({ success: true, data: { ...userResponse(user), createdAt: user.createdAt } } as ApiResponse);
  } catch (error) { next(error); }
});

// POST /refresh
router.post('/refresh', authenticateToken, async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } } as ApiResponse); return; }
    const token = generateToken({ _id: user._id.toString(), email: user.email, tier: user.tier || 'none' });
    res.json({ success: true, data: { token } } as ApiResponse);
  } catch (error) { next(error); }
});

export default router;
