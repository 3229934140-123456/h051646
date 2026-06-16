export interface QueryRecord {
  sql: string;
  timestamp: number;
  stack?: string;
}

export interface NPlusOneWarning {
  pattern: string;
  count: number;
  sampleSql: string;
  timeRange: { start: number; end: number };
  suggestion: string;
}

export class NPlusOneDetector {
  private records: QueryRecord[] = [];
  private patterns: Map<string, QueryRecord[]> = new Map();
  private threshold: number;
  private timeWindowMs: number;
  private enabled: boolean = false;
  private warnings: NPlusOneWarning[] = [];
  private captureStack: boolean;

  constructor(threshold: number = 3, timeWindowMs: number = 1000, captureStack: boolean = false) {
    this.threshold = threshold;
    this.timeWindowMs = timeWindowMs;
    this.captureStack = captureStack;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordQuery(sql: string): void {
    if (!this.enabled) return;

    const now = Date.now();
    const record: QueryRecord = {
      sql,
      timestamp: now,
      stack: this.captureStack ? new Error().stack : undefined,
    };

    this.records.push(record);
    const pattern = this.normalizePattern(sql);

    if (!this.patterns.has(pattern)) {
      this.patterns.set(pattern, []);
    }
    const patternRecords = this.patterns.get(pattern)!;
    patternRecords.push(record);

    const windowStart = now - this.timeWindowMs;
    const recent = patternRecords.filter((r) => r.timestamp >= windowStart);
    this.patterns.set(pattern, recent);

    if (recent.length >= this.threshold) {
      const warning: NPlusOneWarning = {
        pattern,
        count: recent.length,
        sampleSql: sql,
        timeRange: {
          start: recent[0].timestamp,
          end: recent[recent.length - 1].timestamp,
        },
        suggestion: this.generateSuggestion(sql, pattern),
      };
      this.warnings.push(warning);
      console.warn(
        `[N+1 Detector] Possible N+1 problem detected:\n` +
        `  Pattern executed ${warning.count} times within ${this.timeWindowMs}ms\n` +
        `  Pattern: ${pattern.substring(0, 150)}\n` +
        `  Suggestion: ${warning.suggestion}`
      );
    }
  }

  getWarnings(): NPlusOneWarning[] {
    return [...this.warnings];
  }

  clear(): void {
    this.records = [];
    this.patterns.clear();
    this.warnings = [];
  }

  getStatistics(): {
    totalQueries: number;
    uniquePatterns: number;
    warnings: number;
  } {
    return {
      totalQueries: this.records.length,
      uniquePatterns: this.patterns.size,
      warnings: this.warnings.length,
    };
  }

  private normalizePattern(sql: string): string {
    return sql
      .replace(/\$\d+/g, '?')
      .replace(/\b\d+\b/g, '?')
      .replace(/'[^']*'/g, "'?'")
      .replace(/"[^"]*"/g, '"?"')
      .replace(/IN\s*\([^)]+\)/gi, 'IN (?)')
      .replace(/BETWEEN\s+\S+\s+AND\s+\S+/gi, 'BETWEEN ? AND ?')
      .replace(/VALUES\s*\([^)]+\)/gi, 'VALUES (?)')
      .replace(/LIMIT\s+\S+/gi, 'LIMIT ?')
      .replace(/OFFSET\s+\S+/gi, 'OFFSET ?')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private generateSuggestion(sql: string, pattern: string): string {
    const upper = sql.toUpperCase();

    if (upper.includes('SELECT') && pattern.includes('WHERE') && pattern.includes('= ?')) {
      return 'Consider using eager loading (JOIN) or batch IN query instead of loading in a loop';
    }
    if (upper.includes('INSERT')) {
      return 'Consider using batch INSERT instead of multiple single INSERT statements';
    }
    if (upper.includes('UPDATE')) {
      return 'Consider using batch UPDATE or a single UPDATE with IN clause';
    }
    return 'Review query pattern and consider batching or using joins';
  }
}

export const nPlusOneDetector = new NPlusOneDetector(3, 2000, true);
