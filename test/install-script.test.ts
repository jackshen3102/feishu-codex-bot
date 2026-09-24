import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production installer update boundary", () => {
  it("stages artifacts, refuses live replacement, and carries rollback paths", async () => {
    const script = await fs.readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
    expect(script).toContain("systemctl is-active --quiet");
    expect(script).toContain(".staging.XXXXXX");
    expect(script).toContain("rollback_required=1");
    expect(script).toContain("backup_container}/previous");
    expect(script).toContain('chmod 0555 "${staging_root}"');
    expect(script).not.toContain('find "${INSTALL_ROOT}" -mindepth 1');
  });
});
