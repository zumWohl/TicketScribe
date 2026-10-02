import type { GenerateRequest } from '../../shared/generate';

// Implemented by ollama.ts/azure.ts/echo.ts so providers/index.ts can
// dispatch via a lookup table instead of an if/else chain -- adding a
// provider means implementing this and registering it in index.ts's
// PROVIDERS map, not editing dispatch logic.
export interface SummaryProvider {
  generate(request: GenerateRequest): Promise<string>;
}
