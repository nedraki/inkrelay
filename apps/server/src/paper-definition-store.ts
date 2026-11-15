import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { NEO_PAPER_REFERENCES, parseNeoPaperDefinition } from "@inkrelay/adapters";
import type { PaperDefinition } from "@inkrelay/core";

const transform = z.object({ scaleX: z.number().finite().positive().max(100), scaleY: z.number().finite().positive().max(100),
  offsetX: z.number().finite().min(-1_000_000).max(1_000_000), offsetY: z.number().finite().min(-1_000_000).max(1_000_000) }).strict();
const definition = z.object({ notebookId: z.string().min(1).max(160), displayName: z.string().min(1).max(160),
  provenance: z.object({ kind: z.literal("nproj"), reference: z.string().max(500), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  pages: z.array(z.object({ firstPage: z.number().int().nonnegative(), lastPage: z.number().int().nonnegative(),
    widthMm: z.number().positive().max(2000), heightMm: z.number().positive().max(2000), transform }).strict()).min(1).max(10_000)
}).strict().superRefine((value, context) => {
  const pages = [...value.pages].sort((a, b) => a.firstPage - b.firstPage);
  for (let i = 0; i < pages.length; i++) if (pages[i]!.firstPage > pages[i]!.lastPage || (i > 0 && pages[i - 1]!.lastPage >= pages[i]!.firstPage)) {
    context.addIssue({ code: "custom", message: "Paper page ranges must be ordered and non-overlapping" });
  }
});
const catalog = z.object({ schemaVersion: z.literal("inkrelay.paper_definitions.v1"), imports: z.array(definition) }).strict();

/** Local immutable import history; latest import for an identity takes priority. */
export class PaperDefinitionStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly enabled = true) {}

  async load(): Promise<readonly PaperDefinition[]> {
    if (!this.enabled) return [];
    const saved = await this.read();
    const definitions = new Map(NEO_PAPER_REFERENCES.map((item) => [item.notebookId, item]));
    for (const item of saved.imports) definitions.set(item.notebookId, item);
    return [...definitions.values()];
  }

  import(xml: string): Promise<readonly PaperDefinition[]> {
    const task = this.tail.then(async () => {
      if (!this.enabled) throw new Error("Automatic paper mapping is disabled");
      const item = definition.parse(parseNeoPaperDefinition(xml));
      const saved = await this.read();
      const current = saved.imports.filter((entry) => entry.notebookId === item.notebookId).at(-1);
      if (current?.provenance.digest !== item.provenance.digest) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ ...saved, imports: [...saved.imports, item] }, null, 2) + "\n", "utf8");
        await rename(temporary, this.path);
      }
      return this.load();
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async read(): Promise<z.infer<typeof catalog>> {
    try { return catalog.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schemaVersion: "inkrelay.paper_definitions.v1", imports: [] };
      throw error;
    }
  }
}
