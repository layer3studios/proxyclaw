import { Document, Types } from 'mongoose';

export type SubscriptionStatus = 'inactive' | 'active' | 'expired' | 'canceled';
export type UserTier = 'starter';
export type AuthProvider = 'email' | 'google';

export interface PlanResources {
  maxAgents: number;
  cpuLimit: number;
  memoryLimit: number;
  label: string;
}

export const PLAN_RESOURCES: Record<UserTier, PlanResources> = {
  starter: {
    maxAgents: 1,
    cpuLimit: 750_000_000,
    memoryLimit: 768 * 1024 * 1024,
    label: '0.75 vCPU · 768 MB RAM',
  },
};

export interface IUser {
  _id: Types.ObjectId;
  email: string;
  passwordHash?: string;
  googleId?: string;
  authProvider: AuthProvider;
  subscriptionStatus: SubscriptionStatus;
  tier?: UserTier;
  subscriptionExpiresAt?: Date;       // 30 days after last payment
  expiryReminderSent?: boolean;       // true once 3-day reminder email sent
  maxAgents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserDocument extends IUser, Document {
  comparePassword(password: string): Promise<boolean>;
  canCreateAgent(): Promise<{ allowed: boolean; reason?: string }>;
  updateSubscription(status: SubscriptionStatus, tier?: UserTier): Promise<void>;
  hasActiveSubscription(): boolean;
  getPlanResources(): PlanResources | null;
  isSubscriptionExpired(): boolean;
}

export type DeploymentStatus =
  | 'idle' | 'configuring' | 'provisioning' | 'starting'
  | 'healthy' | 'stopped' | 'error' | 'restarting';

export interface IDeploymentSecrets {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  telegramBotToken?: string;
  webUiToken: string;
}

export interface IDeployment {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  subdomain: string;
  containerId?: string;
  internalPort?: number;
  status: DeploymentStatus;
  secrets: IDeploymentSecrets;
  config?: Record<string, unknown>;
  lastHeartbeat?: Date;
  lastRequestAt?: Date;
  errorMessage?: string;
  provisioningStep?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDeploymentDocument extends IDeployment, Document {
  decryptSecrets(): Promise<IDecryptedSecrets>;
  transitionTo(status: DeploymentStatus, options?: { errorMessage?: string; provisioningStep?: string }): Promise<void>;
  getUrl(): string;
  getAutoLoginUrl(): Promise<string>;
}

export interface IDecryptedSecrets {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  telegramBotToken?: string;
  webUiToken: string;
}

export interface ContainerConfig {
  Image: string;
  name: string;
  User?: string;
  Env: string[];
  HostConfig: {
    Binds: string[];
    PortBindings: Record<string, Array<{ HostPort: string }>>;
    Memory: number;
    NanoCpus: number;
    RestartPolicy: { Name: string; MaximumRetryCount: number };
  };
  ExposedPorts: Record<string, {}>;
}

export interface OpenClawConfig {
  agent: { model: string; workspace: string };
  gateway: { bind: string; port: number; auth: { mode: 'token' | 'password'; token?: string; password?: string } };
  llm?: { provider: string; apiKey?: string };
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { page?: number; limit?: number; total?: number; pages?: number };
}

export interface DeploymentStatusResponse {
  id: string; subdomain: string; status: DeploymentStatus; url?: string;
  provisioningStep?: string; errorMessage?: string; createdAt: string; lastHeartbeat?: string;
}

export class TamperedDataError extends Error {
  constructor(message = 'Data integrity check failed') { super(message); this.name = 'TamperedDataError'; }
}
export class EncryptionError extends Error {
  constructor(message = 'Encryption operation failed') { super(message); this.name = 'EncryptionError'; }
}
export class DeploymentError extends Error {
  constructor(message: string, public code: string, public statusCode = 500) { super(message); this.name = 'DeploymentError'; }
}
export class PortAllocationError extends Error {
  constructor(message = 'Failed to allocate port') { super(message); this.name = 'PortAllocationError'; }
}
