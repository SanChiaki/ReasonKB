import Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

export function runImmediateTransaction<T>(db: Db, operation: () => T): T {
  const transaction = db.transaction(operation) as (() => T) & { immediate(): T };
  return transaction.immediate();
}
