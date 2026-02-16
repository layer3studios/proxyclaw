/**
 * Payment Service — One-time Razorpay Orders, multi-currency
 *
 * Flow:
 *   1. Frontend detects user's country → picks currency (INR/USD/EUR/etc.)
 *   2. createOrder(userId, currency) → Razorpay order in that currency+amount
 *   3. Razorpay Checkout opens with ALL methods (UPI, QR, cards, intl, netbanking, wallets)
 *   4. verifyPayment() → HMAC verify + Razorpay API check → activate 30 days
 *   5. After 30 days, plan expires. User must come back and pay again.
 */

import Razorpay from 'razorpay';
import crypto from 'crypto';
import { config, CURRENCY_PRICING, DEFAULT_CURRENCY } from '@config/index';
import { User } from '@models/User';
import { logger } from '@utils/logger';
import { UserTier, PLAN_RESOURCES } from '../types';

const razorpay = new Razorpay({
  key_id: config.payments.razorpayKeyId,
  key_secret: config.payments.razorpayKeySecret,
});

export class PaymentService {

  /**
   * Get price for a given currency code
   */
  private getPricing(currencyCode?: string) {
    const code = (currencyCode || DEFAULT_CURRENCY).toUpperCase();
    return CURRENCY_PRICING[code] || CURRENCY_PRICING[DEFAULT_CURRENCY];
  }

  /**
   * Create a one-time Razorpay order in the user's local currency
   */
  async createOrder(userId: string, currencyCode?: string) {
    const pricing = this.getPricing(currencyCode);

    const options = {
      amount: pricing.amount,
      currency: pricing.currency,
      receipt: `rcpt_${userId.slice(-6)}_${Date.now()}`,
      notes: { userId, plan: 'starter', currency: pricing.currency },
    };

    try {
      const order = await razorpay.orders.create(options);
      logger.info('Razorpay order created', {
        orderId: order.id, userId,
        currency: pricing.currency, amount: pricing.amount,
      });
      return order;
    } catch (error) {
      logger.error('Razorpay order creation failed', { error, userId });
      throw error;
    }
  }

  /**
   * Verify payment signature + Razorpay API check → activate 30 days
   */
  async verifyPayment(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    signature: string,
    userId: string
  ) {
    // 1) Verify HMAC signature
    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSignature = crypto
      .createHmac('sha256', config.payments.razorpayKeySecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      logger.error('Payment signature mismatch', { userId, razorpayOrderId });
      throw new Error('Invalid payment signature — possible tampering.');
    }

    // 2) Fetch payment from Razorpay to double-check
    try {
      const payment = await razorpay.payments.fetch(razorpayPaymentId);

      if (payment.status !== 'captured' && payment.status !== 'authorized') {
        throw new Error(`Payment is "${payment.status}" — not valid.`);
      }

      // Verify amount matches one of our supported currencies
      const pricing = this.getPricing(payment.currency as string);
      if (payment.amount !== pricing.amount) {
        logger.error('Payment amount mismatch', {
          userId, expected: pricing.amount, received: payment.amount,
          currency: payment.currency,
        });
        throw new Error('Payment amount does not match.');
      }
    } catch (fetchError: any) {
      if (fetchError.message?.includes('Payment is') || fetchError.message?.includes('amount does not')) throw fetchError;
      logger.error('Failed to fetch payment from Razorpay', { error: fetchError });
      throw new Error('Could not verify payment with Razorpay. Contact support.');
    }

    // 3) Activate for 30 days
    await this.activateSubscription(userId);
    logger.info('Payment verified, 30 days activated', { userId, razorpayPaymentId });
    return { success: true };
  }

  /**
   * Activate subscription for 30 days. Extends if time remaining.
   */
  private async activateSubscription(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const durationMs = config.payments.plan.durationDays * 24 * 60 * 60 * 1000;

    // If still active with time left, extend from current expiry
    let baseDate = new Date();
    if (user.subscriptionStatus === 'active' && user.subscriptionExpiresAt && user.subscriptionExpiresAt > baseDate) {
      baseDate = user.subscriptionExpiresAt;
    }

    user.subscriptionStatus = 'active';
    user.tier = 'starter' as UserTier;
    user.maxAgents = PLAN_RESOURCES.starter.maxAgents;
    user.subscriptionExpiresAt = new Date(baseDate.getTime() + durationMs);
    user.expiryReminderSent = false;
    await user.save();

    logger.info('Subscription activated', {
      userId, expiresAt: user.subscriptionExpiresAt.toISOString(),
    });
  }

  /**
   * Get subscription info for frontend
   */
  async getSubscriptionInfo(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    if (user.subscriptionStatus === 'active' && user.subscriptionExpiresAt && new Date() > user.subscriptionExpiresAt) {
      user.subscriptionStatus = 'expired';
      user.maxAgents = 0;
      await user.save();
    }

    return {
      status: user.subscriptionStatus,
      tier: user.tier || null,
      maxAgents: user.maxAgents,
      subscriptionExpiresAt: user.subscriptionExpiresAt?.toISOString() || null,
      resources: user.tier && user.subscriptionStatus === 'active' ? PLAN_RESOURCES[user.tier as UserTier] : null,
    };
  }
}

export const paymentService = new PaymentService();
