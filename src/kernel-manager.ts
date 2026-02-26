// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import type { IKernel, IKernelSpecs } from '@jupyterlite/services';

import type { IProviderRegistry, IToolRegistry } from '@jupyterlite/ai';

import { AI_AVATAR } from './icons';

// Import types from internal paths since @jupyterlite/ai doesn't export them publicly
// TODO: Upstream should export these types from the main entry point
import type { AISettingsModel } from '@jupyterlite/ai/lib/models/settings-model';
import type { AgentManagerFactory } from '@jupyterlite/ai/lib/agent';

import { AIKernel } from './ai-kernel';
import { createDisplayDataTool, DISPLAY_DATA_TOOL_NAME } from './tools';

/**
 * Interface for provider configuration (matching @jupyterlite/ai's IProviderConfig)
 */
interface IProviderConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
}

/**
 * Options for creating the AIKernelManager.
 */
export interface IAIKernelManagerOptions {
  /**
   * The kernel specs registry.
   */
  kernelSpecs: IKernelSpecs;

  /**
   * The AI settings model.
   */
  settingsModel: AISettingsModel;

  /**
   * The agent manager factory.
   */
  agentManagerFactory: AgentManagerFactory;

  /**
   * The provider registry.
   */
  providerRegistry?: IProviderRegistry;

  /**
   * The tool registry.
   */
  toolRegistry?: IToolRegistry;

  /**
   * The render MIME registry, used to get available MIME types.
   */
  renderMimeRegistry?: IRenderMimeRegistry;
}

/**
 * Manages dynamic AI kernel registration based on configured providers.
 */
export class AIKernelManager {
  constructor(options: IAIKernelManagerOptions) {
    this._kernelSpecs = options.kernelSpecs;
    this._settingsModel = options.settingsModel;
    this._agentManagerFactory = options.agentManagerFactory;
    this._providerRegistry = options.providerRegistry;
    this._toolRegistry = options.toolRegistry;
    this._renderMimeRegistry = options.renderMimeRegistry;

    // Register the display_data tool if tool registry is available
    // NOTE: This tool may be upstreamed to @jupyterlite/ai in the future
    if (this._toolRegistry) {
      // Get available MIME types from the registry if available
      const mimeTypes = this._renderMimeRegistry?.mimeTypes;
      this._toolRegistry.add(
        DISPLAY_DATA_TOOL_NAME,
        createDisplayDataTool(mimeTypes)
      );
    }

    // Register kernels for existing providers
    this._registerKernelsForProviders();

    // Listen for settings changes to register new providers
    this._settingsModel.stateChanged.connect(this._onSettingsChanged, this);
  }

  /**
   * Dispose of the manager.
   */
  dispose(): void {
    this._settingsModel.stateChanged.disconnect(this._onSettingsChanged, this);
  }

  /**
   * Register kernels for all configured providers.
   */
  private _registerKernelsForProviders(): void {
    const providers = this._settingsModel.config.providers;
    if (!Array.isArray(providers)) {
      return;
    }

    for (const provider of providers) {
      if (!Private.isProviderConfig(provider)) {
        continue;
      }
      this._registerKernelForProvider(provider);
    }
  }

  /**
   * Register a kernel for a specific provider configuration.
   */
  private _registerKernelForProvider(provider: IProviderConfig): void {
    if (!provider.id || !provider.name || !provider.model) {
      return;
    }

    const kernelName = `ai-${provider.id}`;
    const signature = Private.providerSignature(provider);
    const previousSignature = this._registeredKernelSignatures.get(kernelName);

    // Skip if there is no effective provider metadata change
    if (previousSignature === signature) {
      return;
    }

    // Build a more descriptive display name
    const displayName = `AI: ${provider.name} (${provider.model})`;

    this._kernelSpecs.register({
      spec: {
        name: kernelName,
        display_name: displayName,
        language: 'markdown',
        argv: [],
        resources: {
          'logo-32x32': AI_AVATAR,
          'logo-64x64': AI_AVATAR
        }
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        // Create a new agent manager for this kernel instance
        const agentManager = this._agentManagerFactory.createAgent({
          settingsModel: this._settingsModel,
          providerRegistry: this._providerRegistry,
          toolRegistry: this._toolRegistry,
          activeProvider: provider.id
        });

        return new AIKernel({
          ...options,
          agentManager,
          providerName: provider.name,
          modelName: provider.model
        });
      }
    });

    this._registeredKernelSignatures.set(kernelName, signature);
    if (previousSignature) {
      console.info(`Updated AI kernel: ${displayName}`);
    } else {
      console.info(`Registered AI kernel: ${displayName}`);
    }
  }

  /**
   * Handle settings changes to register new providers.
   */
  private _onSettingsChanged(): void {
    this._registerKernelsForProviders();
  }

  private _kernelSpecs: IKernelSpecs;
  private _settingsModel: AISettingsModel;
  private _agentManagerFactory: AgentManagerFactory;
  private _providerRegistry?: IProviderRegistry;
  private _toolRegistry?: IToolRegistry;
  private _renderMimeRegistry?: IRenderMimeRegistry;
  private _registeredKernelSignatures = new Map<string, string>();
}

namespace Private {
  export function isProviderConfig(value: unknown): value is IProviderConfig {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<IProviderConfig>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.provider === 'string' &&
      typeof candidate.model === 'string'
    );
  }

  export function providerSignature(provider: IProviderConfig): string {
    return `${provider.id}::${provider.name}::${provider.model}`;
  }
}
