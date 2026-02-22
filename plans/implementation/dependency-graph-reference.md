# Dependency Graph Reference: mini-coder Codebase

This document sketches the expected dependency graph for the mini-coder project. It serves as a **test oracle** for Phase 3's `resolveDependencies()` implementation — when the TypeScript plugin produces edges matching this reference, we know it's working correctly.

---

## 1. Edge Types (DependencyEdge.kind)

| kind | Description | Example |
|------|-------------|---------|
| `imports` | Symbol A's file imports symbol B (or its module) | `CodingAgent` imports `AgentConfig` from `./types.js` |
| `calls` | Symbol A invokes symbol B | `runTurn` calls `modelClient.chat` |
| `references` | Symbol A uses type B (parameter, return type, variable) | `parseResponse` references `ModelResponse`, `ToolCall` |
| `extends` | Class A extends class B | (none in mini-coder) |
| `implements` | Class A implements interface B | `AnthropicModelClient` implements `ModelClient` |

---

## 2. File-Level Import Graph

```
src/index.ts
  imports: CodingAgent, loadAgentConfig, createModelClient, ToolRegistry

src/agent/agent.ts
  imports: buildSystemPrompt, ensureStepWithinLimit, Session, ToolRegistry
  imports (types): AgentConfig, ModelClient, ToolCall

src/agent/config.ts
  imports: access, readFile, path, process, fileURLToPath, dotenv
  imports (types): AgentConfig

src/agent/types.ts
  (no imports — defines types only)

src/model/client.ts
  imports: process, setTimeout, Anthropic
  imports (types): AgentConfig, ModelClient, ModelResponse, SessionMessage, ToolCall, ToolSchema

src/session/session.ts
  imports: randomUUID
  imports (types): SessionMessage

src/prompt/system-prompt.ts
  imports: existsSync, path
  imports (types): AgentConfig, ToolSchema

src/safety/guardrails.ts
  imports: path

src/tools/registry.ts
  imports (types): AgentConfig, ToolDefinition, ToolSchema
  imports: createEditFileTool, createListFilesTool, createReadFileTool, createRunCommandTool, createSearchTool, createWriteFileTool

src/tools/read-file.ts
  imports: readFile, stat
  imports (types): AgentConfig, ToolDefinition
  imports: resolveWorkspacePath, validateFileReadSize
  imports: expectNonEmptyString, expectOptionalNumber, formatWithLineNumbers
```

---

## 3. Symbol-Level Dependency Edges

### 3.1 Entry Point: `src/index.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `runSingleTurn` | calls | `loadAgentConfig` | config loading |
| `runSingleTurn` | calls | `createModelClient` | model client factory |
| `runSingleTurn` | calls | `ToolRegistry.createDefault` | tool setup |
| `runSingleTurn` | calls | `CodingAgent` (constructor) | agent instantiation |
| `runSingleTurn` | calls | `agent.runTurn` | main loop |
| `runSingleTurn` | references | `AgentConfig` | param type |
| `runInteractive` | (same as above) | | |
| `main` | calls | `runSingleTurn`, `runInteractive` | |

### 3.2 Agent: `src/agent/agent.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `CodingAgent` | implements | `(implicit — uses ModelClient, AgentConfig interfaces)` | |
| `CodingAgent.constructor` | references | `AgentConfig`, `ModelClient`, `ToolRegistry`, `Session` | param types |
| `CodingAgent.runTurn` | calls | `buildSystemPrompt` | prompt construction |
| `CodingAgent.runTurn` | calls | `ensureStepWithinLimit` | safety check |
| `CodingAgent.runTurn` | calls | `session.trim` | context management |
| `CodingAgent.runTurn` | calls | `modelClient.chat` | model invocation |
| `CodingAgent.runTurn` | calls | `toolRegistry.getToolSchemas` | tool metadata |
| `CodingAgent.runTurn` | calls | `toolRegistry.execute` | tool execution |
| `CodingAgent.runTurn` | references | `ToolCall`, `ModelResponse` (implicit via response) | |
| `stableSerialize` | (no external deps) | | |
| `signatureForToolCall` | references | `ToolCall` | param type |

### 3.3 Config: `src/agent/config.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `loadAgentConfig` | calls | `loadConfigFile` | file loading |
| `loadAgentConfig` | calls | `parseNumber`, `parseBoolean`, `parseModelProvider`, `parseUserDenylist` | helpers |
| `loadAgentConfig` | references | `AgentConfig`, `AgentConfigFile` | return/param types |
| `loadConfigFile` | calls | `access`, `readFile` | fs |
| `parseUserDenylist` | (no external symbol deps) | | |
| `parseModelProvider` | (no external symbol deps) | | |

