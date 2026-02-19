/**
 * Create Deployment Handler
 * PAYMENT GATE: Rejects if user has not paid.
 */

import { Request, Response, NextFunction } from 'express';
import { Deployment } from '@models/Deployment';
import { User } from '@models/User';
import { deploymentOrchestrator } from '@services/deployment';
import { cryptoService } from '@utils/crypto';
import { logger } from '@utils/logger';
import { config } from '@config/index';
import {
  validateApiKeys, validateAndNormalizeModel, sanitizeSubdomain,
} from '@utils/validation';
import { ConflictError, ForbiddenError, NotFoundError } from '@utils/errors';
import { ApiResponse, DeploymentStatusResponse } from '../../types';

export async function createDeployment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const { name, model, openaiApiKey, anthropicApiKey, googleApiKey, telegramBotToken } = req.body;

    // PAYMENT GATE
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    if (user.subscriptionStatus !== 'active' || (user.subscriptionExpiresAt && new Date() > user.subscriptionExpiresAt)) {
      throw new ForbiddenError('Your subscription is not active. Go to Plans tab to subscribe or renew.');
    }

    const canCreate = await user.canCreateAgent();
    if (!canCreate.allowed) throw new ForbiddenError(canCreate.reason || 'Cannot create deployment');

    // GLOBAL DEPLOYMENT CAPACITY GATE
    const maxDeployments = config.capacity.maxDeployments;
    const totalDeployments = await Deployment.countDocuments({});
    if (totalDeployments >= maxDeployments) {
      throw new ForbiddenError(`All ${maxDeployments} deployment slots are taken. No new deployments can be created.`);
    }

    // Validate
    const subdomain = sanitizeSubdomain(name);
    const existing = await Deployment.findOne({ subdomain });
    if (existing) throw new ConflictError('Subdomain already taken');

    const secrets = { openaiApiKey, anthropicApiKey, googleApiKey, telegramBotToken };
    validateApiKeys(secrets);
    const normalizedModel = validateAndNormalizeModel(model, secrets);
    const webUiToken = cryptoService.generateToken(32);

    // Create
    const deployment = new Deployment({
      user: userId, subdomain, status: 'idle',
      secrets: { ...secrets, webUiToken },
      config: { model: normalizedModel, systemPrompt: 'You are a helpful AI assistant.' },
    });
    await deployment.save();

    // Spawn with fixed resource limits
    setImmediate(async () => {
      try {
        const decryptedSecrets = await deployment.decryptSecrets();
        await deploymentOrchestrator.spawnAgent(
          deployment, decryptedSecrets, normalizedModel,
          { cpuLimit: config.agent.cpuLimit, memoryLimit: config.agent.memoryLimit }
        );
      } catch (error) {
        logger.error('Async spawn failed', { deploymentId: deployment._id.toString(), error: (error as Error).message });
      }
    });

    res.status(201).json({
      success: true,
      data: {
        id: deployment._id.toString(),
        subdomain: deployment.subdomain,
        status: deployment.status as any,
        createdAt: deployment.createdAt.toISOString(),
      },
    } as ApiResponse<DeploymentStatusResponse>);
  } catch (error) { next(error); }
}

export default createDeployment;
