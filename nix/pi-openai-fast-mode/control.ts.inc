
    let controlContext: ExtensionContext | undefined;
    const controlKey = "__piFastModeControlV1";
    const control = {
      version: 1,
      status(sessionId: string) {
        if (!controlContext || controlContext.sessionManager.getSessionId() !== sessionId || !configPath) throw new Error("Fast mode context unavailable");
        return { sessionId, enabled: config.enabled, available: getFastModePayload({ ...config, enabled: true }, toModelRef(controlContext.model), {}) !== undefined };
      },
      async setEnabled(sessionId: string, enabled: boolean) {
        if (typeof enabled !== "boolean" || !this.status(sessionId).available) throw new Error("Fast mode unavailable for this model");
        const ctx = controlContext!;
        const previous = config.enabled;
        config.enabled = enabled;
        try { await saveCurrent(ctx); } catch (error) { config.enabled = previous; throw error; }
        if (controlContext !== ctx || ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Fast mode context changed");
        updateFastStatus(ctx, config, toModelRef(ctx.model));
        return this.status(sessionId);
      },
    };
    pi.on("session_start", (_event, ctx) => { controlContext = ctx; (globalThis as any)[controlKey] = control; });
    pi.on("session_shutdown", () => { controlContext = undefined; if ((globalThis as any)[controlKey] === control) delete (globalThis as any)[controlKey]; });
