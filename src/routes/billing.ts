import { Router, Request, Response, NextFunction } from 'express';
import { paymentService } from '@services/PaymentService';
import { authenticateToken } from '@middleware/auth';
import { validateBody } from '@middleware/validate';
import { z } from 'zod';

const router = Router();

const createOrderSchema = z.object({
  currency: z.string().min(3).max(3).optional(),  // ISO 4217 e.g. "INR", "USD", "EUR"
});

const verifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  signature: z.string().min(1),
});

// Create Order — accepts optional currency from frontend
router.post(
  '/create-order',
  authenticateToken,
  validateBody(createOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { currency } = req.body;
      const order = await paymentService.createOrder(req.user!.id, currency);
      res.json({ success: true, data: order });
    } catch (error) { next(error); }
  }
);

// Verify Payment → activate 30 days
router.post(
  '/verify',
  authenticateToken,
  validateBody(verifySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { razorpayOrderId, razorpayPaymentId, signature } = req.body;
      await paymentService.verifyPayment(razorpayOrderId, razorpayPaymentId, signature, req.user!.id);
      res.json({ success: true, message: 'Plan activated for 30 days.' });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: { code: 'PAYMENT_FAILED', message: (error as Error).message || 'Payment verification failed.' },
      });
    }
  }
);

// Get Subscription Info
router.get('/subscription', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const info = await paymentService.getSubscriptionInfo(req.user!.id);
    res.json({ success: true, data: info });
  } catch (error) { next(error); }
});

export default router;
