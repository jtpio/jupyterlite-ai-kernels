// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import type { IKernel, IKernelSpecs } from '@jupyterlite/services';

import {
  AI_AVATAR,
  ToolRegistry,
  type IAISettingsModel,
  type IAgentManagerFactory,
  type IProviderConfig,
  type IProviderRegistry,
  type IToolRegistry
} from '@jupyternaut/agent';

import { AIKernel } from './ai-kernel';
import { createDisplayDataTool, DISPLAY_DATA_TOOL_NAME } from './tools';

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
  settingsModel: IAISettingsModel;

  /**
   * The agent manager factory.
   */
  agentManagerFactory: IAgentManagerFactory;

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

    this._registerKernelsForProviders();
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
    for (const provider of this._settingsModel.providers) {
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
    const signature = `${provider.id}::${provider.name}::${provider.model}`;
    const previousSignature = this._registeredKernelSignatures.get(kernelName);
    if (previousSignature === signature) {
      return;
    }

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
        const agentManager = this._agentManagerFactory.createAgent({
          settingsModel: this._settingsModel,
          providerRegistry: this._providerRegistry,
          toolRegistry: this._createKernelToolRegistry(),
          activeProvider: provider.id,
          renderMimeRegistry: this._renderMimeRegistry
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
   * Create a tool registry with the shared tools plus the kernel-only tools.
   */
  private _createKernelToolRegistry(): IToolRegistry {
    const registry = new ToolRegistry();
    for (const [name, tool] of Object.entries(
      this._toolRegistry?.tools ?? {}
    )) {
      registry.add(name, tool);
    }
    registry.add(
      DISPLAY_DATA_TOOL_NAME,
      createDisplayDataTool(this._renderMimeRegistry?.mimeTypes)
    );
    return registry;
  }

  /**
   * Handle settings changes to register new providers.
   */
  private _onSettingsChanged(): void {
    this._registerKernelsForProviders();
  }

  private _kernelSpecs: IKernelSpecs;
  private _settingsModel: IAISettingsModel;
  private _agentManagerFactory: IAgentManagerFactory;
  private _providerRegistry?: IProviderRegistry;
  private _toolRegistry?: IToolRegistry;
  private _renderMimeRegistry?: IRenderMimeRegistry;
  private _registeredKernelSignatures = new Map<string, string>();
}
