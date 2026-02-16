/**
 * Container Manager Service
 * Handles container lifecycle operations (start, stop, restart, remove)
 */

import fs from 'fs/promises';
import path from 'path';
import { dockerClient } from './DockerClient';
import { configBuilder } from './ConfigBuilder';
import { healthChecker } from './HealthChecker';
import { imageManager } from './ImageManager';
import { logger } from '@utils/logger';
import { Deployment } from '@models/Deployment';
import { IDecryptedSecrets } from '../../types';
import { TIMEOUTS, DOCKER } from '@utils/constants';
import { ContainerError } from '@utils/errors';

export interface ResourceLimits {
  cpuLimit: number;
  memoryLimit: number;
}

export class ContainerManager {
  public async createAndStart(
    deployment: InstanceType<typeof Deployment>,
    port: number,
    secrets: IDecryptedSecrets,
    model: string,
    resourceLimits?: ResourceLimits
  ): Promise<string> {
    const deploymentId = deployment._id.toString();
    const containerName = configBuilder.getContainerName(deploymentId);

    logger.info('Creating container', { deploymentId, containerName, resourceLimits });

    try {
      await imageManager.ensureImageExists();

      const containerConfig = configBuilder.buildContainerConfig(
        containerName, port, deploymentId, secrets, model, resourceLimits
      );

      const container = await dockerClient.createContainer(containerConfig);
      const containerId = container.id;

      logger.info('Container created', { deploymentId, containerId });
      await dockerClient.startContainer(containerId);
      logger.info('Container started', { deploymentId, containerId });

      return containerId;
    } catch (error) {
      logger.error('Failed to create/start container', { deploymentId, error: (error as Error).message });
      throw error;
    }
  }

  public async stop(deployment: InstanceType<typeof Deployment>): Promise<void> {
    if (!deployment.containerId) {
      logger.warn('No container to stop', { deploymentId: deployment._id });
      return;
    }

    const deploymentId = deployment._id.toString();
    healthChecker.stopHealthChecks(deploymentId);

    try {
      await dockerClient.stopContainer(deployment.containerId, TIMEOUTS.CONTAINER_STOP);
      logger.info('Container stopped', { deploymentId, containerId: deployment.containerId });
    } catch (error) {
      if ((error as ContainerError).message?.includes('already stopped')) {
        logger.debug('Container already stopped', { deploymentId });
      } else {
        throw error;
      }
    }
  }

  public async restart(deployment: InstanceType<typeof Deployment>): Promise<void> {
    if (!deployment.containerId) throw new ContainerError('No container to restart', 'restart');

    const deploymentId = deployment._id.toString();

    try {
      const exists = await dockerClient.containerExists(deployment.containerId);
      if (!exists) {
        logger.warn('Container not found, cannot restart', { deploymentId });
        throw new ContainerError('Container not found', 'restart');
      }

      await dockerClient.restartContainer(deployment.containerId, TIMEOUTS.CONTAINER_RESTART);
      logger.info('Container restarted', { deploymentId, containerId: deployment.containerId });

      if (deployment.internalPort) {
        healthChecker.startHealthChecks(deploymentId, deployment.internalPort, async () => {
          await deployment.transitionTo('healthy');
        });
      }
    } catch (error) {
      logger.error('Failed to restart container', { deploymentId, error: (error as Error).message });
      throw error;
    }
  }

  public async remove(deployment: InstanceType<typeof Deployment>): Promise<void> {
    if (!deployment.containerId) {
      logger.debug('No container to remove', { deploymentId: deployment._id });
      return;
    }

    const deploymentId = deployment._id.toString();
    healthChecker.stopHealthChecks(deploymentId);

    try {
      await dockerClient.removeContainer(deployment.containerId, true);
      logger.info('Container removed', { deploymentId, containerId: deployment.containerId });
      await this.cleanupDataDirectory(deploymentId);
    } catch (error) {
      if ((error as ContainerError).message?.includes('not found')) {
        logger.debug('Container does not exist', { deploymentId });
      } else {
        throw error;
      }
    }
  }

  public async getLogs(deployment: InstanceType<typeof Deployment>, tail: number = 100): Promise<string> {
    if (!deployment.containerId) return 'No container available';
    try {
      return await dockerClient.getContainerLogs(deployment.containerId, { tail, timestamps: true });
    } catch (error) {
      return `Error fetching logs: ${(error as Error).message}`;
    }
  }

  public async getStats(containerId: string): Promise<{ cpu: number; memory: number }> {
    try {
      await dockerClient.getContainerStats(containerId);
      return { cpu: 0, memory: 0 };
    } catch (error) {
      logger.error('Failed to get container stats', { containerId, error: (error as Error).message });
      return { cpu: 0, memory: 0 };
    }
  }

  public async cleanupZombieContainer(deploymentId: string): Promise<void> {
    const containerName = configBuilder.getContainerName(deploymentId);
    try {
      const exists = await dockerClient.containerExists(containerName);
      if (exists) {
        logger.warn('Found zombie container, removing...', { containerName });
        await dockerClient.removeContainer(containerName, true);
        logger.info('Zombie container removed', { containerName });
      }
    } catch (error) {
      logger.error('Failed to cleanup zombie container', { containerName, error: (error as Error).message });
    }
  }

  public async listManagedContainers(): Promise<any[]> {
    const allContainers = await dockerClient.listContainers({ all: true });
    return allContainers.filter(c => c.Names.some(name => name.startsWith(`/${DOCKER.CONTAINER_PREFIX}`)));
  }

  private async cleanupDataDirectory(deploymentId: string): Promise<void> {
    const dataDir = configBuilder.getDataDir(deploymentId);
    try {
      await fs.rm(path.dirname(dataDir), { recursive: true, force: true });
      logger.info('Data directory cleaned up', { deploymentId, dataDir });
    } catch (error) {
      logger.warn('Failed to cleanup data directory', { deploymentId, error: (error as Error).message });
    }
  }
}

export const containerManager = new ContainerManager();
export default containerManager;
