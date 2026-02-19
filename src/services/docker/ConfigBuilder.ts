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
  memoryLimit: number; // bytes
}

export class ConfigBuilder {
  private readonly dataPath: string;

  // Hard cap for V8 old-space heap (per agent) in MB
  private static readonly MAX_NODE_HEAP_MB = 1536; // 1.5GB

  // Leave headroom for native memory (buffers, code space, mmap, jemalloc, etc.)
  // 128MB is a reasonable baseline; increase if you see container OOMKilled.
  private static readonly NON_HEAP_HEADROOM_MB = 128;

  // Percentage of remaining memory we allow for V8 heap
  private static readonly HEAP_RATIO = 0.75;

  // Round heap down to reduce fragmentation / keep stable
  private static readonly HEAP_ROUND_MB = 64;

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
   *
   * - If Docker memory limit is set: heap = floor((mem - headroom) * ratio)
   * - If Docker memory limit is not set (0): heap = cap (1.5GB) (still dynamic usage; only a max)
   * - Always clamp to [256MB .. 1536MB]
   * - Always ensure heap never exceeds (mem - headroom)
   */
  private computeNodeHeapMb(memoryLimitBytes: number): number {
    const memMb = Math.max(0, Math.floor(memoryLimitBytes / (1024 * 1024)));

    // No container memory limit -> still cap heap to 1.5GB
    if (!memMb) return ConfigBuilder.MAX_NODE_HEAP_MB;

    const usableMb = Math.max(0, memMb - ConfigBuilder.NON_HEAP_HEADROOM_MB);
    let heapMb = Math.floor(usableMb * ConfigBuilder.HEAP_RATIO);

    // Never exceed what the container can actually support
    heapMb = Math.min(heapMb, usableMb);

    // Hard cap to 1.5GB
    heapMb = Math.min(heapMb, ConfigBuilder.MAX_NODE_HEAP_MB);

    // Round down to 64MB blocks
    heapMb = Math.floor(heapMb / ConfigBuilder.HEAP_ROUND_MB) * ConfigBuilder.HEAP_ROUND_MB;

    // Minimum safety
    heapMb = Math.max(256, heapMb);

    // Final safety: if container is tiny, don’t set heap bigger than usable
    heapMb = Math.min(heapMb, Math.max(256, usableMb));

    return heapMb;
  }

  private buildEnvironmentVariables(
    deploymentId: string,
    secrets: IDecryptedSecrets,
    model: string,
    memoryLimitBytes: number
  ): string[] {
    const safeToken = secrets.webUiToken || DEFAULTS.FALLBACK_TOKEN;

    const heapMb = this.computeNodeHeapMb(memoryLimitBytes);

    const env: string[] = [
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
