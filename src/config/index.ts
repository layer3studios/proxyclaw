import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Required environment variable ${key} is not set`);
  return value;
}
function getEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}
function getIntEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new Error(`Env ${key} must be integer`);
  return parsed;
}

const isWindows = os.platform() === 'win32';
const isRunningInDocker =
  process.env.RUNNING_IN_DOCKER === 'true' ||
  fs.existsSync('/.dockerenv') ||
  fs.existsSync('/run/.containerenv');

const defaultDataPath = isWindows ? 'C:\\\\proxyclaw-data' : '/opt/saas/data';
const defaultDockerSocket = (() => {
  if (isWindows) return 'http://127.0.0.1:2375';
  if (isRunningInDocker) return 'http://host.docker.internal:2375';
  return 'unix:///var/run/docker.sock';
})();

// Multi-currency pricing — amount in smallest unit (cents/paise)
export const CURRENCY_PRICING: Record<string, { amount: number; currency: string }> = {
  INR: { amount: 99900, currency: 'INR' },    // ₹849
  USD: { amount: 1000, currency: 'USD' },    // $10
  EUR: { amount: 900, currency: 'EUR' },    // €9
  GBP: { amount: 800, currency: 'GBP' },    // £8
  CAD: { amount: 1400, currency: 'CAD' },    // C$14
  AUD: { amount: 1500, currency: 'AUD' },    // A$15
  SGD: { amount: 1300, currency: 'SGD' },    // S$13
  AED: { amount: 3700, currency: 'AED' },    // AED 37
  JPY: { amount: 1500, currency: 'JPY' },    // ¥1500
  MYR: { amount: 4500, currency: 'MYR' },    // RM45
};

export const DEFAULT_CURRENCY = 'USD';

export const config = {
  server: {
    env: getEnv('NODE_ENV', 'development'),
    port: getIntEnv('PORT', 3000),
    domain: getEnv('DOMAIN', 'localhost'),
    isDevelopment: getEnv('NODE_ENV', 'development') === 'development',
    isProduction: getEnv('NODE_ENV', 'development') === 'production',
  },
  database: {
    uri: requireEnv('MONGODB_URI'),
    options: { maxPoolSize: 50, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 },
  },
  encryption: {
    key: requireEnv('ENCRYPTION_KEY'),
    algorithm: 'aes-256-gcm' as const,
    ivLength: 12, authTagLength: 16, keyLength: 32,
  },
  jwt: {
    secret: requireEnv('JWT_SECRET'),
    expiresIn: getEnv('JWT_EXPIRES_IN', '7d'),
  },
  google: {
    clientId: getEnv('GOOGLE_CLIENT_ID', ''),
  },
  docker: {
    socketPath: getEnv('DOCKER_SOCKET', defaultDockerSocket),
    agentImage: getEnv('AGENT_IMAGE', 'ghcr.io/openclaw/openclaw:latest'),
    dataPath: getEnv('DATA_PATH', defaultDataPath),
    containerPrefix: getEnv('CONTAINER_PREFIX', 'proxyclaw-agent-'),
  },
  ports: {
    min: getIntEnv('MIN_AGENT_PORT', 20000),
    max: getIntEnv('MAX_AGENT_PORT', 30000),
  },
  agent: {
    defaultModel: getEnv('DEFAULT_MODEL', 'anthropic/claude-3-5-sonnet'),
    internalPort: getIntEnv('AGENT_INTERNAL_PORT', 18789),
    memoryLimit: getIntEnv('AGENT_MEMORY_LIMIT', 768 * 1024 * 1024),
    cpuLimit: getIntEnv('AGENT_CPU_NANO', 750_000_000),
    maxRestarts: getIntEnv('AGENT_MAX_RESTARTS', 3),
    healthCheckTimeout: getIntEnv('HEALTH_CHECK_TIMEOUT', 120000),
    healthCheckInterval: getIntEnv('HEALTH_CHECK_INTERVAL', 2000),
  },

  payments: {
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    defaultCurrency: getEnv('PAYMENT_CURRENCY', 'USD'),
    plan: {
      label: 'Starter — 0.75 vCPU · 768 MB RAM · 1 Agent',
      maxAgents: 1,
      cpuLimit: 750_000_000,
      memoryLimit: 768 * 1024 * 1024,
      durationDays: 30,
      reminderDaysBeforeExpiry: 3,
    },
  },

  smtp: {
    host: getEnv('SMTP_HOST', 'smtp.gmail.com'),
    port: getIntEnv('SMTP_PORT', 587),
    user: getEnv('SMTP_USER', ''),
    pass: getEnv('SMTP_PASS', ''),
    from: getEnv('SMTP_FROM', 'ProxyClaw <noreply@proxyclaw.xyz>'),
  },

  capacity: {
    maxDeployments: getIntEnv('MAX_DEPLOYMENTS', 50),
    maxRunningAgents: getIntEnv('MAX_RUNNING_AGENTS', 6),
    idleTimeoutMinutes: getIntEnv('IDLE_TIMEOUT_MINUTES', 10),
  },
  logging: { level: getEnv('LOG_LEVEL', 'info') },
  rateLimit: { windowMs: 15 * 60 * 1000, max: 5000 },
  cors: { origin: getEnv('CORS_ORIGIN', '*'), credentials: true },
} as const;

const hexRegex = /^[a-f0-9]{64}$/i;
if (!hexRegex.test(config.encryption.key)) {
  throw new Error('ENCRYPTION_KEY must be a 64-character hexadecimal string (32 bytes).');
}

export default config;
