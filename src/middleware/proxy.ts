/**
 * Dynamic Reverse Proxy Middleware
 *
 * Routes incoming requests from user-specific subdomains to the correct
 * Docker container using http-proxy. Supports both HTTP and WebSocket traffic.
 *
 * IDLE TRACKING: Touches `lastRequestAt` on every proxied request
 * (throttled to once per 60s per subdomain to reduce DB writes).
 *
 * AUTO-WAKE: If a deployment is stopped/error and receives an HTTP request,
 * the proxy auto-wakes the agent and forwards the request once healthy.
 */

import httpProxy from 'http-proxy';
import { Request, Response, NextFunction } from 'express';
import { IncomingMessage } from 'http';
import { Deployment } from '@models/Deployment';
import { deploymentOrchestrator } from '@services/deployment';
import { logger } from '@utils/logger';
import { config } from '@config/index';
import { Socket } from 'net';

// ============================================================================
// Constants
// ============================================================================

const PROXY_TIMEOUT = 30000;
const CACHE_TTL = 5000;
const TOUCH_THROTTLE_MS = 60_000; // Only update lastRequestAt once per 60s per subdomain
const WAKE_TIMEOUT_MS = 60_000;   // Max time to wait for agent to wake up
const WAKE_POLL_INTERVAL_MS = 2000; // Poll interval while waiting for wake

// ============================================================================
// Types
// ============================================================================

interface CachedDeployment {
  port: number;
  status: string;
  timestamp: number;
}

// ============================================================================
// Proxy Manager Class
// ============================================================================

class ProxyManager {
  private proxy: httpProxy;
  private deploymentCache: Map<string, CachedDeployment> = new Map();

  // Throttle map: subdomain → last touch timestamp
  private lastTouchMap: Map<string, number> = new Map();

  // Track in-progress wake operations to prevent duplicate wakes
  private wakeInProgress: Map<string, Promise<boolean>> = new Map();

