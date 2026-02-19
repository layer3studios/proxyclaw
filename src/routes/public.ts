import { Router } from 'express';
import { Deployment } from '@models/Deployment';
import { config } from '@config/index';

const router = Router();

/**
 * GET /api/public/capacity
 * Returns deployment capacity info — no auth required.
 * Used by the frontend to show "X / 50 Founders seats left".
 */
router.get('/capacity', async (_req, res, next) => {
  try {
    const maxDeployments = config.capacity.maxDeployments;
    const usedDeployments = await Deployment.countDocuments({});
    const seatsLeft = Math.max(0, maxDeployments - usedDeployments);

    res.json({
      success: true,
      data: {
        maxDeployments,
        usedDeployments,
        seatsLeft,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
