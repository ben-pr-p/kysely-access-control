# kysely-acl

`kysely-acl` is a TypeScript library that provides an additional permission layer for the [Kysely](https://github.com/koskimas/kysely) query builder. 

It allows developers to define access control layers using guards, ensuring that SQL queries are only executed when certain conditions are met. 

It can also implement security similar to Postgres Row-Level Security (RLS).

# Quick Usage

```typescript
import { createAclPlugin, KyselyAclGuard, Allow, Deny, Update, Delete, ColumnInUpdateSet } from 'kysely-acl';
import { Database } from './my-kysely-types.ts'

// Define your guard
const guard: KyselyAclGuard<Database> = {
	table: (table, statementType, usageContext) => {
		// table.name is restricted to keyof Database
		if (table.name === 'events' && statementType ===  Delete) {
			return Deny;
		}

		return Allow;
	},
	column: (table, column, statementType, usageContext) => {
		// Control if the column can be inserted, updated independently
		if (table.name === 'events' && column.name === 'is_deleted' && statementType === Update && usageContext === ColumnInUpdateSet) {
			return Deny;
		}

		return Allow;
	}
}

// When executing a query...
const events = await db
	.withPlugin(createAclPlugin(guard))
	.updateTable('events)
	.set({ is_deleted: false })
	.execute();
// throws 'UPDATE denied on events.is_deleted'
```

`kysely-acl` is a relatively low level library.  For a higher level system that implements functionality similar to Postgres, check out `kysely-acl-grants`.

# Motivation (Why Implement Permissions at the Query Builder Layer?)

Implementing permissions at the query builder layer makes more sense than in *each query*:
1. **DRY-er**: Common use cases like filtering a table or omitting a column are just specified once, instead of in every query in your application.
2. **Separation of concerns**: Maintain a part of your application responsible for generating different guards for different users and ensure that your core application logic is not polluted with permission checks, and doesn't need to change when permissions or new roles are created.
3. **Harder to forget**: No more odd bugs where you forget to add a check for `.is_deleted` or `.tenant_id = ?`

Even though PostgreSQL has a fully featured permission system, implementing permissions at the query builder layer
can makes more sense than in *the database* itself:
1. **Dynamically generate context specific permissions**: Postgres permissions are static, and so you can't, for example, generate permissions based on the current context / user role / action matrix. Although you can use a role per user approach, that role controls those users permissions in any context.
3. **No security definer escape**: When using database level permissions, it's common to use security definer functions as an escape hatch. When you do, you're back to manually re-implementing parts of the permissions you want to keep.
3. **More control**: Postgres, for example, has no deny rules, and so it can be easy to accidentally grant permissions that leak when additive roles combine.

# Limitations

## No Enforcement of Raw SQL

`kysely-acl` works by operating on the internal `OperationNode`s used in Kysely's query builder. As a result, anything [specified in raw SQL](https://kysely-org.github.io/kysely-apidoc/interfaces/Sql.html) can't be enforced.

There are definitely legitimate uses that require raw SQL, but try to use it only when necessary in order to maintain most of
the benefits of `kysely-acl`. 

For example,
```typescript
db.selectFrom('person')
	.select(({ fn, val, ref }) => [ fn<string>('concat', [ref('first_name'), val(' '), ref('last_name')]) ])
```

Enforces column permissions, whereas:
```typescript
db.selectFrom('person')
	.select(sql<string>`concat(first_name, ' ', last_name)`)
```

enforces only table permissions, and:
```typescript
sql`select concat(first_name, ' ', last_name) from person`
```

enforces nothing.

## No RLS on Insert (or Check for Update out of RLS)

`kysely-acl`'s RLS works by adding user supplied expression's as where clauses in the right places. As a result, it is only capable of implementing
the `USING` part of traditional RLS, and not the `WITH CHECK` part.

As a result, we can't check that a new row version (whether inserted or updated) matches the conditions specified.

## Types May Be Incorrect

If you use `kysely-acl` to restrict access to a column, the query return types may still portray 
that column as being present (and potentially even not null), even though it will be undefined in the actual result.

## Joins May Fail Where You Don't Expect

Even if a foreign key is not null, if you join to a table with a `where` guard on it, the join may fail
because the context does not permit the user to see the joined row.

This is true for Postgres RLS as well.

# Features

## Table/Column Statement Type + Context Controls

`kysely-acl` allows you to control access to tables and columns based on the statement type and context.  
For example, you can allow a user to select from a table, but not update it, or allow a user to update a table, but not set a particular column.

For full controls, see the types of the guard:
```typescript
type FullKyselyAclGuard<KyselyDatabase> = {
  table: (
    table: TableNodeTableWithKeyOf<KyselyDatabase>,
    statementType: StatementType,
    tableUsageContext: TableUsageContext
  ) => TableGuardResult<KyselyDatabase>;

  column: (
    table: TableNodeTableWithKeyOf<KyselyDatabase>,
    column: ColumnNode["column"],
    statementType: StatementType,
    columnUsageContext: ColumnUsageContext
  ) => ColumnGuardResult;
};

export enum StatementType {
  Select = "select",
  Insert = "insert",
  Update = "update",
  Delete = "delete",
}

export enum ColumnUsageContext {
  ColumnInSelectOrReturning = "column-in-select-or-returning",
  ColumnInWhereOrJoin = "column-in-where-or-join",
  ColumnInUpdateSet = "column-in-update-set",
  ColumnInInsert = "column-in-insert",
}

export enum TableUsageContext {
  TableTopLevel = "table-top-level",
  TableInJoin = "table-in-join",
}
```

## RLS in Select/Update/Delete 

## Column Omission vs Erroring

Applied to returning clauses as well.

## 

# Contributing

The most helpful form of contribution right now would be additional tests on complex queries in your
actual applications.

Currently, `kysely-acl` has not been tested to properly enforce permissions with every type of SQL query
Kysely itself can generate.

However, it has been programmed to throw errors if it encounters a query type that is not yet implemented,
and it should generate these errors even if you don't enforce any particularly complex permission on them.

For any of these failures, it is possible to make `kysely-acl` work, it just requires a few more `if`s, so
please open an issue.

