import { EntityClass } from '../mapping';

export type EntityState = 'new' | 'managed' | 'modified' | 'removed' | 'detached';

export interface EntityEntry<T = any> {
  entity: T;
  entityClass: EntityClass<T>;
  state: EntityState;
  originalValues: Record<string, any> | null;
  currentValues: Record<string, any>;
}

export interface CommitResult {
  inserted: number;
  updated: number;
  deleted: number;
  generatedIds: Map<EntityClass, Map<string, any>>;
  executedQueries: Array<{ sql: string; params: any[] }>;
}

export interface SqlStatement {
  sql: string;
  params: any[];
  entityClass: EntityClass;
  entity?: any;
  operation: 'insert' | 'update' | 'delete';
  priority: number;
}
