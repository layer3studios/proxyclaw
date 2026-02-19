/**
 * Backend Brand Config — single source of truth for emails, logs, etc.
 * Change values here to white-label the backend.
 */

export const BRAND = {
  name: process.env.BRAND_NAME || 'ProxyClaw',
  tagline: process.env.BRAND_TAGLINE || 'Deploy AI Agents with One Click',
  supportEmail: process.env.BRAND_SUPPORT_EMAIL || 'support@proxyclaw.xyz',
  websiteUrl: process.env.BRAND_WEBSITE_URL || 'https://proxyclaw.xyz',
  planName: 'Starter',
  colors: {
    primary: '#0F172A',
    accent: '#3B82F6',
  },
} as const;

export default BRAND;
