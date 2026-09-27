import type { Knex } from "knex";

export interface BunSqlite3ConnectionOptions {
  /** Открыть базу только на чтение. Внимание: `false` в bun:sqlite ломает open, поэтому omit. */
  readonly?: true;
  /** Возвращать INTEGER как bigint. */
  safeIntegers?: boolean;
}

export interface BunSqlite3Connection {
  filename?: string;
  options?: BunSqlite3ConnectionOptions;
}

export type BunKnexConfig = Omit<Knex.Config, "client"> & {
  connection: BunSqlite3Connection | string;
};

export declare class Client_BunSQLite3 {
  constructor(config: BunKnexConfig);
}

export declare function bunKnex(config: BunKnexConfig): Knex;

/** Загружает нативное расширение (sqlite-vec и т.п.) в соединение knex. */
export declare function loadExtension(db: Knex, path: string): Promise<Knex>;

export default Client_BunSQLite3;
