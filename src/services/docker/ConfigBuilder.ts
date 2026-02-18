/**
 * Container Configuration Builder
 * Builds Docker container configurations for agent deployments.
 * Default resources: 0.75 vCPU / 768 MB (overridden per-plan).
 */

import path from 'path';
import { DOCKER, AGENT, DEFAULTS } from '@utils/constants';
import { IDecryptedSecrets, ContainerConfig } from '../../types';
import { logger } from '@utils/logger';

export interface ResourceLimits {
  cpuLimit: number;
  memoryLimit: number;
}

export class ConfigBuilder {
  private readonly dataPath: string;

  constructor() {
    this.dataPath = path.resolve(process.cwd(), DOCKER.DATA_PATH);
  }

  public buildContainerConfig(
    containerName: string,
    hostPort: number,
    deploymentId: string,
    secrets: IDecryptedSecrets,
    model: string,
    resourceLimits?: ResourceLimits
  ): ContainerConfig {
    const cpuLimit = resourceLimits?.cpuLimit ?? AGENT.CPU_LIMIT;
    const memoryLimit = resourceLimits?.memoryLimit ?? AGENT.MEMORY_LIMIT;

    const env = this.buildEnvironmentVariables(deploymentId, secrets, model, memoryLimit);
    const binds = this.buildVolumeMounts(deploymentId);

    const hostConfig = this.buildHostConfig(hostPort, binds, cpuLimit, memoryLimit);

    logger.debug('Building container config', {
      containerName,
      hostPort,
      deploymentId,
      model,
      cpuLimit,
      memoryLimit,
      nodeOptions: env.find((e) => e.startsWith('NODE_OPTIONS=')),
    });

    return {
      Image: DOCKER.AGENT_IMAGE,
      name: containerName,
      User: this.getUserConfig(),
      Env: env,
      HostConfig: hostConfig,
      ExposedPorts: { [`${AGENT.INTERNAL_PORT}/tcp`]: {} },
    };
  }

  /**
   * Compute a safe Node.js heap size from container memory limit.
   * - Convert bytes -> MB
   * - Allocate ~75% to V8 heap (headroom for native, buffers, code space, etc.)
   * - Minimum 256MB
   * - Small extra safety: subtract 64MB before applying ratio (optional)
   */
  private computeNodeHeapMb(memoryLimitBytes: number): number {
    const memoryLimitMb = Math.max(0, Math.floor(memoryLimitBytes / (1024 * 1024)));

    // If memoryLimit wasn't set (0), fall back to a sane default
    if (!memoryLimitMb) return 512;

    const headroomMb = Math.max(0, memoryLimitMb - 64);
    const heapMb = Math.floor(headroomMb * 0.75);

    return Math.max(256, heapMb);
  }

  private buildEnvironmentVariables(
    deploymentId: string,
    secrets: IDecryptedSecrets,
    model: string,
    memoryLimitBytes: number
  ): string[] {
    const safeToken = secrets.webUiToken || DEFAULTS.FALLBACK_TOKEN;

    const heapMb = this.computeNodeHeapMb(memoryLimitBytes);

    const env = [
      `OPENCLAW_CONFIG_PATH=/config/openclaw.json`,
      `DEPLOYMENT_ID=${deploymentId}`,
      `NODE_ENV=production`,
      `OPENCLAW_GATEWAY_TOKEN=${safeToken}`,
      `NODE_OPTIONS=--max-old-space-size=${heapMb}`,
    ];

    if (secrets.googleApiKey) {
      env.push(`GOOGLE_API_KEY=${secrets.googleApiKey}`, `GOOGLE_GENAI_API_KEY=${secrets.googleApiKey}`);
    }
    if (secrets.anthropicApiKey) env.push(`ANTHROPIC_API_KEY=${secrets.anthropicApiKey}`);
    if (secrets.openaiApiKey) env.push(`OPENAI_API_KEY=${secrets.openaiApiKey}`);
    if (secrets.telegramBotToken) env.push(`TELEGRAM_BOT_TOKEN=${secrets.telegramBotToken}`);

    return env;
  }

  private buildVolumeMounts(deploymentId: string): string[] {
    const hostConfigPath = path.join(this.dataPath, deploymentId, 'config');
    const hostDataPath = path.join(this.dataPath, deploymentId, 'data');
    const internalDataPath = this.getInternalDataPath();

    return [
      `${hostConfigPath}:/config:rw`,
      `${hostDataPath}:${internalDataPath}:rw`,
    ];
  }

  private buildHostConfig(
    hostPort: number,
    binds: string[],
    cpuLimit: number,
    memoryLimit: number
  ): ContainerConfig['HostConfig'] {
    return {
      Binds: binds,
      PortBindings: { [`${AGENT.INTERNAL_PORT}/tcp`]: [{ HostPort: hostPort.toString() }] },
      Memory: memoryLimit,
      NanoCpus: cpuLimit,
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: AGENT.MAX_RESTARTS },
    };
  }

  private getUserConfig(): string | undefined {
    return process.platform === 'win32' ? '0' : undefined;
  }

  private getInternalDataPath(): string {
    return process.platform === 'win32' ? '/root/.openclaw' : '/home/node/.openclaw';
  }

  public getContainerName(deploymentId: string): string {
    return `${DOCKER.CONTAINER_PREFIX}${deploymentId}`;
  }

  public getConfigDir(deploymentId: string): string {
    return path.join(this.dataPath, deploymentId, 'config');
  }

  public getDataDir(deploymentId: string): string {
    return path.join(this.dataPath, deploymentId, 'data');
  }

  public getWorkspaceDir(deploymentId: string): string {
    return path.join(this.getDataDir(deploymentId), 'workspace', 'memory');
  }

  public getAgentAuthDir(deploymentId: string): string {
    return path.join(this.getDataDir(deploymentId), 'agents', 'main', 'agent');
  }

  public getLegacyAuthDir(deploymentId: string): string {
    return path.join(this.getDataDir(deploymentId), 'agent');
  }
}

export const configBuilder = new ConfigBuilder();
export default configBuilder;
