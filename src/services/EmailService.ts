/**
 * Email Service — sends expiry reminder + expired notification via SMTP
 * All branding reads from backend brand.ts — zero hardcoded product names.
 */

import nodemailer from 'nodemailer';
import { config } from '@config/index';
import { BRAND } from '@config/brand';
import { logger } from '@utils/logger';

class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    if (config.smtp.user && config.smtp.pass) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      });
      logger.info('Email service initialized', { host: config.smtp.host });
    } else {
      logger.warn('SMTP not configured — email sending disabled. Set SMTP_USER and SMTP_PASS.');
    }
  }

  private footer() {
    return `<p style="color: #94a3b8; font-size: 12px;">${BRAND.name} — ${BRAND.tagline}</p>`;
  }

  private renewButton() {
    return `
      <a href="${BRAND.websiteUrl}"
         style="display: inline-block; background: ${BRAND.colors.primary}; color: #fff; text-decoration: none;
                padding: 12px 24px; border-radius: 8px; font-weight: 600;">
        Renew Now — $10
      </a>
    `;
  }

  async sendExpiryReminder(email: string, expiresAt: Date, daysLeft: number): Promise<boolean> {
    if (!this.transporter) { logger.warn('SMTP not configured', { email }); return false; }

    const expiryDateStr = expiresAt.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    try {
      await this.transporter.sendMail({
        from: config.smtp.from,
        to: email,
        subject: `Your ${BRAND.name} subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px;">
            <h2 style="color: #0f172a; margin-bottom: 16px;">Your subscription is expiring soon</h2>
            <p style="color: #475569; line-height: 1.6;">
              Hi there,<br><br>
              Your ${BRAND.name} ${BRAND.planName} plan expires on <strong>${expiryDateStr}</strong>
              (${daysLeft} day${daysLeft !== 1 ? 's' : ''} from now).
            </p>
            <p style="color: #475569; line-height: 1.6;">
              After expiry, your agent will stop running and you won't be able to deploy new agents until you renew.
            </p>
            <div style="margin: 24px 0;">${this.renewButton()}</div>
            <p style="color: #94a3b8; font-size: 13px;">
              If you don't want to renew, no action is needed. Your data will be preserved for 7 days after expiry.
            </p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
            ${this.footer()}
          </div>
        `,
      });
      logger.info('Expiry reminder sent', { email, daysLeft });
      return true;
    } catch (error) {
      logger.error('Failed to send expiry reminder', { email, error: (error as Error).message });
      return false;
    }
  }

  async sendExpiredNotification(email: string): Promise<boolean> {
    if (!this.transporter) return false;

    try {
      await this.transporter.sendMail({
        from: config.smtp.from,
        to: email,
        subject: `Your ${BRAND.name} subscription has expired`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px;">
            <h2 style="color: #0f172a;">Your subscription has expired</h2>
            <p style="color: #475569; line-height: 1.6;">
              Your ${BRAND.name} ${BRAND.planName} plan has expired. Your agent has been stopped.
            </p>
            <p style="color: #475569; line-height: 1.6;">
              Renew anytime to get your agent running again instantly.
            </p>
            <div style="margin: 24px 0;">${this.renewButton()}</div>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
            ${this.footer()}
          </div>
        `,
      });
      logger.info('Expired notification sent', { email });
      return true;
    } catch (error) {
      logger.error('Failed to send expired notification', { email, error: (error as Error).message });
      return false;
    }
  }
}

export const emailService = new EmailService();
