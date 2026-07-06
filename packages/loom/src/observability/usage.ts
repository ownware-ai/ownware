/**
 * @ownware/loom - Token usage tracking with cost estimation.
 * Zero external dependencies.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

function getPricing(model: string): ModelPricing {
  const m = model.toLowerCase();

  // gpt-4o-mini must be checked before gpt-4o
  if (m.includes('gpt-4o-mini')) {
    return { inputPerMillion: 0.15, outputPerMillion: 0.60 };
  }
  if (m.includes('gpt-4o')) {
    return { inputPerMillion: 2.50, outputPerMillion: 10.0 };
  }
  if (m.includes('haiku')) {
    return { inputPerMillion: 0.25, outputPerMillion: 1.25 };
  }
  if (m.includes('opus')) {
    return { inputPerMillion: 15.0, outputPerMillion: 75.0 };
  }
  if (m.includes('sonnet')) {
    return { inputPerMillion: 3.0, outputPerMillion: 15.0 };
  }

  // Default pricing
  return { inputPerMillion: 3.0, outputPerMillion: 15.0 };
}

export class UsageTracker {
  private records: UsageRecord[] = [];

  track(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): void {
    const cost = this.estimateCost(model, inputTokens, outputTokens);
    this.records.push({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      estimatedCostUsd: cost,
    });
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = getPricing(model);
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
    return inputCost + outputCost;
  }

  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
  }

  getUsageReport(): string {
    const totals = this.records.reduce(
      (acc, r) => {
        acc.input += r.inputTokens;
        acc.output += r.outputTokens;
        acc.cacheRead += r.cacheReadTokens;
        acc.cacheCreation += r.cacheCreationTokens;
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    );

    const cost = this.getTotalCost();
    const lines = [
      `Usage Report (${this.records.length} API calls)`,
      `  Input tokens:          ${totals.input.toLocaleString()}`,
      `  Output tokens:         ${totals.output.toLocaleString()}`,
      `  Cache read tokens:     ${totals.cacheRead.toLocaleString()}`,
      `  Cache creation tokens: ${totals.cacheCreation.toLocaleString()}`,
      `  Estimated cost:        $${cost.toFixed(4)}`,
    ];
    return lines.join('\n');
  }

  reset(): void {
    this.records = [];
  }
}
