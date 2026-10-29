import { CommandId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { delegatedTaskCommandId, derive } from "./IdAllocator.ts";

it.each(["command:mcp:workflow%3Arun:delegate-task:wf-key", "command:with/%:unicode-🌙"])(
  "recovers the command of a canonical delegated task: %s",
  (value) => {
    const commandId = CommandId.make(value);
    expect(delegatedTaskCommandId(derive.delegatedTaskNode({ commandId }))).toBe(commandId);
    expect(delegatedTaskCommandId(derive.delegatedTaskThread({ commandId }))).toBeUndefined();
  },
);

it.each([
  "",
  "node:delegated-task:%",
  "node:delegated-task:command:raw",
  "node:delegated-task:%63ommand",
])("rejects malformed or noncanonical delegated task identity: %s", (taskId) =>
  expect(delegatedTaskCommandId(taskId)).toBeUndefined(),
);
