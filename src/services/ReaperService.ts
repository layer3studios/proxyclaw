/**
 * Reaper Service — reconciles zombies, hibernates idle agents,
 * expires subscriptions, sends 3-day reminder emails
 */

import cron, { ScheduledTask } from 'node-cron';
import { Deployment } from '@models/Deployment';
import { User } from '@models/User';
import { containerManager } from '@services/docker/ContainerManager';
import { emailService } from '@services/EmailService';
import { logger } from '@utils/logger';
import { config } from '@config/index';
import Docker from 'dockerode';

export class ReaperService {
  private isRunning = false;
  private task: ScheduledTask | null = null;

  start() {
    // Run every 2 minutes
    this.task = cron.schedule('*/2 * * * *', async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      try {
        await this.reconcileState();
        await this.hibernateIdleAgents();
        await this.processSubscriptionExpiries();
        await this.sendExpiryReminders();
      } catch (error) {
        logger.error('Reaper failed', { error: (error as Error).message });
      } finally {
        this.isRunning = false;
      }
    });

    logger.info('Reaper Service started (every 2 min)');
  }

  stop() {
    if (this.task) { this.task.stop(); logger.info('Reaper stopped'); }
  }

  // =========================================================================
  // 1) Reconcile zombie DB records
  // =========================================================================
  private async reconcileState() {
    try {
      const activeContainers = await Promise.race([
        containerManager.listManagedContainers(),
        this.timeout(10000, 'Docker list timed out'),
      ]);
      const ids = new Set(activeContainers.map((c: Docker.ContainerInfo) => c.Id));

      const deployments = await Deployment.find({
        status: { $in: ['healthy', 'starting'] },
        containerId: { $exists: true, $ne: null },
      }).select('_id subdomain containerId').lean().exec();

      for (const d of deployments) {
        if (!ids.has(d.containerId!)) {
          logger.warn('Reaper: zombie deployment', { subdomain: d.subdomain });
          await Deployment.updateOne(
            { _id: d._id },
            { $set: { status: 'error', errorMessage: 'Container died unexpectedly' }, $unset: { containerId: '', internalPort: '' } }
          );
        }
      }
    } catch (error) {
      logger.error('Reaper: reconcile error', { error: (error as Error).message });
    }
  }

  // =========================================================================
  // 2) Hibernate idle agents (idle > X minutes)
  // =========================================================================
  private async hibernateIdleAgents() {
    const cutoff = new Date(Date.now() - config.capacity.idleTimeoutMinutes * 60 * 1000);

    const idleDeployments = await Deployment.find({
      status: 'healthy',
      containerId: { $exists: true, $ne: null },
      $or: [
        { lastRequestAt: { $lt: cutoff } },
        { lastRequestAt: { $exists: false } },
      ],
    }).exec();

    for (const deployment of idleDeployments) {
      try {
        logger.info('Reaper: Hibernating idle agent', { subdomain: deployment.subdomain });

        if (deployment.containerId) {
          try {
            const { dockerClient } = await import('@services/docker/DockerClient');
            await dockerClient.stopContainer(deployment.containerId, 15);
          } catch {}
          try {
            const { dockerClient } = await import('@services/docker/DockerClient');
            await dockerClient.removeContainer(deployment.containerId, true);
          } catch {}
        }

        await Deployment.updateOne(
          { _id: deployment._id },
          { $set: { status: 'stopped' }, $unset: { containerId: '', internalPort: '' } }
        );
      } catch (error) {
        logger.error('Reaper: hibernate error', { error: (error as Error).message });
      }
      await this.delay(200);
    }
  }

  // =========================================================================
  // 3) Expire subscriptions past their expiry date
  // =========================================================================
  private async processSubscriptionExpiries() {
    try {
      const now = new Date();

      // Find users whose subscription is 'active' but expired
      const expiredUsers = await User.find({
        subscriptionStatus: 'active',
        subscriptionExpiresAt: { $lte: now },
      }).exec();

      for (const user of expiredUsers) {
        logger.info('Reaper: Expiring subscription', { userId: user._id, email: user.email });

        user.subscriptionStatus = 'expired';
        user.maxAgents = 0;
        await user.save();

        // Send expired notification
        await emailService.sendExpiredNotification(user.email);

        // Stop all their running agents
        const deployments = await Deployment.find({
          user: user._id,
          status: { $in: ['healthy', 'starting', 'provisioning'] },
          containerId: { $exists: true, $ne: null },
        }).exec();

        for (const deployment of deployments) {
          try {
            if (deployment.containerId) {
              const { dockerClient } = await import('@services/docker/DockerClient');
              try { await dockerClient.stopContainer(deployment.containerId, 15); } catch {}
              try { await dockerClient.removeContainer(deployment.containerId, true); } catch {}
            }
            await Deployment.updateOne(
              { _id: deployment._id },
              { $set: { status: 'stopped', errorMessage: 'Subscription expired' }, $unset: { containerId: '', internalPort: '' } }
            );
          } catch {}
        }
      }
    } catch (error) {
      logger.error('Reaper: expiry processing error', { error: (error as Error).message });
    }
  }

  // =========================================================================
  // 4) Send 3-day expiry reminder emails
  // =========================================================================
  private async sendExpiryReminders() {
    try {
      const reminderDays = config.payments.plan.reminderDaysBeforeExpiry;
      const reminderCutoff = new Date(Date.now() + reminderDays * 24 * 60 * 60 * 1000);
      const now = new Date();

      // Find active users expiring within 3 days who haven't been reminded yet
      const usersToRemind = await User.find({
        subscriptionStatus: 'active',
        subscriptionExpiresAt: { $gt: now, $lte: reminderCutoff },
        expiryReminderSent: { $ne: true },
      }).exec();

      for (const user of usersToRemind) {
        const daysLeft = Math.ceil(
          (user.subscriptionExpiresAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
        );

        const sent = await emailService.sendExpiryReminder(user.email, user.subscriptionExpiresAt!, daysLeft);

        if (sent) {
          user.expiryReminderSent = true;
          await user.save();
          logger.info('Reaper: Expiry reminder sent', { email: user.email, daysLeft });
        }
      }
    } catch (error) {
      logger.error('Reaper: reminder sending error', { error: (error as Error).message });
    }
  }

  private timeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
  }
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const reaperService = new ReaperService();
