import { Router } from 'express';
import { User } from '@models/User';
import { config } from '@config/index';

const router = Router();

/**
 * GET /api/public/capacity
 * Returns signup capacity info — no auth required.
 * Used by the frontend to show "X / 50 Founders seats left".
 */
router.get('/capacity', async (_req, res, next) => {
  try {
    const maxSignups = config.capacity.maxSignups;
    const usedSignups = await User.countDocuments();
    const seatsLeft = Math.max(0, maxSignups - usedSignups);

    res.json({
      success: true,
      data: {
        maxSignups,
        usedSignups,
        seatsLeft,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