### 3.4 Model Client: `src/model/client.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `createModelClient` | references | `AgentConfig` | param type |
| `createModelClient` | calls | `OpenAICompatibleModelClient` (constructor) | when openai-compatible |
| `createModelClient` | calls | `AnthropicModelClient` (constructor) | when anthropic |
| `AnthropicModelClient` | implements | `ModelClient` | interface |
| `AnthropicModelClient.chat` | calls | `toAnthropicMessages` | message conversion |
| `AnthropicModelClient.chat` | calls | `parseResponse` | response parsing |
| `AnthropicModelClient.chat` | calls | `withRetry` | retry wrapper |
| `AnthropicModelClient.chat` | references | `SessionMessage`, `ToolSchema`, `ModelResponse` | |
| `OpenAICompatibleModelClient` | implements | `ModelClient` | interface |
| `OpenAICompatibleModelClient.chat` | calls | `toOpenAICompatibleMessages` | |
| `OpenAICompatibleModelClient.chat` | calls | `toOpenAICompatibleTools` | |
| `OpenAICompatibleModelClient.chat` | calls | `parseOpenAICompatibleResponse` | |
| `OpenAICompatibleModelClient.chat` | calls | `withRetry` | |
| `parseResponse` | references | `ModelResponse`, `ToolCall` | return/construction |
| `parseResponse` | references | `Anthropic.Messages.Message` (external) | |
| `parseOpenAICompatibleResponse` | references | `ModelResponse`, `ToolCall` | |
| `toAnthropicMessages` | references | `SessionMessage`, `ToolCall` | |
| `toOpenAICompatibleMessages` | references | `SessionMessage`, `ToolCall` | |
| `toOpenAICompatibleTools` | references | `ToolSchema` | |

### 3.5 Session: `src/session/session.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `Session` | (no external symbol deps) | | |
| `estimateMessageTokens` | references | `SessionMessage` | |
| `Session.addMessage` | references | `SessionMessage` | |
| `Session.trim` | (internal only) | | |

### 3.6 Prompt: `src/prompt/system-prompt.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `buildSystemPrompt` | calls | `detectProjectType` | |
| `buildSystemPrompt` | calls | `renderToolList` | |
| `buildSystemPrompt` | references | `AgentConfig`, `ToolSchema` | |
| `detectProjectType` | (no external symbol deps) | | |
| `renderToolList` | references | `ToolSchema` | |

### 3.7 Tools: `src/tools/registry.ts`

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `ToolRegistry.createDefault` | calls | `createReadFileTool`, `createWriteFileTool`, etc. | all 6 tool factories |
| `ToolRegistry.createDefault` | references | `AgentConfig` | |
| `ToolRegistry.execute` | calls | `tool.execute` (dynamic) | |

### 3.8 Tools (individual): `src/tools/read-file.ts` (example)

| Symbol | Edge Kind | Target | Notes |
|--------|-----------|--------|-------|
| `createReadFileTool` | references | `AgentConfig`, `ToolDefinition` | |
| `createReadFileTool` (execute) | calls | `resolveWorkspacePath`, `validateFileReadSize` | |
| `createReadFileTool` (execute) | calls | `expectNonEmptyString`, `expectOptionalNumber`, `formatWithLineNumbers` | |

---

## 4. Expected Tool Outputs (Test Oracles)

### 4.1 `get_dependencies("createModelClient")` (depth 1)

**Expected to include:**
- `AgentConfig` (references — param type)
- `OpenAICompatibleModelClient` (calls — constructor)
- `AnthropicModelClient` (calls — constructor)

**Format:** A list of symbols with their signatures. The model needs to know what `createModelClient` depends on to understand its behavior.

### 4.2 `get_dependencies("parseResponse")` (depth 1)

**Expected to include:**
- `ModelResponse` (references — return type, constructed in body)
- `ToolCall` (references — used in toolCalls array)
- `Anthropic.Messages.Message` (references — param type; may be external, could be excluded or noted)

### 4.3 `get_dependencies("CodingAgent.runTurn")` (depth 1)

