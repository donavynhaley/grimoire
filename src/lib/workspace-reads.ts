/** Only the latest read of a workspace surface may commit within the current visit. */
export class WorkspaceReads {
  private generation = 0;
  private pending = new Map<string, AbortController>();

  reset(): void {
    this.generation += 1;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }

  async run<T>(
    surface: string,
    load: (signal: AbortSignal) => Promise<T>,
    commit: (value: T) => void,
  ): Promise<void> {
    const generation = this.generation;
    this.pending.get(surface)?.abort();
    const controller = new AbortController();
    this.pending.set(surface, controller);
    const current = () => !controller.signal.aborted && generation === this.generation;
    try {
      const value = await load(controller.signal);
      if (current()) commit(value);
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (this.pending.get(surface) === controller) this.pending.delete(surface);
    }
  }
}
