import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { removeTemp, tempConfig } from "./helpers.js";

describe("image input recovery", () => {
  it("refuses to write through an input-images symlink", async () => {
    const { config, root } = await tempConfig();
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    const workspacePath = path.join(config.WORKSPACE_ROOT, "topic");
    const outside = path.join(root, "outside");
    try {
      await workspaces.initialize();
      await workspaces.ensure(workspacePath);
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(workspacePath, "input-images"));
      await expect(
        workspaces.writeInputImage(workspacePath, "message", {
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          extension: "png",
          mediaType: "image/png",
        }),
      ).rejects.toThrow(/real directory/);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await removeTemp(root);
    }
  });

  it("fails an image job interrupted before its workspace input was ready without running the agent", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const accepted = store.acceptMessage({
      messageId: "unprepared-image",
      chatId: config.FEISHU_PRIVATE_CHAT_ID,
      requesterOpenId: "user-1",
      allowNewTopic: true,
      existingTopicInput: null,
      newTopicInput: null,
    });
    try {
      const relativePath = await workspaces.writeInputImage(accepted.topic!.workspacePath, "unprepared-image", {
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        extension: "png",
        mediaType: "image/png",
      });
      const recovered = store.recoverUncertainExecutions();
      await workspaces.removeInputImages(accepted.topic!.workspacePath, ["unprepared-image"]);
      expect(recovered).toHaveLength(1);
      expect(store.getJob(accepted.job!.id)).toMatchObject({
        executionStatus: "interrupted",
        errorKind: "input_preparation_interrupted",
        inputText: null,
        resultText: "任务输入接收中断，请重新发送原请求。",
      });
      await expect(fs.stat(path.join(accepted.topic!.workspacePath, relativePath))).rejects.toThrow();
      expect(store.listDeliveries(accepted.job!.id).map((delivery) => delivery.kind).sort()).toEqual([
        "final_reply",
        "reaction",
        "status",
      ]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});
