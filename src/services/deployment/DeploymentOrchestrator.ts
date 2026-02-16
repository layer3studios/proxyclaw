/**
 * Deployment Orchestrator Service
 * High-level orchestration of deployment lifecycle.
 *
 * CAPACITY GATE: Enforces MAX_RUNNING_AGENTS to protect the server from overload.
 */

import { Deployment } from '@models/Deployment';
import { portManager } from '../PortManager';
import { containerManager } from '../docker/ContainerManager';
import { configGenerator } from './ConfigGenerator';
import { stateManager } from './StateManager';
import { healthChecker } from '../docker/HealthChecker';
import { logger } from '@utils/logger';
import { config } from '@config/index';
import { IDecryptedSecrets } from '../../types';
import { DEPLOYMENT_STATES } from '@utils/constants';
import { validateAndNormalizeModel } from '@utils/validation';
import { PortAllocationError, DeploymentError } from '@utils/errors';

export interface ResourceLimits {
  cpuLimit: number;
  memoryLimit: number;
}

export class DeploymentOrchestrator {

  /**
   * Check how many agents are currently running (healthy/starting/provisioning/configuring).
   */
  private async getRunningAgentCount(): Promise<number> {
    return Deployment.countDocuments({
      status: { $in: ['healthy', 'starting', 'provisioning', 'configuring', 'restarting'] },
      containerId: { $exists: true, $ne: null },
    });
  }

  /**
   * Spawn a new agent deployment.
   * Enforces MAX_RUNNING_AGENTS before proceeding.
   */
  public async spawnAgent(
    deployment: InstanceType<typeof Deployment>,
    secrets: IDecryptedSecrets,
    model?: string,
    resourceLimits?: ResourceLimits
  ): Promise<string> {
    const deploymentId = deployment._id.toString();
    const subdomain = deployment.subdomain;

    logger.info('Starting agent deployment', { deploymentId, subdomain, resourceLimits });

    // ── MAX_RUNNING_AGENTS CHECK ──
    const maxRunning = config.capacity.maxRunningAgents;
    const currentRunning = await this.getRunningAgentCount();

    if (currentRunning >= maxRunning) {
      const msg = `Server at capacity (${currentRunning}/${maxRunning} agents running). Please try again in a few minutes.`;
      logger.warn('Spawn blocked — server at capacity', { deploymentId, currentRunning, maxRunning });
      await stateManager.markAsError(deployment, msg);
      throw new DeploymentError(msg, 'CAPACITY_FULL', 503);
    }

    try {
      // Step 1: Cleanup zombies
      await this.cleanupZombieResources(deployment);

      // Step 2: Configuring
      await stateManager.transitionTo(deployment, DEPLOYMENT_STATES.CONFIGURING, {
        provisioningStep: 'Allocating resources...',
      });

      // Step 3: Allocate port
      const port = await this.allocatePortForDeployment(deployment);

      // Step 4: Normalize model
      const normalizedModel = validateAndNormalizeModel(model, secrets);

      // Step 5: Generate configs
      await stateManager.updateProvisioningStep(deployment, 'Generating configuration...');
      await configGenerator.generateConfigs(
        deploymentId, subdomain, secrets, normalizedModel,
        deployment.config?.systemPrompt as string
      );

      // Step 6: Provisioning
      await stateManager.transitionTo(deployment, DEPLOYMENT_STATES.PROVISIONING, {
        provisioningStep: 'Pulling image...',
      });
      await stateManager.updateProvisioningStep(deployment, 'Starting container...');

      // Step 7: Create + start container with plan resources
      const containerId = await containerManager.createAndStart(
        deployment, port, secrets, normalizedModel, resourceLimits
      );

      // Step 8: Save container info
      deployment.containerId = containerId;
      deployment.internalPort = port;
      await deployment.save();

      // Step 9: Health checks
      await stateManager.transitionTo(deployment, DEPLOYMENT_STATES.STARTING, {
        provisioningStep: 'Health checking...',
      });

      healthChecker.startHealthChecks(deploymentId, port, async () => {
        await stateManager.transitionTo(deployment, DEPLOYMENT_STATES.HEALTHY);
      });

      logger.info('Agent deployment initiated', { deploymentId, containerId });
      return containerId;
    } catch (error) {
      logger.error('Agent deployment failed', { deploymentId, error: (error as Error).message });
      await this.handleDeploymentFailure(deployment, error as Error);
      throw error;
    }
  }