  constructor() {
    this.proxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      timeout: PROXY_TIMEOUT,
      proxyTimeout: PROXY_TIMEOUT,
    });

    this.setupErrorHandling();
  }

  // ==========================================================================
  // Idle Touch — throttled DB update
  // ==========================================================================

  /**
   * Update lastRequestAt in DB (at most once per TOUCH_THROTTLE_MS per subdomain).
   * Fire-and-forget — never blocks the request.
   */
  private touchLastRequest(subdomain: string): void {
    const now = Date.now();
    const lastTouch = this.lastTouchMap.get(subdomain) || 0;

    if (now - lastTouch < TOUCH_THROTTLE_MS) return; // throttled

    this.lastTouchMap.set(subdomain, now);

    // Fire-and-forget DB update
    Deployment.updateOne(
      { subdomain, status: 'healthy' },
      { $set: { lastRequestAt: new Date() } }
    ).exec().catch((err) => {
      logger.error('Failed to touch lastRequestAt', { subdomain, error: err.message });
    });
  }

  // ==========================================================================
  // Auto-Wake Logic
  // ==========================================================================

  /**
   * Attempt to wake a stopped/error deployment.
   * Deduplicates concurrent wake calls for the same subdomain.
   * Returns true if deployment became healthy, false otherwise.
   */
  private async wakeDeployment(subdomain: string): Promise<boolean> {
    // If a wake is already in progress for this subdomain, join it
    const existing = this.wakeInProgress.get(subdomain);
    if (existing) return existing;

    const wakePromise = this.doWakeDeployment(subdomain);
    this.wakeInProgress.set(subdomain, wakePromise);

    try {
      return await wakePromise;
    } finally {
      this.wakeInProgress.delete(subdomain);
    }
  }

  private async doWakeDeployment(subdomain: string): Promise<boolean> {
    try {
      const deployment = await Deployment.findBySubdomain(subdomain);
      if (!deployment) return false;

      // Only auto-wake stopped or error deployments
      if (deployment.status !== 'stopped' && deployment.status !== 'error') {
        return false;
      }

      logger.info('Auto-waking deployment', { subdomain, previousStatus: deployment.status });

      // Decrypt secrets and spawn agent (same path as website "Start" button)
      const secrets = await deployment.decryptSecrets();
      await deploymentOrchestrator.spawnAgent(
        deployment as any,
        secrets,
        deployment.config?.model as string,
        { cpuLimit: config.agent.cpuLimit, memoryLimit: config.agent.memoryLimit }
      );

      // Poll until healthy or timeout
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await this.delay(WAKE_POLL_INTERVAL_MS);
        const fresh = await Deployment.findBySubdomain(subdomain);
        if (fresh && fresh.status === 'healthy' && fresh.internalPort) {
          // Clear proxy cache so next lookup gets fresh port
          this.clearCache(subdomain);
          logger.info('Auto-wake successful', { subdomain });
          return true;
        }
        if (fresh && fresh.status === 'error') {
          logger.warn('Auto-wake failed — deployment errored', { subdomain });
          return false;
        }
      }

      logger.warn('Auto-wake timed out', { subdomain });
      return false;
    } catch (error) {
      logger.error('Auto-wake error', { subdomain, error: (error as Error).message });
      return false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Middleware
  // ==========================================================================

  middleware = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (req.originalUrl.startsWith('/api')) return next();
    const host = req.headers.host || '';
    const subdomain = this.extractSubdomain(host);

    logger.debug('Proxy middleware received request', {
      host, subdomain, path: req.path, method: req.method,
    });

    if (!subdomain || this.isMainDomain(subdomain)) {
      return next();
    }

    try {
      const deployment = await this.getDeployment(subdomain);

      if (!deployment) {
        logger.warn('Deployment not found for subdomain', { subdomain });
        return this.sendNotFound(res, subdomain);
      }

      if (deployment.status !== 'healthy') {
        // Auto-wake: attempt to start stopped/error deployments
        if (deployment.status === 'stopped' || deployment.status === 'error') {
          logger.info('Attempting auto-wake for request', { subdomain, method: req.method, path: req.path });
          const woke = await this.wakeDeployment(subdomain);
          if (woke) {
            // Re-fetch deployment to get updated port
            const freshDeployment = await this.getDeployment(subdomain);
            if (freshDeployment && freshDeployment.status === 'healthy') {
              this.touchLastRequest(subdomain);
              this.proxyRequest(req, res, freshDeployment.port, subdomain);
              return;
            }
          }
          // Wake failed or timed out
          res.status(503).json({
            success: false,
            error: {
              code: 'AGENT_WAKING',
              message: 'Agent is waking up but not ready yet. Please retry in a moment.',
            },
          });
          return;
        }

        return this.handleNonHealthyDeployment(res, deployment);
      }

      // ── Touch lastRequestAt (throttled) ──
      this.touchLastRequest(subdomain);

      this.proxyRequest(req, res, deployment.port, subdomain);
    } catch (error) {
      logger.error('Proxy error', { subdomain, error: (error as Error).message });
      res.status(502).json({
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to route request to agent' },
      });
    }
  };

  // ==========================================================================
  // WebSocket Handler
  // ==========================================================================

  handleUpgrade = async (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): Promise<void> => {
    const host = request.headers.host || '';
    const subdomain = this.extractSubdomain(host);

    logger.debug('WebSocket upgrade request', { host, subdomain });

    if (!subdomain || this.isMainDomain(subdomain)) {
      socket.destroy();
      return;
    }

    try {
      const deployment = await this.getDeployment(subdomain);

      if (!deployment || deployment.status !== 'healthy') {
        logger.warn('WebSocket upgrade failed - deployment not healthy', { subdomain });
        socket.destroy();
        return;
      }

      // Touch on WebSocket upgrade too
      this.touchLastRequest(subdomain);

      const target = `http://127.0.0.1:${deployment.port}`;

      this.proxy.ws(request, socket, head, { target }, (error) => {
        logger.error('WebSocket proxy error', { subdomain, error: (error as Error).message });
        socket.destroy();
      });
    } catch (error) {
      logger.error('WebSocket upgrade error', { subdomain, error: (error as Error).message });
      socket.destroy();
    }
  };

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private extractSubdomain(host: string): string | null {
    const cleanHost = host.split(':')[0];
    const parts = cleanHost.split('.');

    if (parts.length >= 3) return parts[0].toLowerCase();
    if (parts.length === 2 && parts[1] === 'localhost') return parts[0].toLowerCase();

    return null;
  }

  private isMainDomain(subdomain: string): boolean {
    const mainDomains = ['www', 'api', 'app', 'admin', 'dashboard', 'auth'];
    return mainDomains.includes(subdomain.toLowerCase());
  }

  private async getDeployment(
    subdomain: string
  ): Promise<{ port: number; status: string } | null> {
    const cached = this.deploymentCache.get(subdomain);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return { port: cached.port, status: cached.status };
    }

    const deployment = await Deployment.findBySubdomain(subdomain);
    if (!deployment || !deployment.internalPort) {
      // Still cache the status so auto-wake can detect stopped deployments
      if (deployment && !deployment.internalPort) {
        this.deploymentCache.set(subdomain, {
          port: 0,
          status: deployment.status,
          timestamp: Date.now(),
        });
        return { port: 0, status: deployment.status };
      }
      return null;
    }

    this.deploymentCache.set(subdomain, {
      port: deployment.internalPort,
      status: deployment.status,
      timestamp: Date.now(),
    });

    return { port: deployment.internalPort, status: deployment.status };
  }

  clearCache(subdomain: string): void {
    this.deploymentCache.delete(subdomain);
    logger.debug('Proxy cache cleared', { subdomain });
  }

  clearAllCache(): void {
    this.deploymentCache.clear();
    logger.debug('All proxy cache cleared');
  }

  // ==========================================================================
  // Response Handlers
  // ==========================================================================

  private sendNotFound(res: Response, subdomain: string): void {
    res.status(404).json({
      success: false,
      error: { code: 'DEPLOYMENT_NOT_FOUND', message: `No agent found for subdomain: ${subdomain}` },
    });
  }

  private handleNonHealthyDeployment(
    res: Response,
    deployment: { port: number; status: string }
  ): void {
    const statusMessages: Record<string, { status: number; message: string }> = {
      idle: { status: 503, message: 'Agent is idle. Please start the deployment.' },
      configuring: { status: 503, message: 'Agent is being configured...' },
      provisioning: { status: 503, message: 'Agent is provisioning...' },
      starting: { status: 503, message: 'Agent is starting up...' },
      restarting: { status: 503, message: 'Agent is restarting...' },
      stopped: { status: 503, message: 'Agent is stopped. It will auto-start when you use it.' },
      error: { status: 503, message: 'Agent encountered an error. Please check logs.' },
    };

    const response = statusMessages[deployment.status] || { status: 503, message: 'Agent is not ready.' };

    res.status(response.status).json({
      success: false,
      error: { code: 'AGENT_NOT_READY', message: response.message, status: deployment.status },
    });
  }

  private proxyRequest(req: Request, res: Response, port: number, subdomain: string): void {
    const target = `http://127.0.0.1:${port}`;

    logger.debug('Proxying request', { subdomain, target, path: req.path });

    this.proxy.web(req, res, { target }, (error) => {
      logger.error('Proxy web error', { subdomain, target, error: (error as Error).message });
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: { code: 'PROXY_ERROR', message: 'Failed to connect to agent. The agent may be restarting.' },
        });
      }
    });
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  private setupErrorHandling(): void {
    this.proxy.on('error', (err, req) => {
      logger.error('Proxy error event', { error: err.message, url: (req as Request).url });
    });

    this.proxy.on('proxyReq', (proxyReq, req) => {
      logger.debug('Proxy request initiated', { method: req.method, path: req.url, target: proxyReq.path });
    });

    this.proxy.on('proxyRes', (proxyRes, req) => {
      logger.debug('Proxy response received', { status: proxyRes.statusCode, path: (req as Request).url });
    });
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const proxyManager = new ProxyManager();
export const proxyMiddleware = proxyManager.middleware;
export const handleWebSocketUpgrade = proxyManager.handleUpgrade;

export default proxyManager;

