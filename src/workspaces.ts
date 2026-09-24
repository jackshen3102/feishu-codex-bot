import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "./db/store.js";
import type { DownloadedImage } from "./feishu/messages.js";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export class WorkspaceManager {
  constructor(
    private readonly root: string,
    private readonly template: string,
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const [templateStat, agentsStat] = await Promise.all([
      fs.lstat(this.template),
      fs.lstat(path.join(this.template, "AGENTS.md")),
    ]);
    if (!templateStat.isDirectory() || templateStat.isSymbolicLink() || !agentsStat.isFile() || agentsStat.isSymbolicLink()) {
      throw new Error("workspace template must be a real directory containing AGENTS.md");
    }
  }

  async ensure(workspacePath: string): Promise<void> {
    const resolved = path.resolve(workspacePath);
    if (!isInside(path.resolve(this.root), resolved)) throw new Error("workspace path escaped workspace root");
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workspace path must be a real directory");
    const [rootReal, workspaceReal] = await Promise.all([fs.realpath(this.root), fs.realpath(resolved)]);
    if (!isInside(rootReal, workspaceReal)) throw new Error("workspace real path escaped workspace root");
    await fs.cp(this.template, workspaceReal, { recursive: true, force: true, errorOnExist: false });
  }

  async writeInputImage(workspacePath: string, messageId: string, image: DownloadedImage): Promise<string> {
    await this.ensure(workspacePath);
    const workspaceReal = await fs.realpath(workspacePath);
    const imageDirectory = path.join(workspaceReal, "input-images");
    await fs.mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(imageDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("input image directory must be a real directory");
    }
    const directoryReal = await fs.realpath(imageDirectory);
    if (!isInside(workspaceReal, directoryReal)) throw new Error("input image directory escaped workspace");

    const digest = createHash("sha256").update(messageId, "utf8").digest("hex").slice(0, 24);
    const relativePath = path.posix.join("input-images", `${digest}.${image.extension}`);
    await fs.writeFile(path.join(directoryReal, `${digest}.${image.extension}`), image.data, {
      flag: "wx",
      mode: 0o600,
    });
    return relativePath;
  }

  async removeInputImages(workspacePath: string, messageIds: readonly string[]): Promise<void> {
    const resolved = path.resolve(workspacePath);
    if (!isInside(path.resolve(this.root), resolved)) throw new Error("workspace path escaped workspace root");
    let workspaceReal: string;
    try {
      const stat = await fs.lstat(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      workspaceReal = await fs.realpath(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const rootReal = await fs.realpath(this.root);
    if (!isInside(rootReal, workspaceReal)) throw new Error("workspace real path escaped workspace root");
    const imageDirectory = path.join(workspaceReal, "input-images");
    try {
      const directoryStat = await fs.lstat(imageDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const directoryReal = await fs.realpath(imageDirectory);
    if (!isInside(workspaceReal, directoryReal)) throw new Error("input image directory escaped workspace");
    for (const messageId of messageIds) {
      const digest = createHash("sha256").update(messageId, "utf8").digest("hex").slice(0, 24);
      for (const extension of ["png", "jpg", "gif", "webp"]) {
        await fs.rm(path.join(directoryReal, `${digest}.${extension}`), { force: true });
      }
    }
  }

  async cleanup(store: Store, retentionDays: number, referenceTime = Date.now()): Promise<string[]> {
    const before = new Date(referenceTime - retentionDays * 86_400_000).toISOString();
    const removed: string[] = [];
    for (const topic of store.staleTopics(before)) {
      const resolved = path.resolve(topic.workspacePath);
      if (!isInside(path.resolve(this.root), resolved)) continue;
      try {
        const stat = await fs.lstat(resolved);
        if (stat.isSymbolicLink()) continue;
        await fs.rm(resolved, { recursive: true, force: true });
        removed.push(topic.id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }
}
