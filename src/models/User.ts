import mongoose, { Schema, model, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import {
  IUserDocument, SubscriptionStatus, UserTier,
  PLAN_RESOURCES, PlanResources,
} from '../types';

const SALT_ROUNDS = 12;

const UserSchema = new Schema<IUserDocument>(
  {
    email: {
      type: String, required: true, unique: true,
      lowercase: true, trim: true, index: true,
      validate: {
        validator: (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        message: 'Please provide a valid email address',
      },
    },
    passwordHash: { type: String, required: false },
    googleId: { type: String, sparse: true, index: true },
    authProvider: { type: String, enum: ['email', 'google'], default: 'email' },
    subscriptionStatus: {
      type: String, enum: ['inactive', 'active', 'expired', 'canceled'],
      default: 'inactive', index: true,
    },
    tier: { type: String, enum: ['starter'], default: undefined, index: true },
    subscriptionExpiresAt: { type: Date },
    expiryReminderSent: { type: Boolean, default: false },
    maxAgents: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: any) => { delete ret.passwordHash; delete ret.__v; return ret; },
    },
    toObject: {
      transform: (_doc, ret: any) => { delete ret.passwordHash; delete ret.__v; return ret; },
    },
  }
);

UserSchema.index({ subscriptionStatus: 1, tier: 1 });
UserSchema.index({ subscriptionExpiresAt: 1 });

UserSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(password, this.passwordHash);
};

interface IUserModel extends Model<IUserDocument> {
  hashPassword(password: string): Promise<string>;
  findByEmail(email: string): Promise<IUserDocument | null>;
  findByGoogleId(googleId: string): Promise<IUserDocument | null>;
}

UserSchema.statics.hashPassword = async (password: string): Promise<string> => bcrypt.hash(password, SALT_ROUNDS);
UserSchema.statics.findByEmail = function (email: string) { return this.findOne({ email: email.toLowerCase() }); };
UserSchema.statics.findByGoogleId = function (googleId: string) { return this.findOne({ googleId }); };

UserSchema.methods.isSubscriptionExpired = function (): boolean {
  if (!this.subscriptionExpiresAt) return true;
  return new Date() > this.subscriptionExpiresAt;
};

UserSchema.methods.hasActiveSubscription = function (): boolean {
  if (this.subscriptionStatus !== 'active' || !this.tier) return false;
  // Also check expiry date
  if (this.subscriptionExpiresAt && new Date() > this.subscriptionExpiresAt) return false;
  return true;
};

UserSchema.methods.getPlanResources = function (): PlanResources | null {
  if (!this.hasActiveSubscription()) return null;
  return PLAN_RESOURCES[this.tier as UserTier] || null;
};

UserSchema.methods.canCreateAgent = async function (): Promise<{ allowed: boolean; reason?: string }> {
  if (!this.hasActiveSubscription()) {
    if (this.subscriptionStatus === 'expired' || (this.subscriptionExpiresAt && new Date() > this.subscriptionExpiresAt)) {
      return { allowed: false, reason: 'Your subscription has expired. Please renew to deploy agents.' };
    }
    return { allowed: false, reason: 'You need an active subscription to deploy an agent. Please subscribe first.' };
  }
  const resources = PLAN_RESOURCES[this.tier as UserTier];
  if (!resources) return { allowed: false, reason: 'Invalid subscription tier.' };

  const Deployment = mongoose.model('Deployment');
  const currentCount = await Deployment.countDocuments({
    user: this._id, status: { $nin: ['stopped', 'error'] },
  });
  if (currentCount >= resources.maxAgents) {
    return { allowed: false, reason: `Max ${resources.maxAgents} agent(s) for your plan. Stop your existing agent first.` };
  }
  return { allowed: true };
};

UserSchema.methods.updateSubscription = async function (
  status: SubscriptionStatus, tier?: UserTier
): Promise<void> {
  this.subscriptionStatus = status;
  if (tier) {
    this.tier = tier;
    this.maxAgents = PLAN_RESOURCES[tier]?.maxAgents || 0;
  }
  if (status === 'canceled' || status === 'inactive' || status === 'expired') {
    this.maxAgents = 0;
  }
  await this.save();
};

UserSchema.pre('save', async function (next) {
  if (this.isModified('tier') && this.tier) {
    const resources = PLAN_RESOURCES[this.tier as UserTier];
    if (resources) this.maxAgents = resources.maxAgents;
  }
  next();
});

export const User = model<IUserDocument, IUserModel>('User', UserSchema);
export default User;