**Expected to include:**
- `buildSystemPrompt` (calls)
- `ensureStepWithinLimit` (calls)
- `session.trim` (calls — method on Session)
- `modelClient.chat` (calls — method on ModelClient)
- `toolRegistry.getToolSchemas` (calls)
- `toolRegistry.execute` (calls)
- `ToolCall` (references — used in loop)
- `AgentConfig` (references — this.config fields)

### 4.4 `find_references("ModelResponse")`

**Expected to return (symbols that reference ModelResponse):**
- `parseResponse` (returns it)
- `parseOpenAICompatibleResponse` (returns it)
- `AnthropicModelClient.chat` (uses return type)
- `OpenAICompatibleModelClient.chat` (uses return type)
- `CodingAgent.runTurn` (uses response.toolCalls, response.text — indirect)

### 4.5 `find_references("ToolCall")`

**Expected to return:**
- `parseResponse` (constructs ToolCall objects)
- `parseOpenAICompatibleResponse` (constructs ToolCall objects)
- `toAnthropicMessages` (iterates message.toolCalls)
- `toOpenAICompatibleMessages` (iterates message.toolCalls)
- `signatureForToolCall` (param type)
- `CodingAgent.runTurn` (iterates response.toolCalls)

### 4.6 `find_references("AgentConfig")`

**Expected to return:**
- `loadAgentConfig` (returns it)
- `createModelClient` (param type)
- `CodingAgent` (constructor param, runTurn uses this.config)
- `ToolRegistry.createDefault` (param type)
- `createReadFileTool`, `createWriteFileTool`, etc. (param type)
- `buildSystemPrompt` (param type)
- `detectProjectType` (indirect via config.workspaceRoot)

---

## 5. Dependency Cone Examples (for `read_symbol` enhancement)

When the model requests `read_symbol("parseResponse")`, the enhanced output should append:

```
## Referenced Types

interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
```

When the model requests `read_symbol("createModelClient")`, append:

```
## Referenced Types

interface AgentConfig { ... }  // full signature

interface ModelClient {
  chat(params: {...}): Promise<ModelResponse>;
}
```

---

## 6. Extraction Strategy Notes (for Phase 3 Implementation)

### 6.1 Import Edges

- Walk `ImportDeclaration` and `ImportEqualsDeclaration` nodes
- For `import { X } from "./module"` → edge from current file's exported symbols that *use* X to the imported symbol X
- For type-only imports (`import type`), create `references` edges, not `imports` (or treat as `imports` for module-level; implementation choice)
- Resolve the imported module path via `ts.resolveModuleName` or the program's module resolution

### 6.2 Call Edges

- Walk `CallExpression` and `NewExpression` nodes within each symbol's body
- Use `typeChecker.getSymbolAtLocation(expression)` to resolve the callee
- If resolved symbol is in our index → create `calls` edge
- Handle method calls: `modelClient.chat` resolves to `ModelClient.chat` (interface method) or the implementing class's method

### 6.3 Reference Edges (Types)

- For parameters, return types, variable declarations: use `typeChecker.getTypeAtLocation(node)`
- Extract referenced type symbols via `type.getSymbol()` or walking the type structure
- Create `references` edge when the type is an interface, type alias, or class in our index

### 6.4 Extends / Implements

- `HeritageClause` on `ClassDeclaration`: `extends BaseClass` → `extends` edge, `implements I1, I2` → `implements` edges
- Resolve via `typeChecker.getSymbolAtLocation(heritageClause.expression)`

### 6.5 Qualified Names

For edge `from` and `to`, use `qualifiedName`:
- Top-level function: `"parseResponse"`
- Method: `"CodingAgent.runTurn"`
- Class: `"AnthropicModelClient"`
- Interface: `"ModelResponse"`

This ensures `find_references` and `get_dependencies` can look up symbols consistently.

---

## 7. Edge Count Summary (Approximate)

| File | Import Edges | Call Edges | Reference Edges | Implements |
|------|--------------|------------|-----------------|------------|
| index.ts | 4 | ~8 | 2 | 0 |
| agent.ts | 4 | ~10 | 4 | 0 |
| config.ts | 2 | ~6 | 2 | 0 |
| client.ts | 6 | ~15 | 8 | 2 |
| session.ts | 1 | 0 | 2 | 0 |
| system-prompt.ts | 2 | 2 | 2 | 0 |
| registry.ts | 6 | 6 | 1 | 0 |
| tools/* | varies | varies | varies | 0 |

**Total:** Roughly 50–80 edges for the full mini-coder `src/` tree. The Phase 3 implementation should produce a graph of this scale when run on the project.
