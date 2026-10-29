// @effect-diagnostics nodeBuiltinImport:off -- Pins the supplied ablation report tool catalog.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer, McpSchema } from "effect/ai";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import { WorkflowApprovalGate } from "../orchestration-v2/WorkflowApprovalGate.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StorageCleanup } from "../storageCleanup.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { DocumentText } from "./DocumentText.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import budget from "./agentContextBudget.json" with { type: "json" };

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-context-budget-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(StorageCleanup)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
  Layer.mock(WorkflowApprovalGate)({}),
).pipe(Layer.provideMerge(NodeServices.layer));

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "budget", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "budget", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const claudeSystemAppend = (workflows = false) => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    workflowsAvailable: workflows,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexAdditionalContext = (workflows = false) =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true, workflows },
    ),
  )
    .map((entry) => entry.value)
    .join("");

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
it.effect.each([false, true])("agent context matches its budget when workflows=%s", (workflows) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const advertised = yield* McpHttpServer.toolsForCaller(
      mcp.tools
        .filter(
          ({ annotations }) =>
            Context.getOrUndefined(
              annotations,
              McpSchema.EnabledWhen,
            )?.(client.initializePayload) !== false,
        )
        .map(({ tool }) => tool),
    );
    const measured = {
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend(workflows)),
      codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext(workflows)),
      // The model sees these fields. outputSchema and annotations are protocol metadata.
      mcpToolListJsonBytes: utf8Bytes(
        JSON.stringify(
          advertised.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      ),
    };

    if (workflows) {
      // The ablation catalog, with workflow_start updated for callback-scoped progress.
      const expected = {
        delegate_task: "6f83830505b869c81dac98847c7ec9b88f244a33505aba3c26e1cee2d92227a1",
        delegate_tasks: "e7251b8547635577fc2914a9fd0cb058c36bb3618308ccb0eb6c8ff289e71146",
        task_wait: "4b88f18d8ec39ca2e4b104e0578a9e13282316a6603b6da0b99d5419340c97a3",
        workflow_start: "5e04ceee2d6748093bc522ee7c7af7f2f8d70a5c00b1ebfcf0924e566c2396b2",
        workflow_status: "ecc96395ab4a603896377c9b77548913813eab8874f757167f8c79ee8da99e9c",
        workflow_stop: "8370d8ffc7f9aafde23cc4f0a2d294a46c009fd3daaa7e80c20da9793d3fd1ae",
        graph_review: "1fee075670c447d19e5bb644b2d1f29e23a80bacc4f394b21c570a5a67546518",
        graph_start: "c7f0918aa9861c38999d142e6079cc455f67c552ea5a4fbe4c717c00b85a372b",
        create_threads: "1ac22ad0de594beb374692af1f768e2493d3f225a708f4cc40f3aa2c05110ee8",
        t3_worktree_remove: "8db2aa11f6b4aa14946f11cfa64d72c2e75fd8f3ce34b4eeccf6137d3dd9657f",
      };
      for (const [name, digest] of Object.entries(expected)) {
        const { tool } = mcp.tools.find(({ tool }) => tool.name === name)!;
        const advertised = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
        expect(
          NodeCrypto.createHash("sha256").update(JSON.stringify(advertised)).digest("hex"),
          tool.name,
        ).toBe(digest);
      }
    }
    expect(measured).toEqual(
      workflows
        ? {
            claudeSystemAppendBytes: 5432,
            codexAdditionalContextBytes: 7078,
            mcpToolListJsonBytes: budget.workflowMcpToolListJsonBytes,
          }
        : {
            claudeSystemAppendBytes: budget.claudeSystemAppendBytes,
            codexAdditionalContextBytes: budget.codexAdditionalContextBytes,
            mcpToolListJsonBytes: budget.mcpToolListJsonBytes,
          },
    );
    const names = mcp.tools
      .filter(
        ({ annotations }) =>
          Context.getOrUndefined(annotations, McpSchema.EnabledWhen)?.(client.initializePayload) !==
          false,
      )
      .map(({ tool }) => tool.name);
    for (const name of [
      "delegate_tasks",
      "task_wait",
      "workflow_start",
      "workflow_status",
      "workflow_stop",
      "graph_review",
      "graph_start",
      "t3_worktree_remove",
    ]) {
      expect(names.includes(name)).toBe(workflows);
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(workflows)),
    Effect.provide(budgetLayer(workflows)),
  ),
);

const invocation = (workflows: boolean): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("budget"),
  capabilities: new Set<McpInvocationContext.McpCapability>([
    "orchestration",
    "preview",
    "device",
    "worktree",
    "pull-requests",
    ...(workflows ? ["workflows" as const] : []),
  ]),
  issuedAt: 0,
  requestNamespace: "budget",
  thread: {
    threadId: ThreadId.make("budget"),
    providerSessionId: "budget",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});
const budgetLayer = (workflows: boolean) =>
  McpHttpServer.layerTools.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(toolHandlerServices),
    Layer.provide(ServerSettingsService.layerTest({ workflows })),
  );

it.effect("hidden workflow tools are not found with the default capability set", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    for (const name of [
      "delegate_tasks",
      "task_wait",
      "workflow_start",
      "workflow_status",
      "workflow_stop",
      "graph_review",
      "graph_start",
      "t3_worktree_remove",
    ]) {
      const error = yield* mcp
        .callTool({ name, arguments: {} })
        .pipe(Effect.flip, Effect.provideService(McpSchema.McpServerClient, client));
      expect(error.message).toContain("not found");
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(false)),
    Effect.provide(budgetLayer(false)),
  ),
);