  public async stopDeployment(deployment: InstanceType<typeof Deployment>): Promise<void> {
    const deploymentId = deployment._id.toString();
    logger.info('Stopping deployment', { deploymentId });

    if (!stateManager.canStop(deployment.status as any)) {
      throw new DeploymentError(`Cannot stop deployment in ${deployment.status} state`, 'INVALID_STATE');
    }

    try {
      await containerManager.stop(deployment);
      await stateManager.transitionTo(deployment, DEPLOYMENT_STATES.STOPPED);
      logger.info('Deployment stopped', { deploymentId });
    } catch (error) {
      await stateManager.markAsError(deployment, (error as Error).message);
      throw error;
    }
  }

  public async restartDeployment(deployment: InstanceType<typeof Deployment>): Promise<void> {
    const deploymentId = deployment._id.toString();
    logger.info('Restarting deployment', { deploymentId });

    try {
      if (!deployment.containerId) {
        logger.info('No existing container, performing full respawn', { deploymentId });
        const secrets = await deployment.decryptSecrets();
        await this.spawnAgent(deployment, secrets, deployment.config?.model as string);
        return;
      }

      if (!stateManager.canRestart(deployment.status as any)) {
        throw new DeploymentError(`Cannot restart deployment in ${deployment.status} state`, 'INVALID_STATE');
      }

      await stateManager.transitionTo(deployment, DEPLOYMENT_STATES.RESTARTING);
      await containerManager.restart(deployment);
      logger.info('Deployment restarted', { deploymentId });
    } catch (error) {
      await stateManager.markAsError(deployment, (error as Error).message);
      throw error;
    }
  }

  public async removeDeployment(deployment: InstanceType<typeof Deployment>): Promise<void> {
    const deploymentId = deployment._id.toString();
    logger.info('Removing deployment', { deploymentId });

    try {
      await containerManager.remove(deployment);
      if (deployment.internalPort) portManager.releasePort(deployment.internalPort);
      deployment.containerId = undefined;
      deployment.internalPort = undefined;
      await deployment.save();
      logger.info('Deployment removed', { deploymentId });
    } catch (error) {
      logger.error('Failed to remove deployment', { deploymentId, error: (error as Error).message });
      throw error;
    }
  }

  private async allocatePortForDeployment(deployment: InstanceType<typeof Deployment>): Promise<number> {
    const deploymentId = deployment._id.toString();
    try {
      const port = await portManager.allocatePort();
      const reserved = await portManager.atomicReservePort(deploymentId, port);
      if (!reserved) {
        logger.warn('Atomic reservation failed, forcing', { deploymentId, port });
        await Deployment.updateOne({ _id: deploymentId }, { $set: { internalPort: port } });
      }
      logger.info('Port allocated', { deploymentId, port });
      return port;
    } catch (error) {
      throw new PortAllocationError(`Failed to allocate port: ${(error as Error).message}`);
    }
  }

  private async cleanupZombieResources(deployment: InstanceType<typeof Deployment>): Promise<void> {
    const deploymentId = deployment._id.toString();
    await containerManager.cleanupZombieContainer(deploymentId);
    await Deployment.updateOne({ _id: deploymentId }, { $unset: { internalPort: '', containerId: '' } });
    logger.debug('Zombie resources cleaned up', { deploymentId });
  }

  private async handleDeploymentFailure(deployment: InstanceType<typeof Deployment>, error: Error): Promise<void> {
    const deploymentId = deployment._id.toString();
    logger.error('Handling deployment failure', { deploymentId, error: error.message });
    try {
      if (deployment.containerId) await containerManager.remove(deployment);
      if (deployment.internalPort) portManager.releasePort(deployment.internalPort);
      if (error.message?.includes('port is already allocated')) {
        logger.warn('Port collision detected', { deploymentId });
      }
      await stateManager.markAsError(deployment, error.message);
    } catch (cleanupError) {
      logger.error('Error during cleanup', { deploymentId, error: (cleanupError as Error).message });
    }
  }
}

export const deploymentOrchestrator = new DeploymentOrchestrator();
export default deploymentOrchestrator;
